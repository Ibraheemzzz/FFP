// tests/idempotency.test.ts
// اختبارات معرّف الطلب وعدم التكرار والتعارض (Part 22: Idempotency Key & Deduplication)

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type pg from 'pg';
import { initEnvironment, loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrator.js';
import {
  executeConsumption,
  RequestIdConflictError,
  type DecisionContext,
} from '../src/consumptions.js';
import { createCustomPlan, updateCustomPlan } from '../src/plans.js';

/**
 * دالة مساعدة لإنشاء مجمع اتصالات يعترض استعلامات SQL معينة لافتعال فشل قبل COMMIT
 */
function createQueryInterceptedPool(
  basePool: pg.Pool,
  shouldIntercept: (sql: string, params?: unknown[]) => boolean,
  errorToThrow: Error
): pg.Pool {
  return new Proxy(basePool, {
    get(target, prop, receiver) {
      if (prop === 'connect') {
        return async () => {
          const client = await target.connect();
          const originalQuery = client.query.bind(client);
          const originalRelease = client.release.bind(client);

          // استعادة الدوال الأصلية دائماً قبل إعادة الاتصال للمجمع
          client.release = (destroy?: boolean) => {
            client.query = originalQuery;
            client.release = originalRelease;
            return originalRelease(destroy);
          };

          (client as any).query = async (...args: any[]) => {
            const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? '';
            const params = Array.isArray(args[1]) ? args[1] : undefined;

            if (shouldIntercept(sql, params)) {
              throw errorToThrow;
            }

            return (originalQuery as any)(...args);
          };

          return client;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function runIdempotencyTests(): Promise<void> {
  console.log('--- Starting Idempotency and Deduplication Tests (Part 22) ---');

  initEnvironment();
  const config = loadConfig();

  const pool = createPool(config.DATABASE_URL, {
    max: 20,
    connectionTimeoutMillis: 10000,
    statementTimeoutMillis: 15000,
    queryTimeoutMillis: 20000,
  });

  try {
    await runMigrations(pool);

    // =========================================================================
    // 1. اختبار الإعادة المتطابقة لطلب مقبول (Idempotent Replay of Accepted Request)
    // السيناريو: طلب استهلاك بـ 10 وحدات يُقبل. تتم إعادة إرساله بنفس المعطيات.
    // التحقق: تطابق الرد تماماً، وعدم مضاعفة العدادات، وبقاء سجل واحد لم يتغير.
    // =========================================================================
    {
      const accountId = `acc_idem_acc_${crypto.randomBytes(4).toString('hex')}`;
      const userId = `usr_idem_acc_${crypto.randomBytes(4).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');
      const fixedDate = new Date('2026-10-20T10:00:00.000Z');

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'Idem Accepted Account', $2, 'plan_default_account')`,
        [accountId, hash]
      );
      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, 'plan_default_user')`,
        [accountId, userId]
      );

      const requestPayload = {
        userId,
        units: 10,
        requestId: 'req_idem_acc_001',
      };

      // 1. الطلب الأول يُقبل
      const decision1 = await executeConsumption(pool, accountId, requestPayload, {
        clock: () => fixedDate,
      });
      assert.equal(decision1.accepted, true);
      assert.equal(decision1.account.consumed, 10);
      assert.equal(decision1.user.consumed, 10);

      // قراءة السجل الأصلي المحفوظ وتاريخ معالجته
      const originalRecordRes = await pool.query<{
        processed_at: Date;
        response_body: any;
        decision_context: DecisionContext;
      }>(
        `SELECT processed_at, response_body, decision_context
         FROM consumption_records
         WHERE account_id = $1 AND request_id = $2`,
        [accountId, requestPayload.requestId]
      );
      assert.equal(originalRecordRes.rows.length, 1);
      const originalProcessedAt = originalRecordRes.rows[0].processed_at;
      const originalResponseBody = originalRecordRes.rows[0].response_body;
      const originalDecisionContext = originalRecordRes.rows[0].decision_context;

      // 2. إعادة إرسال نفس الطلب بنفس requestId بعد فترة زمنية
      const decision2 = await executeConsumption(pool, accountId, requestPayload, {
        clock: () => new Date('2026-10-20T11:30:00.000Z'),
      });

      // التحقق من تطابق الرد بنسبة 100%
      assert.deepEqual(decision2, decision1, 'Replayed decision must deeply match the original accepted decision');

      // 3. التحقق المباشر من قاعدة البيانات:
      // أ) العدادان لم يتضاعفا (المستهلك = 10 فقط)
      const accUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1 AND year_month = $2',
        [accountId, '2026-10']
      );
      assert.equal(Number(accUsage.rows[0].total_units), 10, 'Account counter must not increment on replay');

      const usrUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM user_monthly_usage WHERE user_id = $1 AND year_month = $2',
        [userId, '2026-10']
      );
      assert.equal(Number(usrUsage.rows[0].total_units), 10, 'User counter must not increment on replay');

      // ب) عدد السجلات في consumption_records ظل واحداً فقط
      const recordCount = await pool.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM consumption_records WHERE account_id = $1 AND request_id = $2',
        [accountId, requestPayload.requestId]
      );
      assert.equal(Number(recordCount.rows[0].count), 1, 'Exactly one record must exist');

      // ج) حقول السجل الأصلي لم تتغير (لا تغيير في processed_at أو decision_context)
      const currentRecordRes = await pool.query<{
        processed_at: Date;
        response_body: any;
        decision_context: DecisionContext;
      }>(
        `SELECT processed_at, response_body, decision_context
         FROM consumption_records
         WHERE account_id = $1 AND request_id = $2`,
        [accountId, requestPayload.requestId]
      );
      assert.equal(
        currentRecordRes.rows[0].processed_at.toISOString(),
        originalProcessedAt.toISOString(),
        'Original processed_at must remain completely invariant'
      );
      assert.deepEqual(currentRecordRes.rows[0].response_body, originalResponseBody);
      assert.deepEqual(currentRecordRes.rows[0].decision_context, originalDecisionContext);

      console.log('✔ Test 1: Idempotent replay of accepted request returned original response with invariant counters and records');
    }

    // =========================================================================
    // 2. اختبار الإعادة المتطابقة لطلب مرفوض (Idempotent Replay of Rejected Request)
    // السيناريو: طلب يرفض بسبب سقف الطلب الواحد (5 وحدات). يُحفظ الرفض.
    // ثم تُرفع الخطة إلى 20 وحدة، ويُعاد نفس الطلب بنفس requestId.
    // التحقق: يظل الطلب مرفوضاً ويعيد نفس قرار الرفض السابق؛ وطلب جديد بمعرّف جديد يُقبل.
    // =========================================================================
    {
      const accountId = `acc_idem_rej_${crypto.randomBytes(4).toString('hex')}`;
      const userId = `usr_idem_rej_${crypto.randomBytes(4).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'Idem Rejected Account', $2, 'plan_default_account')`,
        [accountId, hash]
      );

      // خطة مخصصة بحد لكل طلب = 5 وحدات فقط
      const customPlan = await createCustomPlan(pool, accountId, {
        name: 'Strict Per Request Plan',
        type: 'USER',
        monthlyLimit: 100,
        perRequestLimit: 5,
      });

      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, $3)`,
        [accountId, userId, customPlan.id]
      );

      const rejectedPayload = {
        userId,
        units: 8, // 8 > 5 (يرفض بحكم سقف الطلب الواحد للمستخدم)
        requestId: 'req_idem_rej_001',
      };

      // 1. الطلب يرفض بسبب سقف الطلب الواحد
      const rejection1 = await executeConsumption(pool, accountId, rejectedPayload);
      assert.equal(rejection1.accepted, false);
      assert.equal(rejection1.reason.scope, 'user');
      assert.equal(rejection1.reason.rule, 'max_per_request');

      // 2. رفع سقف الخطة المخصصة إلى 20 وحدة
      await updateCustomPlan(pool, customPlan.id, accountId, {
        perRequestLimit: 20,
      });

      // 3. إعادة إرسال نفس الطلب بنفس requestId القديم
      const rejection2 = await executeConsumption(pool, accountId, rejectedPayload);

      // التحقق من بقاء الطلب مرفوضاً وتطابقه مع الرفض الأصلي
      assert.deepEqual(rejection2, rejection1, 'Replayed rejected request must preserve historical rejection decision');

      // 4. التحقق من قاعدة البيانات: العدادات ما زالت صفراً، وسجل واحد فقط
      const accUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1',
        [accountId]
      );
      assert.equal(accUsage.rows.length, 0, 'No usage counter should be created for rejected request');

      const recCount = await pool.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM consumption_records WHERE account_id = $1 AND request_id = $2',
        [accountId, rejectedPayload.requestId]
      );
      assert.equal(Number(recCount.rows[0].count), 1);

      // 5. طلب جديد بمعرّف جديد (8 وحدات) يُقبل الآن تحت الخطة المحدثة (سقف 20)
      const newDecision = await executeConsumption(pool, accountId, {
        userId,
        units: 8,
        requestId: 'req_idem_rej_fresh_002',
      });
      assert.equal(newDecision.accepted, true, 'Fresh request with new requestId must evaluate under updated plan limits');

      console.log('✔ Test 2: Idempotent replay of rejected request strictly preserved historical rejection despite plan upgrade');
    }

    // =========================================================================
    // 3. اختبار كشف التعارض عند اختلاف بيانات المعرّف (RequestId Conflict Detection)
    // السيناريو: طلب بنفس requestId ولكن مع مستخدم مختلف، أو بمقدار وحدات مختلف.
    // التحقق: إلقاء RequestIdConflictError مع بقاء السجل الأصلي والعدادات دون تغيير.
    // =========================================================================
    {
      const accountId = `acc_idem_conf_${crypto.randomBytes(4).toString('hex')}`;
      const userAId = `usr_idem_conf_a_${crypto.randomBytes(4).toString('hex')}`;
      const userBId = `usr_idem_conf_b_${crypto.randomBytes(4).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'Idem Conflict Account', $2, 'plan_default_account')`,
        [accountId, hash]
      );
      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, 'plan_default_user'), ($1, $3, 'plan_default_user')`,
        [accountId, userAId, userBId]
      );

      const conflictRequestId = 'req_idem_conflict_fixed';

      // تنفيذ طلب أصلي للمستخدم أ بمقدار 5 وحدات
      const originalDec = await executeConsumption(pool, accountId, {
        userId: userAId,
        units: 5,
        requestId: conflictRequestId,
      });
      assert.equal(originalDec.accepted, true);

      // 3.أ: محاولة إعادة استخدام نفس requestId لمستخدم مختلف (User B)
      let diffUserError: unknown = null;
      try {
        await executeConsumption(pool, accountId, {
          userId: userBId,
          units: 5,
          requestId: conflictRequestId,
        });
      } catch (err) {
        diffUserError = err;
      }

      assert.ok(diffUserError instanceof RequestIdConflictError, 'Must throw RequestIdConflictError for different userId');
      assert.equal((diffUserError as Error).message, 'requestId has already been used with different request data');

      // 3.ب: محاولة إعادة استخدام نفس requestId لنفس المستخدم ولكن بمقدار مختلف (10 بدلاً من 5)
      let diffUnitsError: unknown = null;
      try {
        await executeConsumption(pool, accountId, {
          userId: userAId,
          units: 10,
          requestId: conflictRequestId,
        });
      } catch (err) {
        diffUnitsError = err;
      }

      assert.ok(diffUnitsError instanceof RequestIdConflictError, 'Must throw RequestIdConflictError for different units');
      assert.equal((diffUnitsError as Error).message, 'requestId has already been used with different request data');

      // 3.ج: التحقق المباشر من قاعدة البيانات:
      // العداد توقف عند 5 فقط
      const accUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1',
        [accountId]
      );
      assert.equal(Number(accUsage.rows[0].total_units), 5);

      const userBUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM user_monthly_usage WHERE user_id = $1',
        [userBId]
      );
      assert.equal(userBUsage.rows.length, 0, 'User B must have zero usage rows');

      // يوجد سجل واحد فقط في consumption_records للمستخدم أ بـ 5 وحدات
      const records = await pool.query<{ user_id: string; requested_units: string }>(
        'SELECT user_id, requested_units FROM consumption_records WHERE account_id = $1 AND request_id = $2',
        [accountId, conflictRequestId]
      );
      assert.equal(records.rows.length, 1);
      assert.equal(records.rows[0].user_id, userAId);
      assert.equal(Number(records.rows[0].requested_units), 5);

      console.log('✔ Test 3: RequestIdConflictError thrown for modified payload, with zero database corruption');
    }

    // =========================================================================
    // 4. اختبار عزل الحسابات لمعرّف الطلب (Cross-Tenant RequestId Independence)
    // السيناريو: الحساب أ والحساب ب يرسلان طلباً يحمل نفس requestId تماماً.
    // التحقق: قبول الطلبين بنجاح، وامتلاك كل حساب سجله وعداداته المستقلة دون تعارض.
    // =========================================================================
    {
      const accountAId = `acc_idem_iso_a_${crypto.randomBytes(4).toString('hex')}`;
      const accountBId = `acc_idem_iso_b_${crypto.randomBytes(4).toString('hex')}`;
      const userAId = `usr_idem_iso_a_${crypto.randomBytes(4).toString('hex')}`;
      const userBId = `usr_idem_iso_b_${crypto.randomBytes(4).toString('hex')}`;
      const hashA = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');
      const hashB = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'Tenant A', $2, 'plan_default_account')`,
        [accountAId, hashA]
      );
      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'Tenant B', $2, 'plan_default_account')`,
        [accountBId, hashB]
      );

      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, 'plan_default_user')`,
        [accountAId, userAId]
      );
      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, 'plan_default_user')`,
        [accountBId, userBId]
      );

      const sharedRequestId = 'shared_req_across_tenants_123';

      // الحساب أ والحساب ب يرسلان بنفس المعرّف
      const decisionA = await executeConsumption(pool, accountAId, {
        userId: userAId,
        units: 4,
        requestId: sharedRequestId,
      });

      const decisionB = await executeConsumption(pool, accountBId, {
        userId: userBId,
        units: 7,
        requestId: sharedRequestId,
      });

      assert.equal(decisionA.accepted, true);
      assert.equal(decisionB.accepted, true);

      // فحص قاعدة البيانات: كل حساب لديه سجل مستقل بنفس المعرّف
      const recA = await pool.query<{ requested_units: string }>(
        'SELECT requested_units FROM consumption_records WHERE account_id = $1 AND request_id = $2',
        [accountAId, sharedRequestId]
      );
      assert.equal(Number(recA.rows[0].requested_units), 4);

      const recB = await pool.query<{ requested_units: string }>(
        'SELECT requested_units FROM consumption_records WHERE account_id = $1 AND request_id = $2',
        [accountBId, sharedRequestId]
      );
      assert.equal(Number(recB.rows[0].requested_units), 7);

      console.log('✔ Test 4: Cross-tenant requestId independence strictly preserved with composite uniqueness');
    }

    // =========================================================================
    // 5. اختبار سباق الطلبات المتطابقة المتزامنة (Concurrent Race on Same RequestId)
    // السيناريو: 10 طلبات متزامنة في نفس اللحظة بنفس المعرّف والمستخدم والمقدار (3 وحدات).
    // التحقق: قبول جميع الطلبات بنفس الرد، والخصم في العداد = 3 وحدات فقط (مرة واحدة)، وسجل واحد فقط.
    // =========================================================================
    {
      const accountId = `acc_idem_race_${crypto.randomBytes(4).toString('hex')}`;
      const userId = `usr_idem_race_${crypto.randomBytes(4).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'Idem Race Account', $2, 'plan_default_account')`,
        [accountId, hash]
      );
      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, 'plan_default_user')`,
        [accountId, userId]
      );

      const raceRequestId = 'req_idem_concurrent_race_999';
      const raceUnits = 3;

      // إطلاق 10 طلبات متزامنة في نفس اللحظة عبر Promise.all
      const promises = Array.from({ length: 10 }, () =>
        executeConsumption(pool, accountId, {
          userId,
          units: raceUnits,
          requestId: raceRequestId,
        })
      );

      const results = await Promise.all(promises);

      // جميع النتائج مقبولة ومتطابقة تماماً
      for (const res of results) {
        assert.equal(res.accepted, true);
        assert.deepEqual(res, results[0], 'All concurrent decisions must deeply match');
      }

      // التحقق المباشر من قاعدة البيانات:
      // العداد زاد بـ 3 وحدات فقط (خصم واحد)
      const accUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1',
        [accountId]
      );
      assert.equal(Number(accUsage.rows[0].total_units), 3, 'Account counter must increment exactly once');

      const usrUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM user_monthly_usage WHERE user_id = $1',
        [userId]
      );
      assert.equal(Number(usrUsage.rows[0].total_units), 3, 'User counter must increment exactly once');

      // يوجد سجل واحد فقط في consumption_records
      const recordCount = await pool.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM consumption_records WHERE account_id = $1 AND request_id = $2',
        [accountId, raceRequestId]
      );
      assert.equal(Number(recordCount.rows[0].count), 1, 'Exactly one consumption record must be stored');

      // التحقق من صحة مجمع الاتصالات
      assert.equal(pool.waitingCount, 0);
      assert.equal(pool.idleCount, pool.totalCount);

      console.log('✔ Test 5: 10 concurrent replays resolved idempotently with exactly 1x quota deduction');
    }

    // =========================================================================
    // 6. اختبار إعادة المحاولة بعد التراجع (Retry After Pre-Commit Rollback)
    // التوجيه الصريح: افتعال فشل قبل COMMIT، والتأكد من نجاح ROLLBACK وغياب السجل والزيادات،
    // ثم إعادة نفس الطلب بنفس requestId ليتعامل كطلب جديد كلياً.
    // =========================================================================
    {
      const accountId = `acc_idem_rb_${crypto.randomBytes(4).toString('hex')}`;
      const userId = `usr_idem_rb_${crypto.randomBytes(4).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'Idem Rollback Account', $2, 'plan_default_account')`,
        [accountId, hash]
      );
      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, 'plan_default_user')`,
        [accountId, userId]
      );

      const rollbackRequestId = 'req_idem_rollback_retry';

      // مجمع معترض يفتعل فشلاً قبل COMMIT حصراً (عند محاولة حفظ السجل)
      const interceptedPool = createQueryInterceptedPool(
        pool,
        (sql) => sql.includes('INSERT INTO consumption_records'),
        new Error('SIMULATED_PRE_COMMIT_DATABASE_FAILURE')
      );

      // 1. المحاولة الأولى تفشل وتتراجع
      let initialError: unknown = null;
      try {
        await executeConsumption(interceptedPool, accountId, {
          userId,
          units: 6,
          requestId: rollbackRequestId,
        });
      } catch (err) {
        initialError = err;
      }

      assert.ok(initialError, 'Initial execution must fail before commit');
      assert.equal((initialError as Error).message, 'SIMULATED_PRE_COMMIT_DATABASE_FAILURE');

      // 2. فحص قاعدة البيانات بعد التراجع: غياب تام للسجل والعدادات
      const preAccUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1',
        [accountId]
      );
      assert.equal(preAccUsage.rows.length, 0, 'No account usage row should survive rollback');

      const preUsrUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM user_monthly_usage WHERE user_id = $1',
        [userId]
      );
      assert.equal(preUsrUsage.rows.length, 0, 'No user usage row should survive rollback');

      const preRec = await pool.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM consumption_records WHERE account_id = $1 AND request_id = $2',
        [accountId, rollbackRequestId]
      );
      assert.equal(Number(preRec.rows[0].count), 0, 'No consumption record should exist after rollback');

      // 3. إعادة إرسال نفس الطلب بنفس requestId على المجمع السليم (دون اعتراض)
      const retryDecision = await executeConsumption(pool, accountId, {
        userId,
        units: 6,
        requestId: rollbackRequestId,
      });

      assert.equal(retryDecision.accepted, true, 'Retry after rollback must process as a fresh request');
      assert.equal(retryDecision.account.consumed, 6);

      // 4. التحقق من التزام الطلب بعد زوال العطل
      const postAccUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1',
        [accountId]
      );
      assert.equal(Number(postAccUsage.rows[0].total_units), 6);

      const postRec = await pool.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM consumption_records WHERE account_id = $1 AND request_id = $2',
        [accountId, rollbackRequestId]
      );
      assert.equal(Number(postRec.rows[0].count), 1);

      console.log('✔ Test 6: Retry after pre-commit rollback processed successfully as fresh request');
    }

    // =========================================================================
    // 7. اختبار الإعادة عبر حدود الأشهر (Replay Across Month Boundary)
    // السيناريو: طلب يُقبل في شهر أكتوبر (2026-10). يُعاد إرساله في شهر نوفمبر (2026-11).
    // التحقق: يعيد نفس قرار شهر أكتوبر، ولا يُنشئ أي صفوف أو عدادات لشهر نوفمبر.
    // =========================================================================
    {
      const accountId = `acc_idem_month_${crypto.randomBytes(4).toString('hex')}`;
      const userId = `usr_idem_month_${crypto.randomBytes(4).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'Idem Month Account', $2, 'plan_default_account')`,
        [accountId, hash]
      );
      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, 'plan_default_user')`,
        [accountId, userId]
      );

      const crossMonthRequestId = 'req_idem_cross_month_777';

      // 1. تنفيذ الطلب في شهر أكتوبر
      const octDecision = await executeConsumption(
        pool,
        accountId,
        {
          userId,
          units: 4,
          requestId: crossMonthRequestId,
        },
        { clock: () => new Date('2026-10-25T14:00:00.000Z') }
      );
      assert.equal(octDecision.accepted, true);

      // 2. إعادة إرسال نفس الطلب بنفس requestId في شهر نوفمبر
      const novReplayDecision = await executeConsumption(
        pool,
        accountId,
        {
          userId,
          units: 4,
          requestId: crossMonthRequestId,
        },
        { clock: () => new Date('2026-11-05T09:30:00.000Z') }
      );

      // التحقق من أن الرد يطابق رد شهر أكتوبر تماماً
      assert.deepEqual(novReplayDecision, octDecision, 'Replay in new month must return historical decision');

      // 3. التحقق المباشر من قاعدة البيانات:
      // أ) عداد أكتوبر = 4 وحدات
      const octUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1 AND year_month = $2',
        [accountId, '2026-10']
      );
      assert.equal(Number(octUsage.rows[0].total_units), 4);

      // ب) شهر نوفمبر: لا يوجد أي صف في account_monthly_usage أو user_monthly_usage
      const novAccUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1 AND year_month = $2',
        [accountId, '2026-11']
      );
      assert.equal(novAccUsage.rows.length, 0, 'No account monthly usage row should exist for November');

      const novUsrUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM user_monthly_usage WHERE user_id = $1 AND year_month = $2',
        [userId, '2026-11']
      );
      assert.equal(novUsrUsage.rows.length, 0, 'No user monthly usage row should exist for November');

      // ج) عدد السجلات في consumption_records ظل واحداً فقط
      const recordCount = await pool.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM consumption_records WHERE account_id = $1 AND request_id = $2',
        [accountId, crossMonthRequestId]
      );
      assert.equal(Number(recordCount.rows[0].count), 1);

      console.log('✔ Test 7: Replay in new month preserved historical decision with zero rows created for new month');
    }

    console.log('--- All Idempotency and Deduplication Tests (Part 22) Passed Successfully! ---');
  } finally {
    await pool.end();
  }
}

runIdempotencyTests().catch((err) => {
  console.error('Idempotency tests failed:', err);
  process.exit(1);
});

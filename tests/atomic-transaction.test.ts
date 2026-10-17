// tests/atomic-transaction.test.ts
// اختبارات المعاملة الذرية وضمانات الكل أو لا شيء وسياق القرارات التاريخية (Part 20: The Atomic Transaction)

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type pg from 'pg';
import { initEnvironment, loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrator.js';
import { executeConsumption, type DecisionContext } from '../src/consumptions.js';
import { createCustomPlan, updateCustomPlan } from '../src/plans.js';
import { UserNotFoundError } from '../src/users.js';

/**
 * دالة مساعدة لإنشاء بروكسي لمجمع الاتصالات يعترض استعلامات محددة لاختبار التراجع
 * مع إبقاء BEGIN، والقفل، والكتابات السابقة، و ROLLBACK تعمل على الاتصال الحقيقي
 */
function createQueryInterceptedPool(
  realPool: pg.Pool,
  shouldFailQuery: (sql: string, params?: unknown[]) => boolean,
  failureError: Error
): pg.Pool {
  return new Proxy(realPool, {
    get(target, prop, receiver) {
      if (prop === 'connect') {
        return async () => {
          const client = await target.connect();
          const originalQuery = client.query.bind(client);

          (client as any).query = async (...args: any[]) => {
            const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? '';
            const params = Array.isArray(args[1]) ? args[1] : undefined;
            if (shouldFailQuery(sql, params)) {
              throw failureError;
            }
            return (originalQuery as any)(...args);
          };

          const originalRelease = client.release.bind(client);
          (client as any).release = (destroy?: boolean) => {
            // ضمان استعادة الدالة الأصلية في finally عند تحرير الاتصال
            (client as any).query = originalQuery;
            return originalRelease(destroy);
          };

          return client;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function runAtomicTransactionTests(): Promise<void> {
  console.log('--- Starting Atomic Transaction Tests (Part 20) ---');

  initEnvironment();
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);

  try {
    // تشغيل المهاجرات لضمان تطبيق 003_add_decision_context_to_consumption_records.sql
    const migrationResult = await runMigrations(pool);
    console.log(`✔ Migrations verified. Applied now: [${migrationResult.applied.join(', ')}]`);

    // ==========================================
    // 1. اختبار قبول الاستهلاك وتحديث السجلات الثلاثة مع سياق القرار
    // ==========================================
    {
      const accountId = `acc_test_p20_acc_${crypto.randomBytes(4).toString('hex')}`;
      const userId = `usr_test_p20_acc_${crypto.randomBytes(4).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'P20 Accept Account', $2, 'plan_default_account')`,
        [accountId, hash]
      );
      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, 'plan_default_user')`,
        [accountId, userId]
      );

      const fixedDate = new Date('2026-10-15T14:30:00.000Z');
      const decision = await executeConsumption(
        pool,
        accountId,
        {
          userId,
          units: 10,
          requestId: 'req_p20_accept_001',
        },
        { clock: () => fixedDate }
      );

      assert.equal(decision.accepted, true);
      assert.equal(decision.requestId, 'req_p20_accept_001');
      assert.equal(decision.account.consumed, 10);
      assert.equal(decision.user.consumed, 10);

      // التحقق المباشر من قاعدة البيانات: عداد الحساب
      const accUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1 AND year_month = $2',
        [accountId, '2026-10']
      );
      assert.equal(accUsage.rows.length, 1);
      assert.equal(Number(accUsage.rows[0].total_units), 10);

      // التحقق المباشر من قاعدة البيانات: عداد المستخدم
      const usrUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM user_monthly_usage WHERE user_id = $1 AND year_month = $2',
        [userId, '2026-10']
      );
      assert.equal(usrUsage.rows.length, 1);
      assert.equal(Number(usrUsage.rows[0].total_units), 10);

      // التحقق المباشر من قاعدة البيانات: سجل الاستهلاك والسياق التاريخي
      const recResult = await pool.query<{
        status: string;
        rejection_scope: string | null;
        rejection_rule: string | null;
        response_body: any;
        decision_context: DecisionContext;
        processed_at: Date;
      }>('SELECT * FROM consumption_records WHERE account_id = $1 AND request_id = $2', [
        accountId,
        'req_p20_accept_001',
      ]);
      assert.equal(recResult.rows.length, 1);
      const row = recResult.rows[0];
      assert.equal(row.status, 'ACCEPTED');
      assert.equal(row.rejection_scope, null);
      assert.equal(row.rejection_rule, null);
      assert.equal(row.response_body.accepted, true);
      assert.equal(row.response_body.account.consumed, 10);
      assert.equal(row.decision_context.accountPlan.id, 'plan_default_account');
      assert.equal(row.decision_context.userPlan.id, 'plan_default_user');
      assert.equal(row.decision_context.usageBefore.accountConsumed, 0);
      assert.equal(row.decision_context.usageBefore.userConsumed, 0);
      assert.equal(row.processed_at.toISOString(), fixedDate.toISOString());

      console.log('✔ Test 1: Successful consumption accepted and all 3 writes committed');
    }

    // ==========================================
    // 2. اختبار رفض الاستهلاك لقاعدة حصة (Business Rejection Commit)
    // ==========================================
    {
      const accountId = `acc_test_p20_rej_${crypto.randomBytes(4).toString('hex')}`;
      const userId = `usr_test_p20_rej_${crypto.randomBytes(4).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'P20 Reject Account', $2, 'plan_default_account')`,
        [accountId, hash]
      );
      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, 'plan_default_user')`,
        [accountId, userId]
      );

      // plan_default_user حد الطلب الواحد 500؛ نطلب 501 لفرض الرفض بسبب حد المستخدم للطلب الواحد
      const decision = await executeConsumption(
        pool,
        accountId,
        {
          userId,
          units: 501,
          requestId: 'req_p20_reject_001',
        },
        { clock: () => new Date('2026-10-15T15:00:00.000Z') }
      );

      assert.equal(decision.accepted, false);
      if (!decision.accepted) {
        assert.equal(decision.reason.scope, 'user');
        assert.equal(decision.reason.rule, 'max_per_request');
        assert.equal(decision.account.consumed, 0);
        assert.equal(decision.user.consumed, 0);
      }

      // التحقق من أن العدادات لم تزد
      const accUsage = await pool.query(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1',
        [accountId]
      );
      assert.equal(accUsage.rows.length, 0, 'No account monthly usage row should exist');

      const usrUsage = await pool.query(
        'SELECT total_units FROM user_monthly_usage WHERE user_id = $1',
        [userId]
      );
      assert.equal(usrUsage.rows.length, 0, 'No user monthly usage row should exist');

      // التحقق من حفظ سجل الرفض والسياق بنجاح في consumption_records
      const recResult = await pool.query<{
        status: string;
        rejection_scope: string;
        rejection_rule: string;
        response_body: any;
        decision_context: DecisionContext;
      }>('SELECT * FROM consumption_records WHERE account_id = $1 AND request_id = $2', [
        accountId,
        'req_p20_reject_001',
      ]);
      assert.equal(recResult.rows.length, 1);
      assert.equal(recResult.rows[0].status, 'REJECTED');
      assert.equal(recResult.rows[0].rejection_scope, 'user');
      assert.equal(recResult.rows[0].rejection_rule, 'max_per_request');
      assert.equal(recResult.rows[0].response_body.accepted, false);
      assert.equal(recResult.rows[0].decision_context.userPlan.id, 'plan_default_user');

      console.log('✔ Test 2: Business rejection correctly saved without incrementing usage counters');
    }

    // ==========================================
    // 3. إثبات التراجع عند الفشل بعد كتابة الحساب وقبل كتابة المستخدم (Rollback Proof 1)
    // ==========================================
    {
      const accountId = `acc_test_p20_rb1_${crypto.randomBytes(4).toString('hex')}`;
      const userId = `usr_test_p20_rb1_${crypto.randomBytes(4).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'P20 Rollback 1 Account', $2, 'plan_default_account')`,
        [accountId, hash]
      );
      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, 'plan_default_user')`,
        [accountId, userId]
      );

      // مجمع اتصالات يعترض فقط جملة INSERT INTO user_monthly_usage
      const interceptedPool = createQueryInterceptedPool(
        pool,
        (sql) => sql.includes('INSERT INTO user_monthly_usage'),
        new Error('SIMULATED_USER_USAGE_INSERT_FAILURE')
      );

      let thrownError: unknown = null;
      try {
        await executeConsumption(
          interceptedPool,
          accountId,
          {
            userId,
            units: 5,
            requestId: 'req_p20_rollback_001',
          },
          { clock: () => new Date('2026-10-15T16:00:00.000Z') }
        );
      } catch (err) {
        thrownError = err;
      }

      assert.ok(thrownError, 'Expected transaction to fail and throw');
      assert.equal((thrownError as Error).message, 'SIMULATED_USER_USAGE_INSERT_FAILURE');

      // إثبات تراجع المعاملة بالكامل على الاتصال الحقيقي
      const accUsage = await pool.query(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1',
        [accountId]
      );
      assert.equal(accUsage.rows.length, 0, 'Account monthly usage must be rolled back');

      const usrUsage = await pool.query(
        'SELECT total_units FROM user_monthly_usage WHERE user_id = $1',
        [userId]
      );
      assert.equal(usrUsage.rows.length, 0, 'User monthly usage must not be persisted');

      const records = await pool.query(
        'SELECT id FROM consumption_records WHERE account_id = $1',
        [accountId]
      );
      assert.equal(records.rows.length, 0, 'Consumption records must not be persisted');

      console.log('✔ Test 3: Rollback verified when failure occurs after account counter update');
    }

    // ==========================================
    // 4. إثبات التراجع عند الفشل بعد كتابة العدّادين وقبل حفظ السجل (Rollback Proof 2)
    // ==========================================
    {
      const accountId = `acc_test_p20_rb2_${crypto.randomBytes(4).toString('hex')}`;
      const userId = `usr_test_p20_rb2_${crypto.randomBytes(4).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'P20 Rollback 2 Account', $2, 'plan_default_account')`,
        [accountId, hash]
      );
      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, 'plan_default_user')`,
        [accountId, userId]
      );

      // مجمع اتصالات يعترض جملة INSERT INTO consumption_records
      const interceptedPool = createQueryInterceptedPool(
        pool,
        (sql) => sql.includes('INSERT INTO consumption_records'),
        new Error('SIMULATED_RECORD_INSERT_FAILURE')
      );

      let thrownError: unknown = null;
      try {
        await executeConsumption(
          interceptedPool,
          accountId,
          {
            userId,
            units: 7,
            requestId: 'req_p20_rollback_002',
          },
          { clock: () => new Date('2026-10-15T16:30:00.000Z') }
        );
      } catch (err) {
        thrownError = err;
      }

      assert.ok(thrownError, 'Expected transaction to fail and throw');
      assert.equal((thrownError as Error).message, 'SIMULATED_RECORD_INSERT_FAILURE');

      // إثبات تراجع المعاملة بالكامل وإلغاء زيادات العدادين معاً
      const accUsage = await pool.query(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1',
        [accountId]
      );
      assert.equal(accUsage.rows.length, 0, 'Account usage must be rolled back');

      const usrUsage = await pool.query(
        'SELECT total_units FROM user_monthly_usage WHERE user_id = $1',
        [userId]
      );
      assert.equal(usrUsage.rows.length, 0, 'User usage must be rolled back');

      const records = await pool.query(
        'SELECT id FROM consumption_records WHERE account_id = $1',
        [accountId]
      );
      assert.equal(records.rows.length, 0, 'No consumption record should exist');

      console.log('✔ Test 4: Rollback verified when failure occurs after both counters updated');
    }

    // ==========================================
    // 4B. إثبات تراجع المعاملة على صفوف عدّادات قائمة مسبقاً (Rollback of UPDATE on Existing Counter Rows)
    // ==========================================
    {
      const accountId = `acc_test_p20_exist_${crypto.randomBytes(4).toString('hex')}`;
      const userId = `usr_test_p20_exist_${crypto.randomBytes(4).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'P20 Existing Rows Account', $2, 'plan_default_account')`,
        [accountId, hash]
      );
      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, 'plan_default_user')`,
        [accountId, userId]
      );

      // 1. تنفيذ استهلاك أولي ناجح بمقدار 20 وحدة لإنشاء الصفوف بقيم غير صفرية
      const dec1 = await executeConsumption(
        pool,
        accountId,
        {
          userId,
          units: 20,
          requestId: 'req_p20_exist_001',
        },
        { clock: () => new Date('2026-10-15T16:45:00.000Z') }
      );
      assert.equal(dec1.accepted, true);
      assert.equal(dec1.account.consumed, 20);
      assert.equal(dec1.user.consumed, 20);

      // التأكد من أن العدادات الابتدائية = 20، ويوجد سجل واحد
      const preAcc = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1 AND year_month = $2',
        [accountId, '2026-10']
      );
      assert.equal(Number(preAcc.rows[0].total_units), 20);

      const preUsr = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM user_monthly_usage WHERE user_id = $1 AND year_month = $2',
        [userId, '2026-10']
      );
      assert.equal(Number(preUsr.rows[0].total_units), 20);

      const preRec = await pool.query<{ id: string; response_body: any }>(
        'SELECT id, response_body FROM consumption_records WHERE account_id = $1',
        [accountId]
      );
      assert.equal(preRec.rows.length, 1);
      const initialRecordId = preRec.rows[0].id;
      const initialResponseBody = preRec.rows[0].response_body;

      // 2. الآن نطلب استهلاكاً ثانياً بمقدار 15 وحدة، ونعترض حفظ السجل بعد تحديث العدادين القائمين
      // في محرك القاعدة: total_units للحساب والمستخدم سينتقلان داخل المعاملة إلى 20 + 15 = 35
      const interceptedPool = createQueryInterceptedPool(
        pool,
        (sql, params) =>
          sql.includes('INSERT INTO consumption_records') &&
          (params?.includes('req_p20_exist_002') ?? false),
        new Error('SIMULATED_FAILURE_ON_EXISTING_ROW_CONSUMPTION')
      );

      let secondError: unknown = null;
      try {
        await executeConsumption(
          interceptedPool,
          accountId,
          {
            userId,
            units: 15,
            requestId: 'req_p20_exist_002',
          },
          { clock: () => new Date('2026-10-15T16:50:00.000Z') }
        );
      } catch (err) {
        secondError = err;
      }

      assert.ok(secondError, 'Expected second consumption to fail and throw');
      assert.equal((secondError as Error).message, 'SIMULATED_FAILURE_ON_EXISTING_ROW_CONSUMPTION');

      // 3. التحقق المباشر من قاعدة البيانات:
      // يجب أن يتراجع عداد الحساب من 35 إلى قيمته السابقة 20
      const postAcc = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1 AND year_month = $2',
        [accountId, '2026-10']
      );
      assert.equal(Number(postAcc.rows[0].total_units), 20, 'Existing account usage must roll back to 20, not stay at 35');

      // يجب أن يتراجع عداد المستخدم من 35 إلى قيمته السابقة 20
      const postUsr = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM user_monthly_usage WHERE user_id = $1 AND year_month = $2',
        [userId, '2026-10']
      );
      assert.equal(Number(postUsr.rows[0].total_units), 20, 'Existing user usage must roll back to 20, not stay at 35');

      // يجب أن يبقى السجل السابق كما هو تماماً دون إضافة أي سجل جديد
      const postRec = await pool.query<{ id: string; request_id: string; response_body: any }>(
        'SELECT id, request_id, response_body FROM consumption_records WHERE account_id = $1',
        [accountId]
      );
      assert.equal(postRec.rows.length, 1, 'Only the previous consumption record must remain');
      assert.equal(postRec.rows[0].id, initialRecordId);
      assert.equal(postRec.rows[0].request_id, 'req_p20_exist_001');
      assert.deepEqual(postRec.rows[0].response_body, initialResponseBody, 'Previous record content must be completely untouched');

      console.log('✔ Test 4B: Rollback of UPDATE on existing non-zero counter rows verified');
    }

    // ==========================================
    // 5. اختبار استقلال وثبات السجل التاريخي عند تعديل الخطة لاحقاً (User Requirement 2)
    // ==========================================
    {
      const accountId = `acc_test_p20_hist_${crypto.randomBytes(4).toString('hex')}`;
      const userId = `usr_test_p20_hist_${crypto.randomBytes(4).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'P20 Historical Account', $2, 'plan_default_account')`,
        [accountId, hash]
      );

      // إنشاء خطة مستخدم مخصصة بحد شهري 50 وحد لكل طلب 15 بعد إنشاء حساب المالك
      const customUserPlan = await createCustomPlan(pool, accountId, {
        name: 'Initial User Plan',
        type: 'USER',
        monthlyLimit: 50,
        perRequestLimit: 15,
      });

      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, $3)`,
        [accountId, userId, customUserPlan.id]
      );

      // تنفيذ استهلاك أولي بـ 10 وحدات
      const initialDecision = await executeConsumption(
        pool,
        accountId,
        {
          userId,
          units: 10,
          requestId: 'req_p20_hist_001',
        },
        { clock: () => new Date('2026-10-15T17:00:00.000Z') }
      );
      assert.equal(initialDecision.accepted, true);
      assert.equal(initialDecision.user.remaining, 40); // 50 - 10 = 40

      // قراءة السجل المحفوظ مباشرة
      const beforeUpdateRec = await pool.query<{
        response_body: any;
        decision_context: DecisionContext;
      }>('SELECT response_body, decision_context FROM consumption_records WHERE account_id = $1 AND request_id = $2', [
        accountId,
        'req_p20_hist_001',
      ]);
      const initialSavedResponse = beforeUpdateRec.rows[0].response_body;
      const initialSavedContext = beforeUpdateRec.rows[0].decision_context;

      assert.equal(initialSavedContext.userPlan.monthlyLimit, 50);
      assert.equal(initialSavedContext.userPlan.perRequestLimit, 15);
      assert.equal(initialSavedResponse.user.remaining, 40);

      // الآن نقوم بتعديل الخطة المخصصة برفع الحد إلى 200 وحد الطلب إلى 40
      await updateCustomPlan(pool, customUserPlan.id, accountId, {
        monthlyLimit: 200,
        perRequestLimit: 40,
      });

      // إعادة قراءة السجل التاريخي السابق من قاعدة البيانات
      const afterUpdateRec = await pool.query<{
        response_body: any;
        decision_context: DecisionContext;
      }>('SELECT response_body, decision_context FROM consumption_records WHERE account_id = $1 AND request_id = $2', [
        accountId,
        'req_p20_hist_001',
      ]);
      const postUpdateSavedResponse = afterUpdateRec.rows[0].response_body;
      const postUpdateSavedContext = afterUpdateRec.rows[0].decision_context;

      // إثبات أن response_body و decision_context للسجل السابق لم يتغيرا إطلاقاً
      assert.deepEqual(postUpdateSavedResponse, initialSavedResponse, 'response_body must remain completely unchanged');
      assert.deepEqual(postUpdateSavedContext, initialSavedContext, 'decision_context must remain completely unchanged');
      assert.equal(postUpdateSavedContext.userPlan.monthlyLimit, 50, 'Historical plan limit in context must be strictly preserved');
      assert.equal(postUpdateSavedContext.userPlan.perRequestLimit, 15);

      console.log('✔ Test 5: Historical record and decision_context remain invariant after plan modification');
    }

    // ==========================================
    // 6. اختبار سلوك تكرار requestId وإعادة الرد الأصلي (Part 22 Update)
    // ==========================================
    {
      const accountId = `acc_test_p20_dup_${crypto.randomBytes(4).toString('hex')}`;
      const userId = `usr_test_p20_dup_${crypto.randomBytes(4).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'P20 Duplicate Account', $2, 'plan_default_account')`,
        [accountId, hash]
      );
      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, 'plan_default_user')`,
        [accountId, userId]
      );

      // الطلب الأول بنفس requestId ينجح
      const dec1 = await executeConsumption(
        pool,
        accountId,
        {
          userId,
          units: 8,
          requestId: 'req_p20_duplicate_test',
        },
        { clock: () => new Date('2026-10-15T18:00:00.000Z') }
      );
      assert.equal(dec1.accepted, true);

      // الطلب الثاني بنفس requestId والبيانات المتطابقة ينجح كإعادة متطابقة ويعيد نفس الرد الأصلي
      const dec2 = await executeConsumption(
        pool,
        accountId,
        {
          userId,
          units: 8,
          requestId: 'req_p20_duplicate_test',
        },
        { clock: () => new Date('2026-10-15T18:05:00.000Z') }
      );
      assert.deepEqual(dec2, dec1, 'Idempotent replay must return the exact same original response body');

      // إثبات أن العدادات لم تزد مرة ثانية وتوقفت عند 8
      const accUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1',
        [accountId]
      );
      assert.equal(Number(accUsage.rows[0].total_units), 8, 'Account counter must not double');

      const usrUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM user_monthly_usage WHERE user_id = $1',
        [userId]
      );
      assert.equal(Number(usrUsage.rows[0].total_units), 8, 'User counter must not double');

      // التحقق من وجود سجل استهلاك واحد فقط في قاعدة البيانات
      const recCount = await pool.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM consumption_records WHERE account_id = $1 AND request_id = $2',
        [accountId, 'req_p20_duplicate_test']
      );
      assert.equal(Number(recCount.rows[0].count), 1, 'Exactly one consumption record must exist');

      console.log('✔ Test 6: Duplicate requestId returns original decision with invariant counters and single record');
    }

    // ==========================================
    // 7. اختبار التحقق من وجود المستخدم وسلامة أنواع الخطط
    // ==========================================
    {
      const accountId = `acc_test_p20_val_${crypto.randomBytes(4).toString('hex')}`;
      const foreignAccountId = `acc_test_p20_for_${crypto.randomBytes(4).toString('hex')}`;
      const hash1 = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');
      const hash2 = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'P20 Val Account', $2, 'plan_default_account')`,
        [accountId, hash1]
      );
      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'P20 Foreign Account', $2, 'plan_default_account')`,
        [foreignAccountId, hash2]
      );

      // مستخدم تابع لحساب أجنبي
      const foreignUserId = `usr_test_p20_foreign_${crypto.randomBytes(4).toString('hex')}`;
      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, 'plan_default_user')`,
        [foreignAccountId, foreignUserId]
      );

      // طلب لمستخدم أجنبي يجب أن يلقي UserNotFoundError
      await assert.rejects(
        async () => {
          await executeConsumption(pool, accountId, {
            userId: foreignUserId,
            units: 5,
            requestId: 'req_val_001',
          });
        },
        (err: unknown) => err instanceof UserNotFoundError
      );

      // طلب لمستخدم غير موجود إطلاقاً
      await assert.rejects(
        async () => {
          await executeConsumption(pool, accountId, {
            userId: 'usr_non_existent',
            units: 5,
            requestId: 'req_val_002',
          });
        },
        (err: unknown) => err instanceof UserNotFoundError
      );

      console.log('✔ Test 7: User existence and tenant isolation strictly verified');
    }

    // ==========================================
    // 8. اختبار حقن الساعة (Clock Injection)
    // ==========================================
    {
      const accountId = `acc_test_p20_clk_${crypto.randomBytes(4).toString('hex')}`;
      const userId = `usr_test_p20_clk_${crypto.randomBytes(4).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'P20 Clock Account', $2, 'plan_default_account')`,
        [accountId, hash]
      );
      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, 'plan_default_user')`,
        [accountId, userId]
      );

      const injectedDate = new Date('2027-04-10T08:15:30.000Z');
      let clockCallCount = 0;
      const clockFn = () => {
        clockCallCount++;
        return injectedDate;
      };

      const decision = await executeConsumption(
        pool,
        accountId,
        {
          userId,
          units: 3,
          requestId: 'req_p20_clock_001',
        },
        { clock: clockFn }
      );

      assert.equal(decision.accepted, true);
      assert.equal(clockCallCount, 1, 'Clock must be called exactly once after obtaining the lock');

      // التحقق من أن شهر العداد تم تحديده بناءً على الساعة المحقونة (2027-04)
      const accUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1 AND year_month = $2',
        [accountId, '2027-04']
      );
      assert.equal(accUsage.rows.length, 1);
      assert.equal(Number(accUsage.rows[0].total_units), 3);

      const rec = await pool.query<{ processed_at: Date }>(
        'SELECT processed_at FROM consumption_records WHERE account_id = $1 AND request_id = $2',
        [accountId, 'req_p20_clock_001']
      );
      assert.equal(rec.rows[0].processed_at.toISOString(), injectedDate.toISOString());

      console.log('✔ Test 8: Clock injection accurately sets processing month and decision timestamp');
    }

    console.log('--- All Atomic Transaction Tests (Part 20) Passed Successfully! ---');
  } finally {
    await pool.end();
  }
}

runAtomicTransactionTests().catch((err) => {
  console.error('Atomic transaction tests failed:', err);
  process.exit(1);
});

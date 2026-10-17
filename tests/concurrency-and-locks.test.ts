// tests/concurrency-and-locks.test.ts
// اختبارات التزامن والأقفال ومنع الصرف المزدوج (Part 21: Concurrency & Locks)

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type pg from 'pg';
import { initEnvironment, loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrator.js';
import { executeConsumption, type DecisionContext } from '../src/consumptions.js';
import { createCustomPlan, updateCustomPlan } from '../src/plans.js';

/**
 * دالة مساعدة لانتظار فترة زمنية بالمللي ثانية
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * دالة مساعدة لتغليف أي وعد بمهلة زمنية قصوى لمنع تعليق الاختبارات عند الفشل
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout of ${ms}ms exceeded while waiting for: ${label}`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function runConcurrencyAndLocksTests(): Promise<void> {
  console.log('--- Starting Concurrency and Locks Tests (Part 21) ---');

  initEnvironment();
  const config = loadConfig();

  // إنشاء مجمع اتصالات بسعة مناسبة لاستيعاب الطلبات المتزامنة
  const pool = createPool(config.DATABASE_URL, {
    max: 20,
    connectionTimeoutMillis: 10000,
    statementTimeoutMillis: 15000,
    queryTimeoutMillis: 20000,
  });

  try {
    await runMigrations(pool);
    const fixedDate = new Date('2026-10-20T10:00:00.000Z');

    // =========================================================================
    // 1. اختبار سباق استنزاف الرصيد (100 Concurrent Requests Draining Quota of 10)
    // السيناريو: 100 طلب متزامن كل منها بـ 1 وحدة لرصيد شهري متاح = 10 وحدات فقط.
    // التحقق: قبول 10 طلبات بالضبط، ورفض 90 طلباً، والعداد النهائي = 10 تماماً.
    // =========================================================================
    {
      const accountId = `acc_race_100_${crypto.randomBytes(4).toString('hex')}`;
      const userId = `usr_race_100_${crypto.randomBytes(4).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

      // إنشاء خطة حساب بحد شهري 10 وحدات، مع وضع حد الطلب عالياً (100) لضمان أن الحد الشهري هو الحاكم
      const accountPlan = await pool.query<{ id: string }>(
        `INSERT INTO plans (id, name, type, monthly_limit, per_request_limit)
         VALUES ($1, 'Race Account Plan 10', 'ACCOUNT', 10, 100)
         RETURNING id`,
        [`plan_race_acc_${crypto.randomBytes(4).toString('hex')}`]
      );

      // إنشاء خطة مستخدم بحد شهري وحد طلب عاليين (100) لضمان عدم حجب الطلبات من مستوى المستخدم
      const userPlan = await pool.query<{ id: string }>(
        `INSERT INTO plans (id, name, type, monthly_limit, per_request_limit)
         VALUES ($1, 'Race User Plan 100', 'USER', 100, 100)
         RETURNING id`,
        [`plan_race_usr_${crypto.randomBytes(4).toString('hex')}`]
      );

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'Race 100 Account', $2, $3)`,
        [accountId, hash, accountPlan.rows[0].id]
      );
      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, $3)`,
        [accountId, userId, userPlan.rows[0].id]
      );

      // إطلاق 100 طلب استهلاك متزامن في نفس اللحظة عبر Promise.all
      const requestCount = 100;
      const promises = Array.from({ length: requestCount }, (_, i) =>
        executeConsumption(
          pool,
          accountId,
          {
            userId,
            units: 1,
            requestId: `req_race_100_${i}`,
          },
          { clock: () => fixedDate }
        )
      );

      const results = await Promise.all(promises);

      const acceptedDecisions = results.filter((r) => r.accepted);
      const rejectedDecisions = results.filter((r) => !r.accepted);

      // 1. التحقق من أعداد القرارات
      assert.equal(
        acceptedDecisions.length,
        10,
        `Exactly 10 requests must be accepted, but got ${acceptedDecisions.length}`
      );
      assert.equal(
        rejectedDecisions.length,
        90,
        `Exactly 90 requests must be rejected, but got ${rejectedDecisions.length}`
      );

      // 2. التحقق من سبب الرفض لجميع الطلبات المرفوضة (تجاوز الحصة الشهرية للحساب)
      for (const rej of rejectedDecisions) {
        if (!rej.accepted) {
          assert.equal(rej.reason.scope, 'account');
          assert.equal(rej.reason.rule, 'monthly_allowance');
        }
      }

      // 3. التحقق المباشر من العدادات في قاعدة البيانات
      const accUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1 AND year_month = $2',
        [accountId, '2026-10']
      );
      assert.equal(
        Number(accUsage.rows[0].total_units),
        10,
        'Final account monthly usage counter must be exactly 10 (Zero Overspending)'
      );

      const usrUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM user_monthly_usage WHERE user_id = $1 AND year_month = $2',
        [userId, '2026-10']
      );
      assert.equal(
        Number(usrUsage.rows[0].total_units),
        10,
        'Final user monthly usage counter must be exactly 10'
      );

      // 4. التحقق من سجل الاستهلاك: مجموع المقبول في السجلات يطابق العدادات تماماً
      const recordSummary = await pool.query<{ accepted_count: string; rejected_count: string; sum_units: string }>(
        `SELECT 
           COUNT(*) FILTER (WHERE status = 'ACCEPTED') AS accepted_count,
           COUNT(*) FILTER (WHERE status = 'REJECTED') AS rejected_count,
           COALESCE(SUM(requested_units) FILTER (WHERE status = 'ACCEPTED'), 0) AS sum_units
         FROM consumption_records
         WHERE account_id = $1`,
        [accountId]
      );
      assert.equal(Number(recordSummary.rows[0].accepted_count), 10);
      assert.equal(Number(recordSummary.rows[0].rejected_count), 90);
      assert.equal(Number(recordSummary.rows[0].sum_units), 10);

      console.log('✔ Test 1: 100-to-10 Quota Drain Race passed with zero overspending and exact accounting');
    }

    // =========================================================================
    // 2. اختبار تزامن عدة مستخدمين تحت سقف حساب مشترك (Shared Account Quota)
    // السيناريو: الحساب حدّه الشهري 25. المستخدم أ والمستخدم ب حد كل منهما 50.
    // يطلق المستخدمان معاً 40 طلباً (20 لكل مستخدم).
    // التحقق: مجموع المقبول للمستخدمين لا يتجاوز 25، والطلبات الزائدة ترفض بحصة الحساب.
    // =========================================================================
    {
      const accountId = `acc_shared_limit_${crypto.randomBytes(4).toString('hex')}`;
      const userAId = `usr_shared_a_${crypto.randomBytes(4).toString('hex')}`;
      const userBId = `usr_shared_b_${crypto.randomBytes(4).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

      // خطة حساب بحد شهري 25
      const accountPlan = await pool.query<{ id: string }>(
        `INSERT INTO plans (id, name, type, monthly_limit, per_request_limit)
         VALUES ($1, 'Shared Account Plan 25', 'ACCOUNT', 25, 50)
         RETURNING id`,
        [`plan_shared_acc_${crypto.randomBytes(4).toString('hex')}`]
      );

      // خطة مستخدم بحد شهري 50
      const userPlan = await pool.query<{ id: string }>(
        `INSERT INTO plans (id, name, type, monthly_limit, per_request_limit)
         VALUES ($1, 'Shared User Plan 50', 'USER', 50, 50)
         RETURNING id`,
        [`plan_shared_usr_${crypto.randomBytes(4).toString('hex')}`]
      );

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'Shared Limit Account', $2, $3)`,
        [accountId, hash, accountPlan.rows[0].id]
      );
      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, $3), ($1, $4, $3)`,
        [accountId, userAId, userPlan.rows[0].id, userBId]
      );

      // إطلاق 20 طلباً للمستخدم أ و 20 طلباً للمستخدم ب بالتزامن (المجموع = 40 طلباً)
      const userAPromises = Array.from({ length: 20 }, (_, i) =>
        executeConsumption(
          pool,
          accountId,
          {
            userId: userAId,
            units: 1,
            requestId: `req_shared_a_${i}`,
          },
          { clock: () => fixedDate }
        )
      );

      const userBPromises = Array.from({ length: 20 }, (_, i) =>
        executeConsumption(
          pool,
          accountId,
          {
            userId: userBId,
            units: 1,
            requestId: `req_shared_b_${i}`,
          },
          { clock: () => fixedDate }
        )
      );

      const allResults = await Promise.all([...userAPromises, ...userBPromises]);

      const accepted = allResults.filter((r) => r.accepted);
      const rejected = allResults.filter((r) => !r.accepted);

      assert.equal(accepted.length, 25, 'Total accepted across both users must equal shared account limit 25');
      assert.equal(rejected.length, 15, 'Remaining 15 requests must be rejected');

      // جميع الطلبات المرفوضة سُجلت بسبب الحساب المشترك
      for (const rej of rejected) {
        if (!rej.accepted) {
          assert.equal(rej.reason.scope, 'account');
          assert.equal(rej.reason.rule, 'monthly_allowance');
        }
      }

      // عداد الحساب الشهري = 25
      const accUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1 AND year_month = $2',
        [accountId, '2026-10']
      );
      assert.equal(Number(accUsage.rows[0].total_units), 25);

      // مجموع عدادي المستخدمين = 25
      const usrAUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM user_monthly_usage WHERE user_id = $1 AND year_month = $2',
        [userAId, '2026-10']
      );
      const usrBUsage = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM user_monthly_usage WHERE user_id = $1 AND year_month = $2',
        [userBId, '2026-10']
      );
      const sumUserUnits =
        (usrAUsage.rows.length > 0 ? Number(usrAUsage.rows[0].total_units) : 0) +
        (usrBUsage.rows.length > 0 ? Number(usrBUsage.rows[0].total_units) : 0);
      assert.equal(sumUserUnits, 25, 'Sum of user counters must equal 25');

      console.log('✔ Test 2: Shared account quota safely coordinated across multiple concurrent users');
    }

    // =========================================================================
    // 3. اختبار الترتيب المنضبط بين تعديل الخطة والاستهلاك (Ordering & Contention)
    // الترتيب أ: تعديل الخطة يحوز القفل أولاً -> الاستهلاك ينتظر -> يرى الحدود الجديدة
    // الترتيب ب: الاستهلاك يحوز القفل أولاً -> تعديل الخطة ينتظر -> الاستهلاك يعتمد الحدود القديمة
    // =========================================================================
    {
      const accountId = `acc_order_${crypto.randomBytes(4).toString('hex')}`;
      const userId = `usr_order_${crypto.randomBytes(4).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

      await pool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'Ordering Account', $2, 'plan_default_account')`,
        [accountId, hash]
      );

      // إنشاء خطة مخصصة ابتدائية بحد لكل طلب = 5 وحدات فقط
      const customPlan = await createCustomPlan(pool, accountId, {
        name: 'Initial Limited Plan',
        type: 'USER',
        monthlyLimit: 100,
        perRequestLimit: 5,
      });

      await pool.query(
        `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, $3)`,
        [accountId, userId, customPlan.id]
      );

      // -----------------------------------------------------------------------
      // الترتيب أ: تعديل الخطة يحجز قفل الحساب أولاً -> طلب استهلاك بـ 8 وحدات ينتظر القفل
      // تعديل الخطة ينفّذ حقيقياً عبر updateCustomPlan ومجمع معترض، ويتم إيقافه مؤقتاً تحت القفل
      // لإثبات حجب executeConsumption في pg_blocking_pids(waiterPid) في كيرنل PostgreSQL.
      // بعد تحرير التعديل والتزامه (حد الطلب 20)، يُفَك القفل، فيُقبل الاستهلاك ويرى الحد 20.
      // -----------------------------------------------------------------------
      let updateHolderPidA: number | null = null;
      let waiterPidA: number | null = null;

      let pauseUpdateResolverA: () => void = () => {};
      const pauseUpdatePromiseA = new Promise<void>((resolve) => {
        pauseUpdateResolverA = resolve;
      });

      let onLockAcquiredResolverA: () => void = () => {};
      const onLockAcquiredPromiseA = new Promise<void>((resolve) => {
        onLockAcquiredResolverA = resolve;
      });

      // مجمع معترض للعملية الحاجزة: يلتقط PID ويوقفها مؤقتاً تحت القفل، مع استعادة الدالة الأصلية دائماً
      const interceptingPoolA = new Proxy(pool, {
        get(target, prop, receiver) {
          if (prop === 'connect') {
            return async () => {
              const client = await target.connect();
              const originalQuery = client.query.bind(client);
              const originalRelease = client.release.bind(client);

              // 1. استعادة دالة query الأصلية ودالة release الأصلية فور تحرير الاتصال للمجمع
              client.release = (destroy?: boolean) => {
                client.query = originalQuery;
                client.release = originalRelease;
                return originalRelease(destroy);
              };

              (client as any).query = async (...args: any[]) => {
                const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? '';
                // اعتراض الاستعلام بعد حيازة القفل مباشرة داخل updateCustomPlan
                if (sql.includes('SELECT id, name, type, monthly_limit, per_request_limit')) {
                  const pidRes = await originalQuery('SELECT pg_backend_pid() AS pid');
                  updateHolderPidA = (pidRes as any).rows[0].pid;
                  onLockAcquiredResolverA();
                  await pauseUpdatePromiseA;
                }
                return (originalQuery as any)(...args);
              };

              return client;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      // 4. مجمع للعملية المنتظرة: يلتقط waiterPid الخاص بها تحديداً فور استعارة الاتصال مع حماية من التسريب
      const waiterPoolA = new Proxy(pool, {
        get(target, prop, receiver) {
          if (prop === 'connect') {
            return async () => {
              const client = await target.connect();
              try {
                const result = await client.query<{ pid: number }>(
                  'SELECT pg_backend_pid() AS pid'
                );
                waiterPidA = result.rows[0].pid;
                return client;
              } catch (err) {
                client.release(true);
                throw err;
              }
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      // 3. الاحتفاظ بالوعود خارج try لإتاحة تنظيفها في finally
      let planUpdatePromiseA: Promise<unknown> | null = null;
      let consumptionPromiseA: Promise<unknown> | null = null;

      try {
        // إطلاق تعديل الخطة الحقيقي عبر updateCustomPlan والمجمع المعترض
        let planUpdateDoneA = false;
        planUpdatePromiseA = updateCustomPlan(
          interceptingPoolA,
          customPlan.id,
          accountId,
          { perRequestLimit: 20 }
        ).then((res) => {
          planUpdateDoneA = true;
          return res;
        });
        // 1. معالجة الرفض المبكرة لمنع unhandledRejection
        void planUpdatePromiseA.catch(() => {});

        // 2. انتظار حيازة تعديل الخطة للقفل مع مهلة زمنية قصوى
        await withTimeout(onLockAcquiredPromiseA, 3000, 'Test 3A lock acquisition signal');
        assert.ok(updateHolderPidA, 'Plan update holder PID must be captured');

        // إطلاق الاستهلاك الحقيقي بـ 8 وحدات عبر executeConsumption على مجمع رصد الانتظار
        let consumptionDoneA = false;
        consumptionPromiseA = executeConsumption(
          waiterPoolA,
          accountId,
          {
            userId,
            units: 8, // 8 أكبر من الحد القديم (5)، لكنه أصغر من الحد الجديد (20)
            requestId: 'req_order_a_001',
          },
          { clock: () => fixedDate }
        ).then((res) => {
          consumptionDoneA = true;
          return res;
        });
        // 1. معالجة الرفض المبكرة لمنع unhandledRejection
        void consumptionPromiseA.catch(() => {});

        // 4. رصد الحجب الفعلي للاتصال المنتظر المحدد بواسطة الاتصال الحاجز المحدد في PostgreSQL
        let detectedWaiterBlockingA = false;
        const startTimeA = Date.now();
        while (Date.now() - startTimeA < 3000) {
          if (waiterPidA) {
            const checkResult = await pool.query<{ blocked: boolean }>(
              'SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked',
              [updateHolderPidA, waiterPidA]
            );
            if (checkResult.rows[0]?.blocked) {
              detectedWaiterBlockingA = true;
              break;
            }
          }
          await sleep(20);
        }

        assert.equal(
          detectedWaiterBlockingA,
          true,
          `executeConsumption (PID ${waiterPidA}) must be provably blocked by updateCustomPlan (PID ${updateHolderPidA}) in pg_blocking_pids`
        );
        assert.equal(consumptionDoneA, false, 'Consumption must not complete while plan update holds the lock');

        // تحرير تعديل الخطة لتكتمل خطواته وتلتزم
        pauseUpdateResolverA();

        const updatedPlanA = (await planUpdatePromiseA) as { perRequestLimit: number };
        assert.equal(updatedPlanA.perRequestLimit, 20);

        // الآن يتحرر القفل وتكتمل عملية الاستهلاك الحقيقية
        const decisionA = (await consumptionPromiseA) as { accepted: boolean };
        assert.equal(
          decisionA.accepted,
          true,
          'Request of 8 units must be accepted under the newly committed limit of 20'
        );

        // فحص decision_context لإثبات أن القرار استند فعلياً إلى الحد الجديد (20)
        const recA = await pool.query<{ decision_context: DecisionContext }>(
          'SELECT decision_context FROM consumption_records WHERE account_id = $1 AND request_id = $2',
          [accountId, 'req_order_a_001']
        );
        assert.equal(recA.rows[0].decision_context.userPlan.perRequestLimit, 20);
        console.log(
          '✔ Test 3A: Plan update first (real execution) -> consumption waited (proven via specific pg_blocking_pids) and evaluated under new limits'
        );
      } finally {
        // 3. فتح بوابة الاستئناف دائماً وانتظار اكتمال العمليتين لمنع أي تعليق
        pauseUpdateResolverA();
        const settled = await Promise.allSettled(
          [planUpdatePromiseA, consumptionPromiseA].filter(Boolean)
        );
        for (const s of settled) {
          if (s.status === 'rejected') {
            console.error('Teardown notice in Test 3A operation:', s.reason);
          }
        }
      }

      // -----------------------------------------------------------------------
      // الترتيب ب: الاستهلاك يحجز قفل الحساب أولاً -> تعديل الخطة ينتظر القفل
      // الاستهلاك ينفّذ حقيقياً عبر executeConsumption، ويتم إيقافه مؤقتاً تحت القفل
      // لإثبات حجب updateCustomPlan في pg_blocking_pids، ثم يكتمل الاستهلاك بالحد القديم 20
      // -----------------------------------------------------------------------
      let consumptionHolderPid: number | null = null;
      let planWaiterPid: number | null = null;

      let pauseConsumptionResolver: () => void = () => {};
      const pauseConsumptionPromise = new Promise<void>((resolve) => {
        pauseConsumptionResolver = resolve;
      });

      let onLockAcquiredResolverB: () => void = () => {};
      const onLockAcquiredPromiseB = new Promise<void>((resolve) => {
        onLockAcquiredResolverB = resolve;
      });

      // مجمع معترض للاستهلاك: يعترض بعد حيازة القفل ويستعيد الدوال الأصلية دائماً
      const interceptingPoolB = new Proxy(pool, {
        get(target, prop, receiver) {
          if (prop === 'connect') {
            return async () => {
              const client = await target.connect();
              const originalQuery = client.query.bind(client);
              const originalRelease = client.release.bind(client);

              // 1. استعادة دالة query ودالة release الأصلية فور تحرير الاتصال
              client.release = (destroy?: boolean) => {
                client.query = originalQuery;
                client.release = originalRelease;
                return originalRelease(destroy);
              };

              (client as any).query = async (...args: any[]) => {
                const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? '';
                // اعتراض الاستعلام بعد حيازة القفل مباشرة لحفظ PID وتوقيف المعاملة مؤقتاً
                if (sql.includes('SELECT plan_id FROM accounts WHERE id = $1')) {
                  const pidRes = await originalQuery('SELECT pg_backend_pid() AS pid');
                  consumptionHolderPid = (pidRes as any).rows[0].pid;
                  onLockAcquiredResolverB();
                  await pauseConsumptionPromise;
                }
                return (originalQuery as any)(...args);
              };

              return client;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      // 4. مجمع لتعديل الخطة: يلتقط planWaiterPid الخاص به فور استعارة الاتصال مع حماية من التسريب
      const waiterPoolB = new Proxy(pool, {
        get(target, prop, receiver) {
          if (prop === 'connect') {
            return async () => {
              const client = await target.connect();
              try {
                const result = await client.query<{ pid: number }>(
                  'SELECT pg_backend_pid() AS pid'
                );
                planWaiterPid = result.rows[0].pid;
                return client;
              } catch (err) {
                client.release(true);
                throw err;
              }
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      // 3. الاحتفاظ بالوعود خارج try لإتاحة تنظيفها في finally
      let consumptionPromiseB: Promise<unknown> | null = null;
      let planUpdatePromiseB: Promise<unknown> | null = null;

      try {
        // إطلاق الاستهلاك الحقيقي عبر executeConsumption ومجمع الاتصالات المعترض
        consumptionPromiseB = executeConsumption(
          interceptingPoolB,
          accountId,
          {
            userId,
            units: 8,
            requestId: 'req_order_b_001',
          },
          { clock: () => fixedDate }
        );
        // 1. معالجة الرفض المبكرة لمنع unhandledRejection
        void consumptionPromiseB.catch(() => {});

        // 2. انتظار حيازة الاستهلاك للقفل واعتراضه مع مهلة زمنية قصوى
        await withTimeout(onLockAcquiredPromiseB, 3000, 'Test 3B lock acquisition signal');
        assert.ok(consumptionHolderPid, 'Consumption holder PID must be captured');

        // إطلاق تعديل الخطة الحقيقي عبر updateCustomPlan (لتخفيض الحد إلى 2) على مجمع رصد الانتظار
        let planUpdateDone = false;
        planUpdatePromiseB = updateCustomPlan(waiterPoolB, customPlan.id, accountId, {
          perRequestLimit: 2,
        }).then((res) => {
          planUpdateDone = true;
          return res;
        });
        // 1. معالجة الرفض المبكرة لمنع unhandledRejection
        void planUpdatePromiseB.catch(() => {});

        // 4. رصد حجب updateCustomPlan المحدد بواسطة executeConsumption المحدد في PostgreSQL
        let detectedPlanBlocking = false;
        const startTimeB = Date.now();
        while (Date.now() - startTimeB < 3000) {
          if (planWaiterPid) {
            const checkResult = await pool.query<{ blocked: boolean }>(
              'SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked',
              [consumptionHolderPid, planWaiterPid]
            );
            if (checkResult.rows[0]?.blocked) {
              detectedPlanBlocking = true;
              break;
            }
          }
          await sleep(20);
        }

        assert.equal(
          detectedPlanBlocking,
          true,
          `updateCustomPlan (PID ${planWaiterPid}) must be provably blocked by executeConsumption (PID ${consumptionHolderPid}) in pg_blocking_pids`
        );
        assert.equal(planUpdateDone, false, 'Plan update must not complete while consumption holds the lock');

        // تحرير الاستهلاك ليكمل خطواته تحت الحد القديم (20) ويلتزم
        pauseConsumptionResolver();

        const decisionB = (await consumptionPromiseB) as { accepted: boolean };
        assert.equal(decisionB.accepted, true, 'Consumption of 8 units must be accepted under old limit 20');

        // الآن يتحرر القفل وتكتمل عملية تعديل الخطة
        const updatedPlan = (await planUpdatePromiseB) as { perRequestLimit: number };
        assert.equal(updatedPlan.perRequestLimit, 2);

        // فحص سجل الاستهلاك للتأكد من أنه قُبل بالحد القديم 20
        const recB = await pool.query<{ decision_context: DecisionContext }>(
          'SELECT decision_context FROM consumption_records WHERE account_id = $1 AND request_id = $2',
          [accountId, 'req_order_b_001']
        );
        assert.equal(recB.rows[0].decision_context.userPlan.perRequestLimit, 20);

        console.log(
          '✔ Test 3B: Consumption first (real execution) -> plan update waited (proven via specific pg_blocking_pids) and old limit was preserved'
        );
      } finally {
        // 3. فتح بوابة الاستئناف دائماً وانتظار اكتمال العمليتين لمنع أي تعليق
        pauseConsumptionResolver();
        const settled = await Promise.allSettled(
          [consumptionPromiseB, planUpdatePromiseB].filter(Boolean)
        );
        for (const s of settled) {
          if (s.status === 'rejected') {
            console.error('Teardown notice in Test 3B operation:', s.reason);
          }
        }
      }
    }

    // =========================================================================
    // 4. اختبار استقلال الحسابات وعدم التعطيل المتبادل (Cross-Tenant Non-Blocking)
    // الإثبات: حجز قفل الحساب أ في معاملة مفتوحة غير ملتزمة، ثم إثبات أن استهلاك
    // الحساب ب يكتمل بنجاح قبل تحرير قفل الحساب أ، لتأكيد أن التنافس ينحصر على قفل نفس الحساب.
    // =========================================================================
    {
      const accountAId = `acc_tenant_a_${crypto.randomBytes(4).toString('hex')}`;
      const accountBId = `acc_tenant_b_${crypto.randomBytes(4).toString('hex')}`;
      const userBId = `usr_tenant_b_${crypto.randomBytes(4).toString('hex')}`;
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
        [accountBId, userBId]
      );

      // حجز قفل الحساب أ على اتصال صريح دون التزام المعاملة
      const clientA = await pool.connect();
      let primaryError: unknown = null;
      let clientDestroyed = false;
      try {
        await clientA.query('BEGIN');
        await clientA.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountAId]);

        // تنفيذ استهلاك على الحساب ب أثناء استمرار قفل الحساب أ
        const decisionB = await executeConsumption(
          pool,
          accountBId,
          {
            userId: userBId,
            units: 5,
            requestId: 'req_cross_tenant_b_001',
          },
          { clock: () => fixedDate }
        );

        // إثبات أن الحساب ب اكتمل بينما قفل أ ما زال محجوزاً
        assert.equal(decisionB.accepted, true);

        // التحقق من تحديث عداد الحساب ب في القاعدة بنجاح
        const bUsage = await pool.query<{ total_units: string }>(
          'SELECT total_units FROM account_monthly_usage WHERE account_id = $1',
          [accountBId]
        );
        assert.equal(Number(bUsage.rows[0].total_units), 5);

        console.log('✔ Test 4: Cross-tenant independence proven; Tenant B completed while Tenant A held its lock');
      } catch (err) {
        primaryError = err;
        throw err;
      } finally {
        // 5. محاولة التراجع دائماً في finally، وإتلاف الاتصال إذا فشل التراجع، وإظهار فشل التنظيف كفشل للاختبار إذا لم يوجد خطأ أصلي
        try {
          await clientA.query('ROLLBACK');
        } catch (rollbackErr) {
          clientDestroyed = true;
          clientA.release(true);
          if (!primaryError) {
            throw rollbackErr;
          } else {
            console.error('Secondary error during Test 4 ROLLBACK teardown:', rollbackErr);
          }
        } finally {
          if (!clientDestroyed) {
            clientA.release();
          }
        }
      }
    }

    // =========================================================================
    // 5. التحقق من سلامة المجمع وعدم تسريب الاتصالات (Pool Connection Health)
    // =========================================================================
    {
      assert.equal(pool.waitingCount, 0, 'No queries should be stuck in the connection waiting queue');
      assert.equal(pool.idleCount, pool.totalCount, 'All connections must be returned and idle in the pool');
      console.log('✔ Test 5: Connection pool is healthy with 0 waiting queries and all clients idle');
    }

    console.log('--- All Concurrency and Locks Tests (Part 21) Passed Successfully! ---');
  } finally {
    await pool.end();
  }
}

runConcurrencyAndLocksTests().catch((err) => {
  console.error('Concurrency and locks tests failed:', err);
  process.exit(1);
});

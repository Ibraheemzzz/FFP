// tests/plan-changes.test.ts
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { updateAccountPlan } from '../src/accounts.js';
import { buildApp } from '../src/app.js';
import { initEnvironment, loadConfig } from '../src/config.js';
import { createPool, withAccountLock } from '../src/db.js';
import { AccountNotFoundError } from '../src/errors.js';
import { runMigrations } from '../src/migrator.js';
import { type Plan, updateCustomPlan } from '../src/plans.js';
import { type User, updateUserPlan } from '../src/users.js';

function getDatabaseUrl(
  baseUrl: string,
  dbName: string,
  queryParams?: Record<string, string>
): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${dbName}`;
  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      parsed.searchParams.set(key, value);
    }
  }
  return parsed.toString();
}

/**
 * دالة مساعدة لاختبار انتظار القفل الحصري لكل عملية على حدة في بيئة معزولة:
 * - تنشئ مجموعة اتصالات منفصلة (waiterPool) خاصة بالعملية المنتظرة تحمل علامة مميزة في application_name
 * - تحجز قفل الحساب في اتصال مستقل تماماً (holderClient)
 * - تستخدم مجموعة الاتصالات الأساسية (testPool) لمراقبة ورصد علاقة الحجب في pg_stat_activity عبر pg_blocking_pids
 * - تضبط مهلة رصد أقصر بوضوح من statement_timeout
 * - تفك القفل وتتابع اكتمال العملية بنجاح مع تنظيف مضمون للاتصالات
 */
async function assertLockContentionForOperation(
  testPool: pg.Pool,
  dbUrl: string,
  accountId: string,
  operationName: string,
  runOperation: (waiterPool: pg.Pool) => Promise<void>
): Promise<void> {
  const holderClient = await testPool.connect();
  let holderCleanedUp = false;
  let testError: unknown = null;
  let cleanupError: unknown = null;

  const testTag = `waiter_${operationName}_${crypto.randomBytes(4).toString('hex')}`;
  const waiterPoolUrl = new URL(dbUrl);
  waiterPoolUrl.searchParams.set('application_name', testTag);
  const waiterPool = createPool(waiterPoolUrl.toString(), {
    max: 1,
    statementTimeoutMillis: 5000,
    queryTimeoutMillis: 7000,
  });

  // 1. تعريف مرجع opPromise بالخارج ليكون متاحاً في finally دائماً
  let opPromise: Promise<void> | undefined;
  let operationCompleted = false;

  try {
    // 2. حجز القفل الحصري على صف الحساب في الاتصال الحاجز المستقل
    const holderPidResult = await holderClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const holderPid = holderPidResult.rows[0].pid;

    await holderClient.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await holderClient.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);

    // 3. إطلاق العملية المنتظرة مع معالجة الرفض مبكراً لتفادي unhandledRejection
    opPromise = runOperation(waiterPool).then(() => {
      operationCompleted = true;
    });

    // معالجة الرفض مبكراً، مع إبقاء opPromise الأصلية
    // مرفوضة لكي يلتقط await خطأها لاحقاً.
    void opPromise.catch(() => {});

    // 4. رصد الحجب في pg_stat_activity بمهلة قابلة للضبط أقصر بوضوح من statement_timeout (5000ms)
    const OBSERVATION_TIMEOUT_MS = 1000;
    const pollIntervalMs = 25;
    const startTime = Date.now();
    let detectedWaiterBlocking = false;

    while (Date.now() - startTime < OBSERVATION_TIMEOUT_MS) {
      const checkResult = await testPool.query<{ pid: number }>(
        `SELECT pid
         FROM pg_stat_activity
         WHERE application_name = $1
           AND $2 = ANY(pg_blocking_pids(pid))`,
        [testTag, holderPid]
      );

      if ((checkResult.rowCount ?? 0) > 0) {
        detectedWaiterBlocking = true;
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    assert.equal(
      detectedWaiterBlocking,
      true,
      `Expected waiter operation '${operationName}' [${testTag}] to be blocked by holder PID ${holderPid}`
    );
    assert.equal(
      operationCompleted,
      false,
      `Operation '${operationName}' should not complete while holder maintains exclusive lock`
    );

    // 5. فك القفل عبر ROLLBACK لإنهاء حجز الاختبار في المسار الطبيعي
    await holderClient.query('ROLLBACK');
    holderCleanedUp = true;

    // 6. انتظار اكتمال العملية المنتظرة بعد تحرير القفل
    await opPromise;
    assert.equal(
      operationCompleted,
      true,
      `Operation '${operationName}' should complete after lock is released`
    );
  } catch (err) {
    testError = err;
  } finally {
    // الترتيب الصحيح للتنظيف:
    // أ. إنهاء معاملة الحاجز وفك القفل أولاً حتى لا تظل العملية المنتظرة عالقة
    if (!holderCleanedUp) {
      try {
        await holderClient.query('ROLLBACK');
        holderCleanedUp = true;
      } catch (err) {
        if (!cleanupError) {
          cleanupError = err;
        }
      }
    }

    // ب. تحرير اتصال الحاجز (سليماً إذا نجح التراجع، أو التخلص منه إذا فشل)
    try {
      holderClient.release(!holderCleanedUp);
    } catch (err) {
      if (!cleanupError) {
        cleanupError = err;
      }
    }

    // ج. انتظار استقرار نتيجة العملية المنتظرة بعد تحرير القفل (مع الحفاظ على الخطأ الأصلي)
    if (opPromise) {
      try {
        await opPromise;
      } catch (err) {
        if (!testError) {
          testError = err;
        }
      }
    }

    // د. إغلاق waiterPool بعد أن تكون عمليتها قد استقرت
    try {
      await waiterPool.end();
    } catch (err) {
      if (!cleanupError) {
        cleanupError = err;
      }
    }

    // هـ. إظهار الخطأ الأصلي وأخطاء التنظيف (وإفشال الاختبار إذا فشل التنظيف دون وجود خطأ سابق)
    if (cleanupError) {
      console.error(`Cleanup failed for operation '${operationName}':`, cleanupError);
      if (!testError) {
        throw cleanupError;
      }
    }

    if (testError) {
      throw testError;
    }
  }
}

async function runPlanChangesTests(): Promise<void> {
  initEnvironment();
  const config = loadConfig();

  const adminPool = createPool(config.DATABASE_URL);
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const TEST_DB_NAME = `usage_metering_plan_changes_test_${Date.now()}_${randomSuffix}`;

  let isDatabaseCreated = false;
  let testPool: pg.Pool | undefined;
  let app: FastifyInstance | undefined;
  let testExecutionError: unknown = null;

  try {
    // 1. إنشاء قاعدة بيانات اختبار معزولة وتطبيق المهاجرات
    await adminPool.query(`CREATE DATABASE ${TEST_DB_NAME}`);
    isDatabaseCreated = true;

    const testDbBaseUrl = getDatabaseUrl(config.DATABASE_URL, TEST_DB_NAME);
    testPool = createPool(testDbBaseUrl, {
      max: 10,
      statementTimeoutMillis: 5000,
      queryTimeoutMillis: 7000,
    });
    await runMigrations(testPool);

    const testApp = buildApp({
      checkHealth: async () => true,
      pool: testPool,
    });
    app = testApp;

    // 2. تسجيل حسابين مستقلين: Account A و Account B
    const createAccARes = await app.inject({
      method: 'POST',
      url: '/accounts',
      payload: { name: 'Account A' },
    });
    assert.equal(createAccARes.statusCode, 201);
    const accountA = JSON.parse(createAccARes.body) as { id: string; apiKey: string };

    const createAccBRes = await app.inject({
      method: 'POST',
      url: '/accounts',
      payload: { name: 'Account B' },
    });
    assert.equal(createAccBRes.statusCode, 201);
    const accountB = JSON.parse(createAccBRes.body) as { id: string; apiKey: string };

    // =========================================================================
    // الاختبار 1: الأثر الفوري بعد تعديل الخطة عبر PATCH /plans/:planId
    // =========================================================================
    {
      // إنشاء خطة خاصة بالحساب A
      const createPlanRes = await app.inject({
        method: 'POST',
        url: '/plans',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: {
          name: 'Account A Custom Tier',
          type: 'ACCOUNT',
          monthlyLimit: 1000,
          perRequestLimit: 100,
        },
      });
      assert.equal(createPlanRes.statusCode, 201);
      const planA = JSON.parse(createPlanRes.body) as Plan;

      // تعديل حدود الخطة
      const updatePlanRes = await app.inject({
        method: 'PATCH',
        url: `/plans/${planA.id}`,
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: {
          monthlyLimit: 2500,
          perRequestLimit: 250,
        },
      });
      assert.equal(updatePlanRes.statusCode, 200);
      const updatedPlan = JSON.parse(updatePlanRes.body) as Plan;
      assert.equal(updatedPlan.monthlyLimit, 2500);
      assert.equal(updatedPlan.perRequestLimit, 250);

      // التحقق من أن القراءة الفورية التالية ترى الحدود الجديدة مباشرة
      const getPlanRes = await app.inject({
        method: 'GET',
        url: `/plans/${planA.id}`,
        headers: { authorization: `Bearer ${accountA.apiKey}` },
      });
      assert.equal(getPlanRes.statusCode, 200);
      const fetchedPlan = JSON.parse(getPlanRes.body) as Plan;
      assert.equal(fetchedPlan.monthlyLimit, 2500);
      assert.equal(fetchedPlan.perRequestLimit, 250);

      console.log('✔ Test 1 passed: Immediate visibility of updated plan limits');
    }

    // =========================================================================
    // الاختبار 2: تعديل خطة مشتركة ينعكس فوراً على جميع المستخدمين المسندين لها
    // =========================================================================
    {
      // إنشاء خطة مستخدمين خاصة مشتركة
      const createSharedPlanRes = await app.inject({
        method: 'POST',
        url: '/plans',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: {
          name: 'Shared Team Plan',
          type: 'USER',
          monthlyLimit: 500,
          perRequestLimit: 50,
        },
      });
      assert.equal(createSharedPlanRes.statusCode, 201);
      const sharedPlan = JSON.parse(createSharedPlanRes.body) as Plan;

      // إنشاء مستخدمين وإسناد الخطة المشتركة لهما
      const user1Res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: { externalId: 'ext_user_1', planId: sharedPlan.id },
      });
      assert.equal(user1Res.statusCode, 201);
      const user1 = JSON.parse(user1Res.body) as User;

      const user2Res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: { externalId: 'ext_user_2', planId: sharedPlan.id },
      });
      assert.equal(user2Res.statusCode, 201);
      const user2 = JSON.parse(user2Res.body) as User;

      // تعديل الخطة المشتركة برفع الحدود
      const updateSharedPlanRes = await app.inject({
        method: 'PATCH',
        url: `/plans/${sharedPlan.id}`,
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: {
          monthlyLimit: 1200,
          perRequestLimit: 120,
        },
      });
      assert.equal(updateSharedPlanRes.statusCode, 200);

      // التأكد عبر GET /users/:userId من بقاء الإسناد لنفس الخطة
      const getUser1Res = await app.inject({
        method: 'GET',
        url: `/users/${user1.id}`,
        headers: { authorization: `Bearer ${accountA.apiKey}` },
      });
      assert.equal(getUser1Res.statusCode, 200);
      assert.equal((JSON.parse(getUser1Res.body) as User).planId, sharedPlan.id);

      const getUser2Res = await app.inject({
        method: 'GET',
        url: `/users/${user2.id}`,
        headers: { authorization: `Bearer ${accountA.apiKey}` },
      });
      assert.equal(getUser2Res.statusCode, 200);
      assert.equal((JSON.parse(getUser2Res.body) as User).planId, sharedPlan.id);

      // التأكد عبر استعلام ربط اختباري مباشر (SQL JOIN) باستخدام أسماء الأعمدة المعتمدة
      const joinResult = await testPool.query<{
        id: string;
        plan_id: string;
        monthly_limit: string;
        per_request_limit: string;
      }>(
        `SELECT u.id, u.plan_id, p.monthly_limit, p.per_request_limit
         FROM users u
         JOIN plans p ON u.plan_id = p.id
         WHERE u.account_id = $1 AND u.id IN ($2, $3)`,
        [accountA.id, user1.id, user2.id]
      );

      assert.equal(joinResult.rows.length, 2);
      for (const row of joinResult.rows) {
        assert.equal(row.plan_id, sharedPlan.id);
        assert.equal(Number(row.monthly_limit), 1200);
        assert.equal(Number(row.per_request_limit), 120);
      }

      console.log('✔ Test 2 passed: Shared plan modification immediately visible to multiple assigned users');
    }

    // =========================================================================
    // الاختبار 3: خفض الخطة دون الاستهلاك الحالي لا يصفّر ولا يُعدّل total_units
    // =========================================================================
    {
      // إنشاء خطة حساب مع استهلاك مسبق
      const createAccPlanRes = await app.inject({
        method: 'POST',
        url: '/plans',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: {
          name: 'Downgrade Target Plan',
          type: 'ACCOUNT',
          monthlyLimit: 1000,
          perRequestLimit: 200,
        },
      });
      assert.equal(createAccPlanRes.statusCode, 201);
      const accPlan = JSON.parse(createAccPlanRes.body) as Plan;

      await app.inject({
        method: 'PATCH',
        url: '/account/plan',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: { planId: accPlan.id },
      });

      // زرع استهلاك شهري غير صفري للحساب وللمستخدم
      const currentMonth = '2026-10';
      await testPool.query(
        `INSERT INTO account_monthly_usage (account_id, year_month, total_units)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id, year_month) DO UPDATE SET total_units = EXCLUDED.total_units`,
        [accountA.id, currentMonth, 850]
      );

      // زرع استهلاك لمستخدم
      const testUserRes = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: { externalId: 'user_downgrade_test' },
      });
      assert.equal(testUserRes.statusCode, 201);
      const testUser = JSON.parse(testUserRes.body) as User;

      await testPool.query(
        `INSERT INTO user_monthly_usage (account_id, user_id, year_month, total_units)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, year_month) DO UPDATE SET total_units = EXCLUDED.total_units`,
        [accountA.id, testUser.id, currentMonth, 450]
      );

      // خفض حدود خطة الحساب إلى 300 (أقل من 850 المستهلكة)
      const downgradeAccPlanRes = await app.inject({
        method: 'PATCH',
        url: `/plans/${accPlan.id}`,
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: { monthlyLimit: 300 },
      });
      assert.equal(downgradeAccPlanRes.statusCode, 200);

      // التحقق من بقاء الاستهلاك التراكمي للحساب دون تغيير
      const accUsageCheck = await testPool.query<{ total_units: string }>(
        `SELECT total_units FROM account_monthly_usage WHERE account_id = $1 AND year_month = $2`,
        [accountA.id, currentMonth]
      );
      assert.equal(Number(accUsageCheck.rows[0].total_units), 850);

      // التحقق من بقاء الاستهلاك التراكمي للمستخدم دون تغيير
      const userUsageCheck = await testPool.query<{ total_units: string }>(
        `SELECT total_units FROM user_monthly_usage WHERE user_id = $1 AND year_month = $2`,
        [testUser.id, currentMonth]
      );
      assert.equal(Number(userUsageCheck.rows[0].total_units), 450);

      console.log('✔ Test 3 passed: Plan downgrade below current consumption preserves historical total_units intact');
    }

    // =========================================================================
    // الاختبار 4: إثبات دقيق لانتظار العمليات الثلاث للقفل وفك الحجز بعد ROLLBACK
    // =========================================================================
    {
      // 4.1 إثبات انتظار updateCustomPlan عبر waiterPool مستقل
      const customPlanRes = await app.inject({
        method: 'POST',
        url: '/plans',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: {
          name: 'Lock Test Plan',
          type: 'ACCOUNT',
          monthlyLimit: 700,
          perRequestLimit: 70,
        },
      });
      assert.equal(customPlanRes.statusCode, 201);
      const lockTestPlan = JSON.parse(customPlanRes.body) as Plan;

      await assertLockContentionForOperation(
        testPool,
        testDbBaseUrl,
        accountA.id,
        'updateCustomPlan',
        async (waiterPool) => {
          await updateCustomPlan(waiterPool, lockTestPlan.id, accountA.id, {
            monthlyLimit: 750,
          });
        }
      );

      // 4.2 إثبات انتظار updateAccountPlan عبر waiterPool مستقل
      await assertLockContentionForOperation(
        testPool,
        testDbBaseUrl,
        accountA.id,
        'updateAccountPlan',
        async (waiterPool) => {
          await updateAccountPlan(waiterPool, accountA.id, lockTestPlan.id);
        }
      );

      // 4.3 إثبات انتظار updateUserPlan عبر waiterPool مستقل
      const lockUserRes = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: { externalId: 'lock_test_user' },
      });
      assert.equal(lockUserRes.statusCode, 201);
      const lockUser = JSON.parse(lockUserRes.body) as User;

      const userPlanRes = await app.inject({
        method: 'POST',
        url: '/plans',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: {
          name: 'Lock Test User Plan',
          type: 'USER',
          monthlyLimit: 300,
          perRequestLimit: 30,
        },
      });
      assert.equal(userPlanRes.statusCode, 201);
      const lockUserPlan = JSON.parse(userPlanRes.body) as Plan;

      await assertLockContentionForOperation(
        testPool,
        testDbBaseUrl,
        accountA.id,
        'updateUserPlan',
        async (waiterPool) => {
          await updateUserPlan(waiterPool, lockUser.id, accountA.id, lockUserPlan.id);
        }
      );

      console.log('✔ Test 4 passed: Provable lock contention and clean unblocking for all three operations');
    }

    // =========================================================================
    // الاختبار 5: استمرار الحسابات الأخرى دون انتظار عند قفل حساب مختلف (Cross-Tenant Non-Blocking)
    // =========================================================================
    {
      const holderClient = await testPool.connect();
      let holderCleanedUp = false;

      try {
        await holderClient.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await holderClient.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountA.id]);

        // Account B ينفذ تعديل خطة حسابه بالتزامن دون أن يتعطل أو ينتظر
        const updateBRes = await app.inject({
          method: 'PATCH',
          url: '/account/plan',
          headers: { authorization: `Bearer ${accountB.apiKey}` },
          payload: { planId: 'plan_default_account' },
        });

        assert.equal(updateBRes.statusCode, 200);

        // Account B ينشئ ويعدل خطة خاصة به بنجاح فوري
        const createBPlanRes = await app.inject({
          method: 'POST',
          url: '/plans',
          headers: { authorization: `Bearer ${accountB.apiKey}` },
          payload: {
            name: 'Account B Independent Plan',
            type: 'ACCOUNT',
            monthlyLimit: 5000,
            perRequestLimit: 500,
          },
        });
        assert.equal(createBPlanRes.statusCode, 201);
        const planB = JSON.parse(createBPlanRes.body) as Plan;

        const updateBPlanRes = await app.inject({
          method: 'PATCH',
          url: `/plans/${planB.id}`,
          headers: { authorization: `Bearer ${accountB.apiKey}` },
          payload: { monthlyLimit: 6000 },
        });
        assert.equal(updateBPlanRes.statusCode, 200);

        await holderClient.query('ROLLBACK');
        holderCleanedUp = true;
      } finally {
        if (!holderCleanedUp) {
          try {
            await holderClient.query('ROLLBACK');
            holderCleanedUp = true;
          } catch {
            // handle error
          }
        }
        holderClient.release(!holderCleanedUp);
      }

      console.log('✔ Test 5 passed: Cross-tenant non-blocking execution verified');
    }

    // =========================================================================
    // الاختبار 6: التراجع الذري عن التعديلات الفعلية عند حدوث فشل قبل الالتزام
    // =========================================================================
    {
      const initialAccountCheck = await testPool.query<{ plan_id: string }>(
        'SELECT plan_id FROM accounts WHERE id = $1',
        [accountA.id]
      );
      const originalPlanId = initialAccountCheck.rows[0].plan_id;

      // إنشاء خطة حساب مميزة للتأكد أن القيمة المكتوبة تختلف قطعياً عن القيمة الحالية
      const rollbackProbeRes = await app.inject({
        method: 'POST',
        url: '/plans',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: {
          name: 'Rollback Probe Plan',
          type: 'ACCOUNT',
          monthlyLimit: 9999,
          perRequestLimit: 999,
        },
      });
      assert.equal(rollbackProbeRes.statusCode, 201);
      const rollbackProbePlan = JSON.parse(rollbackProbeRes.body) as Plan;
      const distinctNewPlanId = rollbackProbePlan.id;

      // إثبات أن القيمة التي ستُكتب مختلفة تماماً عن القيمة الأصلية المسجلة
      assert.notEqual(
        distinctNewPlanId,
        originalPlanId,
        'distinctNewPlanId must be strictly different from originalPlanId to prove genuine rollback'
      );

      let errorCaught = false;
      try {
        await withAccountLock(testPool!, accountA.id, async (client) => {
          // كتابة فعلية تغير القيمة في قاعدة البيانات أثناء المعاملة
          await client.query('UPDATE accounts SET plan_id = $1 WHERE id = $2', [
            distinctNewPlanId,
            accountA.id,
          ]);
          // محاكاة خطأ فادح قبل إتمام المعاملة
          throw new Error('Simulated atomic failure before commit');
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'Simulated atomic failure before commit') {
          errorCaught = true;
        }
      }

      assert.equal(errorCaught, true, 'Expected simulated error to be thrown by transaction runner');

      // التحقق من أن قاعدة البيانات تراجعت عن التعديل تماماً وبقيت القيمة الأصلية ولم تستقر القيمة الجديدة
      const verifyAccountCheck = await testPool.query<{ plan_id: string }>(
        'SELECT plan_id FROM accounts WHERE id = $1',
        [accountA.id]
      );
      assert.equal(verifyAccountCheck.rows[0].plan_id, originalPlanId);
      assert.notEqual(verifyAccountCheck.rows[0].plan_id, distinctNewPlanId);

      console.log('✔ Test 6 passed: Atomic rollback verified upon failure before commit (with proven distinct planId)');
    }

    // =========================================================================
    // الاختبار 7: التحقق من معالجة AccountNotFoundError (404) في المسارات الثلاثة عند غياب الحساب
    // =========================================================================
    {
      const nonExistentAccountId = 'acc_non_existent_000000000000';

      // 7.1 withAccountLock يرمي AccountNotFoundError مباشرة
      let notFoundThrown = false;
      try {
        await withAccountLock(testPool!, nonExistentAccountId, async () => {
          // should not be reached
        });
      } catch (err) {
        if (err instanceof AccountNotFoundError) {
          notFoundThrown = true;
        }
      }
      assert.equal(notFoundThrown, true, 'Expected AccountNotFoundError when locking missing account');

      // 7.2 فحص معالجة المسارات لغياب الحساب
      // استدعاء الدوال مباشرة بحساب غير موجود
      await assert.rejects(
        () => updateCustomPlan(testPool!, 'any_plan', nonExistentAccountId, { name: 'New' }),
        AccountNotFoundError
      );

      await assert.rejects(
        () => updateAccountPlan(testPool!, nonExistentAccountId, 'any_plan'),
        AccountNotFoundError
      );

      await assert.rejects(
        () => updateUserPlan(testPool!, 'any_user', nonExistentAccountId, 'any_plan'),
        AccountNotFoundError
      );

      console.log('✔ Test 7 passed: Missing account handled safely with AccountNotFoundError across all three operations');
    }

    console.log('\nAll plan change, locking, and immediate effect tests passed successfully.');
  } catch (error) {
    testExecutionError = error;
    console.error('Test suite failed with error:', error);
  } finally {
    if (app) {
      await app.close();
    }
    if (testPool) {
      await testPool.end();
    }
    if (isDatabaseCreated) {
      try {
        await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
      } catch {
        console.error(`Failed to drop test database: ${TEST_DB_NAME}`);
      }
    }
    await adminPool.end();

    if (testExecutionError) {
      process.exit(1);
    }
  }
}

void runPlanChangesTests();

// tests/usage.test.ts
// اختبارات مسارات قراءة الاستخدام الحالي (Part 23: Get Current Usage API)

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type pg from 'pg';
import { initEnvironment, loadConfig } from '../src/config.js';
import { createPool, checkDatabaseHealth } from '../src/db.js';
import { runMigrations } from '../src/migrator.js';
import { buildApp } from '../src/app.js';
import { executeConsumption } from '../src/consumptions.js';
import { createCustomPlan, updateCustomPlan } from '../src/plans.js';
import type { AccountUsageResponse, UserUsageResponse } from '../src/types.js';

/**
 * دالة مساعدة لإنشاء وعد مؤجل (Deferred Promise) مع إمكانية استدعاء resolve و reject
 */
function createDeferredPromise<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * غلاف لربط الوعد بمهلة زمنية قاطعة لمنع التعليق
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

import { createAccount } from '../src/accounts.js';
import { createUser } from '../src/users.js';

/**
 * دالة مساعدة لإنشاء حساب مع مفتاح API صالح عبر دالة createAccount
 */
async function createTestAccount(
  pool: pg.Pool,
  name: string,
  planId = 'plan_default_account'
): Promise<{ accountId: string; apiKey: string }> {
  const account = await createAccount(pool, { name, planId });
  return { accountId: account.id, apiKey: account.apiKey };
}

/**
 * دالة مساعدة لإنشاء مستخدم تحت حساب معين عبر دالة createUser
 */
async function createTestUser(
  pool: pg.Pool,
  accountId: string,
  planId = 'plan_default_user'
): Promise<{ userId: string }> {
  const user = await createUser(pool, accountId, { planId });
  return { userId: user.id };
}

async function runUsageTests(): Promise<void> {
  console.log('--- Starting Get Current Usage API Tests (Part 23) ---');

  initEnvironment();
  const config = loadConfig();

  const pool = createPool(config.DATABASE_URL, {
    max: 20,
    connectionTimeoutMillis: 10000,
    statementTimeoutMillis: 15000,
    queryTimeoutMillis: 20000,
  });

  const app = buildApp({
    checkHealth: () => checkDatabaseHealth(pool),
    pool,
  });

  try {
    await runMigrations(pool);

    // =========================================================================
    // 1. اختبار استرجاع استخدام الحساب الجديد (New Account Current Usage)
    // الحساب لم يستهلك أي شيء: المستهلك = 0، والمتبقي = كامل سقف الخطة
    // =========================================================================
    {
      const { accountId, apiKey } = await createTestAccount(pool, 'New Fresh Account');

      const response = await app.inject({
        method: 'GET',
        url: '/account/usage',
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as AccountUsageResponse;

      assert.equal(body.accountId, accountId);
      assert.match(body.yearMonth, /^[0-9]{4}-(0[1-9]|1[0-2])$/);
      assert.equal(body.plan.id, 'plan_default_account');
      assert.equal(body.plan.type, 'ACCOUNT');
      assert.equal(body.plan.monthlyLimit, 100000);
      assert.equal(body.plan.perRequestLimit, 1000);
      assert.equal(body.usage.consumed, 0);
      assert.equal(body.usage.remaining, 100000);

      console.log('✔ Test 1: New account returns 0 consumed and full plan limit remaining');
    }

    // =========================================================================
    // 2. اختبار استرجاع استخدام الحساب بعد عمليات استهلاك حقيقية
    // استهلاك 40 وحدة ثم 25 وحدة -> المستهلك = 65، والمتبقي = 99935
    // =========================================================================
    {
      const { accountId, apiKey } = await createTestAccount(pool, 'Active Account');
      const { userId } = await createTestUser(pool, accountId);

      await executeConsumption(pool, accountId, {
        userId,
        units: 40,
        requestId: 'req_usage_act_001',
      });

      await executeConsumption(pool, accountId, {
        userId,
        units: 25,
        requestId: 'req_usage_act_002',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/account/usage',
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as AccountUsageResponse;

      assert.equal(body.accountId, accountId);
      assert.equal(body.usage.consumed, 65);
      assert.equal(body.usage.remaining, 100000 - 65);

      console.log('✔ Test 2: Account usage accurately tracks cumulative consumption and calculates remaining');
    }

    // =========================================================================
    // 3. اختبار استرجاع استخدام المستخدم وحصته المشتركة مع حسابه
    // GET /users/:userId/usage يعيد لقطة شاملة للمستخدم والحساب معاً
    // =========================================================================
    {
      const { accountId, apiKey } = await createTestAccount(pool, 'User Parent Account');
      const { userId: userA } = await createTestUser(pool, accountId);
      const { userId: userB } = await createTestUser(pool, accountId);

      // User A يستهلك 30 وحدة
      await executeConsumption(pool, accountId, {
        userId: userA,
        units: 30,
        requestId: 'req_usage_usr_001',
      });

      // User B يستهلك 50 وحدة
      await executeConsumption(pool, accountId, {
        userId: userB,
        units: 50,
        requestId: 'req_usage_usr_002',
      });

      // فحص استخدام User A
      const response = await app.inject({
        method: 'GET',
        url: `/users/${userA}/usage`,
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as UserUsageResponse;

      assert.equal(body.userId, userA);
      assert.equal(body.accountId, accountId);
      assert.match(body.yearMonth, /^[0-9]{4}-(0[1-9]|1[0-2])$/);

      // خطة واستخدام المستخدم أ
      assert.equal(body.userPlan.id, 'plan_default_user');
      assert.equal(body.userPlan.type, 'USER');
      assert.equal(body.userPlan.monthlyLimit, 10000);
      assert.equal(body.userUsage.consumed, 30);
      assert.equal(body.userUsage.remaining, 10000 - 30);

      // خطة واستخدام الحساب المشترك (30 + 50 = 80)
      assert.equal(body.accountPlan.id, 'plan_default_account');
      assert.equal(body.accountPlan.type, 'ACCOUNT');
      assert.equal(body.accountPlan.monthlyLimit, 100000);
      assert.equal(body.accountUsage.consumed, 80);
      assert.equal(body.accountUsage.remaining, 100000 - 80);

      console.log('✔ Test 3: User usage correctly returns unified atomic snapshot of user and shared account quota');
    }

    // =========================================================================
    // 4. اختبار سقف الصفر الأدنى للمتبقي عند خفض الخطة تحت الرصيد المستهلك (Flooring at 0)
    // =========================================================================
    {
      const { accountId, apiKey } = await createTestAccount(pool, 'Downgraded Account');

      // إنشاء خطة مخصصة للحساب بحد شهري 100 وحدة وسقف طلب 100 وحدة
      const customPlan = await createCustomPlan(pool, accountId, {
        name: 'Initial 100 Plan',
        type: 'ACCOUNT',
        monthlyLimit: 100,
        perRequestLimit: 100,
      });

      await pool.query('UPDATE accounts SET plan_id = $1 WHERE id = $2', [customPlan.id, accountId]);

      const { userId } = await createTestUser(pool, accountId);

      // استهلاك 80 وحدة
      await executeConsumption(pool, accountId, {
        userId,
        units: 80,
        requestId: 'req_usage_dg_001',
      });

      // خفض سقف الخطة المخصصة إلى 50 وحدة (أقل من المستهلك 80)
      await updateCustomPlan(pool, customPlan.id, accountId, {
        monthlyLimit: 50,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/account/usage',
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as AccountUsageResponse;

      assert.equal(body.plan.monthlyLimit, 50);
      assert.equal(body.usage.consumed, 80);
      // المتبقي يجب أن يتوقف عند 0 ولا يكون سالباً إطلاقاً (-30 مرفوض)
      assert.equal(body.usage.remaining, 0, 'Remaining must be floored at 0 and never be negative');

      console.log('✔ Test 4: Remaining quota floored at 0 on plan downgrade without corrupting consumed total');
    }

    // =========================================================================
    // 5. اختبار رفض أي معاملات استعلام (Query Parameters Rejection) لمنع إيهام العميل
    // أي تمرير لـ ?month=2026-09 أو غيرها يُرفض بـ 400 Bad Request
    // =========================================================================
    {
      const { accountId, apiKey } = await createTestAccount(pool, 'Query Test Account');
      const { userId } = await createTestUser(pool, accountId);

      // محاولة تمرير ?month إلى /account/usage
      const resAccountMonth = await app.inject({
        method: 'GET',
        url: '/account/usage?month=2026-09',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(resAccountMonth.statusCode, 400);
      const errAcc = JSON.parse(resAccountMonth.body);
      assert.ok(errAcc.error.includes('Query parameters are not supported'));

      // محاولة تمرير ?month إلى /users/:userId/usage
      const resUserMonth = await app.inject({
        method: 'GET',
        url: `/users/${userId}/usage?month=2026-09`,
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(resUserMonth.statusCode, 400);
      const errUsr = JSON.parse(resUserMonth.body);
      assert.ok(errUsr.error.includes('Query parameters are not supported'));

      // محاولة تمرير أي استعلام غير معرّف مثل ?foo=bar
      const resFoo = await app.inject({
        method: 'GET',
        url: '/account/usage?foo=bar',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(resFoo.statusCode, 400);

      console.log('✔ Test 5: Passing ?month or extraneous query params is strictly rejected with 400 Bad Request');
    }

    // =========================================================================
    // 6. اختبار العزل الصارم بين المستأجرين (Tenant Isolation)
    // الحساب أ لا يستطيع استعراض استخدام مستخدم تابع للحساب ب -> 404 Not Found
    // =========================================================================
    {
      const { accountId: accountA, apiKey: keyA } = await createTestAccount(pool, 'Tenant A');
      const { accountId: accountB, apiKey: keyB } = await createTestAccount(pool, 'Tenant B');
      const { userId: userB } = await createTestUser(pool, accountB);

      // الحساب أ يحاول قراءة استخدام المستخدم التابع للحساب ب
      const foreignRes = await app.inject({
        method: 'GET',
        url: `/users/${userB}/usage`,
        headers: { authorization: `Bearer ${keyA}` },
      });

      assert.equal(foreignRes.statusCode, 404, 'Must return 404 for foreign user to prevent information leak');
      assert.deepEqual(JSON.parse(foreignRes.body), { error: 'User not found' });

      // بينما الحساب ب المالك الحقيقي يستطيع القراءة بـ 200 OK
      const ownerRes = await app.inject({
        method: 'GET',
        url: `/users/${userB}/usage`,
        headers: { authorization: `Bearer ${keyB}` },
      });
      assert.equal(ownerRes.statusCode, 200);

      // محاولة قراءة مستخدم وهمي غير موجود إطلاقاً -> 404
      const nonExistentRes = await app.inject({
        method: 'GET',
        url: '/users/usr_non_existent_12345/usage',
        headers: { authorization: `Bearer ${keyA}` },
      });
      assert.equal(nonExistentRes.statusCode, 404);

      console.log('✔ Test 6: Cross-tenant access strictly blocked with 404 Not Found (zero information leak)');
    }

    // =========================================================================
    // 7. اختبار التحقق من المصادقة (Authentication Enforcement)
    // =========================================================================
    {
      const { accountId } = await createTestAccount(pool, 'Auth Test Account');
      const { userId } = await createTestUser(pool, accountId);

      // غياب الترويسة
      const noAuthRes = await app.inject({
        method: 'GET',
        url: '/account/usage',
      });
      assert.equal(noAuthRes.statusCode, 401);

      // مفتاح غير صالح
      const invalidAuthRes = await app.inject({
        method: 'GET',
        url: `/users/${userId}/usage`,
        headers: { authorization: 'Bearer invalid_secret_key_123' },
      });
      assert.equal(invalidAuthRes.statusCode, 401);

      console.log('✔ Test 7: Missing or invalid API key strictly rejected with 401 Unauthorized');
    }

    // =========================================================================
    // 8. اختبار اتساق القراءة واللقطة المضبوط (Snapshot Isolation & Consistency Test)
    // التوجيه الصريح:
    // 1. تعليق استهلاك حقيقي مؤقتاً فور تحديث عداد الحساب وقبل تحديث عداد المستخدم.
    // 2. قراءة الاستخدام من اتصال آخر: يجب أن يرى القيم القديمة الملتزمة للطرفين (لا يرى تحديث الحساب وحده).
    // 3. استئناف الاستهلاك وإنهاؤه بـ COMMIT: القراءة اللاحقة ترى القيمتين الجديدتين الملتزمتين.
    // 4. مهلة لإشارة التعليق، معالجة رفض مبكرة، واستئناف وتنظيف كامل في finally حتى لو فشل الاختبار.
    // =========================================================================
    {
      const { accountId, apiKey } = await createTestAccount(pool, 'Consistency Account');
      const { userId } = await createTestUser(pool, accountId);

      // 1. استهلاك مبدئي لتثبيت عدادات معلومة (10 وحدات)
      await executeConsumption(pool, accountId, {
        userId,
        units: 10,
        requestId: 'req_iso_init_001',
      });

      // التحقق من أن الاستهلاك المبدئي = 10 للطرفين
      const initialUsage = await app.inject({
        method: 'GET',
        url: `/users/${userId}/usage`,
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(initialUsage.statusCode, 200);
      const initBody = JSON.parse(initialUsage.body) as UserUsageResponse;
      assert.equal(initBody.accountUsage.consumed, 10);
      assert.equal(initBody.userUsage.consumed, 10);

      // إشارات المزامنة للتعليق والاستئناف
      const suspendedSignal = createDeferredPromise<void>();
      const resumeSignal = createDeferredPromise<void>();
      let interceptedClient: pg.PoolClient | null = null;
      let originalClientQuery: ((...args: any[]) => any) | null = null;

      // إنشاء مجمع معترض حصري لعملية الاستهلاك عبر Proxy دون المساس بـ pool الأصلي المستخدم من Fastify
      const consumptionPool = new Proxy(pool, {
        get(target, prop, receiver) {
          if (prop === 'connect') {
            return async () => {
              const client = await target.connect();
              interceptedClient = client;
              const originalQuery = client.query.bind(client);
              originalClientQuery = originalQuery;
              const originalRelease = client.release.bind(client);

              client.release = (destroy?: boolean) => {
                client.query = originalQuery;
                client.release = originalRelease;
                return originalRelease(destroy);
              };

              (client as any).query = async (...args: any[]) => {
                const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? '';

                if (sql.includes('INSERT INTO user_monthly_usage')) {
                  suspendedSignal.resolve();
                  await resumeSignal.promise;
                }

                return (originalQuery as any)(...args);
              };

              return client;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      // إطلاق الاستهلاك الجديد (بمقدار 5 وحدات) عبر consumptionPool المعترض
      const consumptionPromise = executeConsumption(consumptionPool, accountId, {
        userId,
        units: 5,
        requestId: 'req_iso_test_002',
      });

      // معالجة الرفض المبكرة لمنع unhandledRejection في حال حدث خطأ أثناء التعليق
      void consumptionPromise.catch(() => {});

      try {
        // انتظار تعليق العملية مع مهلة زمنية قاطعة (5000ms)
        await withTimeout(
          suspendedSignal.promise,
          5000,
          'Timed out waiting for consumption transaction to pause after account counter update'
        );

        // في هذه اللحظة بالذات:
        // المعاملة حدّثت account_monthly_usage ولكن لم تُحدّث user_monthly_usage ولم تنفذ COMMIT بعد.
        // نقوم بقراءة الاستخدام الحالي عبر اتصال مستقل تماماً من التطبيق:
        const midFlightResponse = await app.inject({
          method: 'GET',
          url: `/users/${userId}/usage`,
          headers: { authorization: `Bearer ${apiKey}` },
        });

        assert.equal(midFlightResponse.statusCode, 200);
        const midFlightBody = JSON.parse(midFlightResponse.body) as UserUsageResponse;

        // إثبات اتساق اللقطة (Snapshot Isolation):
        // القراءة لا ترى التحديث غير الملتزم لعداد الحساب؛ كلاهما يظهر 10 (القيم السابقة الملتزمة)
        assert.equal(
          midFlightBody.accountUsage.consumed,
          10,
          'Account usage must show committed value 10, not uncommitted in-flight value 15'
        );
        assert.equal(
          midFlightBody.userUsage.consumed,
          10,
          'User usage must show committed value 10'
        );
        assert.equal(midFlightBody.accountUsage.remaining, 100000 - 10);
        assert.equal(midFlightBody.userUsage.remaining, 10000 - 10);

        // إعطاء إشارة الاستئناف لإكمال المعاملة
        resumeSignal.resolve();

        // انتظار انتهاء المعاملة بنجاح
        const decision = await withTimeout(
          consumptionPromise,
          5000,
          'Timed out waiting for resumed consumption to finish'
        );
        assert.equal(decision.accepted, true);
        assert.equal(decision.account.consumed, 15);
        assert.equal(decision.user.consumed, 15);

        // القراءة بعد الالتزام (Post-Commit): ترى كلا القيمتين الجديدتين معاً
        const postCommitResponse = await app.inject({
          method: 'GET',
          url: `/users/${userId}/usage`,
          headers: { authorization: `Bearer ${apiKey}` },
        });

        assert.equal(postCommitResponse.statusCode, 200);
        const postCommitBody = JSON.parse(postCommitResponse.body) as UserUsageResponse;

        assert.equal(postCommitBody.accountUsage.consumed, 15, 'Post-commit account usage must show 15');
        assert.equal(postCommitBody.userUsage.consumed, 15, 'Post-commit user usage must show 15');
        assert.equal(postCommitBody.accountUsage.remaining, 100000 - 15);
        assert.equal(postCommitBody.userUsage.remaining, 10000 - 15);

        console.log('✔ Test 8: Point-in-time snapshot consistency verified rigorously under active in-flight consumption');
      } finally {
        // استئناف أي وعد معلق واستعادة الدوال المعترضة داخل التنظيف دائماً حتى عند الفشل
        resumeSignal.resolve();

        if (interceptedClient && originalClientQuery) {
          (interceptedClient as any).query = originalClientQuery;
        }

        try {
          await consumptionPromise;
        } catch {
          // تجاهل الخطأ في التنظيف
        }
      }
    }

    console.log('--- All Get Current Usage API Tests (Part 23) Passed Successfully! ---');
  } finally {
    await app.close();
    await pool.end();
  }
}

runUsageTests().catch((err) => {
  console.error('Usage tests failed:', err);
  process.exit(1);
});

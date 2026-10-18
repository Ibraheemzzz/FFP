// tests/usage.test.ts
// اختبارات مسارات قراءة الاستخدام الحالي (Part 23: Get Current Usage API)

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type pg from 'pg';
import { initEnvironment, loadConfig } from '../src/config.js';
import { createPool, checkDatabaseHealth } from '../src/db.js';
import { runMigrations } from '../src/migrator.js';
import { buildApp } from '../src/app.js';
import { executeConsumption, getUtcYearMonth } from '../src/consumptions.js';
import { createCustomPlan, updateCustomPlan } from '../src/plans.js';
import type {
  AccountUsageResponse,
  UserUsageResponse,
  HistoricalAccountUsageResponse,
  HistoricalUserUsageResponse,
} from '../src/types.js';

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
    // 5. اختبار التحقق الصارم من معاملات الاستعلام (Strict Query Validation)
    // رفض أي معامِل غير month، رفض التكرار والمصفوفات، رفض التنسيق غير المطابق، ورفض الأشهر المستقبلية
    // =========================================================================
    {
      const { accountId, apiKey } = await createTestAccount(pool, 'Query Test Account');
      const { userId } = await createTestUser(pool, accountId);

      // أ) محاولة تمرير معامِل غير مدعوم مثل ?foo=bar
      const resFoo = await app.inject({
        method: 'GET',
        url: '/account/usage?foo=bar',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(resFoo.statusCode, 400);
      assert.ok(JSON.parse(resFoo.body).error.includes('Only the "month" query parameter is supported'));

      // ب) محاولة تمرير معامِل زائد مع month مثل ?month=2026-09&extra=1
      const resExtra = await app.inject({
        method: 'GET',
        url: '/account/usage?month=2026-09&extra=1',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(resExtra.statusCode, 400);
      assert.ok(JSON.parse(resExtra.body).error.includes('Only the "month" query parameter is supported'));

      // ج) محاولة تمرير صيغة شهر غير مطابقة (سنة خارج النطاق، شهر غير صالح، أو نص مبهم)
      const invalidMonths = ['2026-13', '2026-00', '2026-9', 'invalid', '0999-01'];
      for (const inv of invalidMonths) {
        const resInv = await app.inject({
          method: 'GET',
          url: `/account/usage?month=${inv}`,
          headers: { authorization: `Bearer ${apiKey}` },
        });
        assert.equal(resInv.statusCode, 400, `Expected 400 for invalid month: ${inv}`);
        assert.ok(JSON.parse(resInv.body).error.includes('Invalid month format'));
      }

      // د) محاولة تمرير شهر مستقبلي
      const resFuture = await app.inject({
        method: 'GET',
        url: '/account/usage?month=2099-01',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(resFuture.statusCode, 400);
      assert.ok(JSON.parse(resFuture.body).error.includes('Cannot query usage for a future month'));

      // هـ) محاولة تمرير قيم مكررة/مصفوفة (?month=2026-08&month=2026-09)
      const resDuplicate = await app.inject({
        method: 'GET',
        url: '/account/usage?month=2026-08&month=2026-09',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(resDuplicate.statusCode, 400);
      assert.ok(JSON.parse(resDuplicate.body).error.includes('single string'));

      // و) التحقق نفسه على مسار المستخدم /users/:userId/usage
      const resUserInv = await app.inject({
        method: 'GET',
        url: `/users/${userId}/usage?month=2099-01`,
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(resUserInv.statusCode, 400);
      assert.ok(JSON.parse(resUserInv.body).error.includes('Cannot query usage for a future month'));

      console.log('✔ Test 5: Strict query validation rejects extraneous, malformed, duplicate, and future months with 400 Bad Request');
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

    // =========================================================================
    // 9. اختبار استعلام الشهر الحالي صراحة عبر ?month=CURRENT_MONTH
    // يعيد نفس شكل رد الجزء 23 مع plan و usage: { consumed, remaining }
    // =========================================================================
    {
      const { accountId, apiKey } = await createTestAccount(pool, 'Explicit Current Month Account');
      const currentMonth = getUtcYearMonth(new Date());

      const response = await app.inject({
        method: 'GET',
        url: `/account/usage?month=${currentMonth}`,
        headers: { authorization: `Bearer ${apiKey}` },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as AccountUsageResponse;
      assert.equal(body.accountId, accountId);
      assert.equal(body.yearMonth, currentMonth);
      assert.ok(body.plan);
      assert.ok(body.usage);
      assert.equal(body.usage.consumed, 0);
      assert.equal(body.usage.remaining, body.plan.monthlyLimit);

      console.log('✔ Test 9: Querying current month explicitly (?month=CURRENT) preserves Part 23 schema and remaining quota');
    }

    // =========================================================================
    // 10. اختبار استعلام الحساب لشهر سابق به استهلاك وطلبات (Part 24)
    // يعيد consumed و planAtLastRequest و lastRequestAt، ولا يعيد remaining إطلاقاً
    // =========================================================================
    {
      const { accountId, apiKey } = await createTestAccount(pool, 'Historical Account With Requests');
      const { userId } = await createTestUser(pool, accountId);

      const pastMonth = '2026-08';

      // 1. إدراج عداد استهلاك في شهر أغسطس بقيمة 75 وحدة
      await pool.query(
        `INSERT INTO account_monthly_usage (account_id, year_month, total_units, updated_at)
         VALUES ($1, $2, $3, '2026-08-25T16:00:00.000Z');`,
        [accountId, pastMonth, 75]
      );

      // 2. إدراج طلبين في أغسطس: الأول بتاريخ 10 أغسطس، والثاني بتاريخ 25 أغسطس بخطة محددة
      const contextReq1 = {
        accountPlan: { id: 'plan_starter_account', monthlyLimit: 1000, perRequestLimit: 100 },
        userPlan: { id: 'plan_starter_user', monthlyLimit: 500, perRequestLimit: 50 },
      };
      await pool.query(
        `INSERT INTO consumption_records (
           account_id, user_id, request_id, requested_units, status, rejection_scope, rejection_rule,
           response_body, decision_context, processed_at
         ) VALUES ($1, $2, $3, 30, 'ACCEPTED', NULL, NULL, '{}', $4, '2026-08-10T10:00:00.000Z');`,
        [accountId, userId, 'req_hist_001', JSON.stringify(contextReq1)]
      );

      const contextReq2 = {
        accountPlan: { id: 'plan_custom_august', monthlyLimit: 5000, perRequestLimit: 200 },
        userPlan: { id: 'plan_starter_user', monthlyLimit: 500, perRequestLimit: 50 },
      };
      await pool.query(
        `INSERT INTO consumption_records (
           account_id, user_id, request_id, requested_units, status, rejection_scope, rejection_rule,
           response_body, decision_context, processed_at
         ) VALUES ($1, $2, $3, 45, 'ACCEPTED', NULL, NULL, '{}', $4, '2026-08-25T15:00:00.000Z');`,
        [accountId, userId, 'req_hist_002', JSON.stringify(contextReq2)]
      );

      // الاستعلام عن شهر أغسطس
      const response = await app.inject({
        method: 'GET',
        url: `/account/usage?month=${pastMonth}`,
        headers: { authorization: `Bearer ${apiKey}` },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as HistoricalAccountUsageResponse;

      assert.equal(body.accountId, accountId);
      assert.equal(body.yearMonth, '2026-08');
      assert.equal(body.isCurrentMonth, false);
      assert.equal(body.consumed, 75);
      assert.ok(body.planAtLastRequest);
      assert.equal(body.planAtLastRequest.id, 'plan_custom_august');
      assert.equal(body.planAtLastRequest.monthlyLimit, 5000);
      assert.equal(body.planAtLastRequest.perRequestLimit, 200);
      assert.equal(body.lastRequestAt, '2026-08-25T15:00:00.000Z');

      // التحقق الصارم: لا يوجد حقل remaining إطلاقاً في الرد التاريخي
      assert.equal((body as any).remaining, undefined);
      assert.equal((body as any).usage, undefined);

      console.log('✔ Test 10: Historical account usage correctly returns consumed, planAtLastRequest, lastRequestAt, and no remaining');
    }

    // =========================================================================
    // 11. اختبار مناعة التاريخ ضد تعديل الخطط اللاحقة
    // تعديل خطة الحساب اليوم إلى خطة مختلفة لا يُغيّر تفسير أو حدود طلبات الشهر القديم
    // =========================================================================
    {
      const { accountId, apiKey } = await createTestAccount(pool, 'Immune History Account');
      const { userId } = await createTestUser(pool, accountId);
      const pastMonth = '2026-08';

      // إدراج طلب في أغسطس بخطة حدودها 1,000
      const augustContext = {
        accountPlan: { id: 'plan_starter_account', monthlyLimit: 1000, perRequestLimit: 100 },
        userPlan: { id: 'plan_starter_user', monthlyLimit: 500, perRequestLimit: 50 },
      };
      await pool.query(
        `INSERT INTO consumption_records (
           account_id, user_id, request_id, requested_units, status, rejection_scope, rejection_rule,
           response_body, decision_context, processed_at
         ) VALUES ($1, $2, 'req_aug_imm_01', 50, 'ACCEPTED', NULL, NULL, '{}', $3, '2026-08-20T12:00:00.000Z');`,
        [accountId, userId, JSON.stringify(augustContext)]
      );

      // اليوم: ترقية خطة الحساب إلى خطة Enterprise بحد 100,000
      await pool.query(
        `UPDATE accounts SET plan_id = 'plan_default_account' WHERE id = $1;`,
        [accountId]
      );

      // استعلام شهر أغسطس الماضي
      const response = await app.inject({
        method: 'GET',
        url: `/account/usage?month=${pastMonth}`,
        headers: { authorization: `Bearer ${apiKey}` },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as HistoricalAccountUsageResponse;

      // الخطة المسترجعة تبقى Starter بحد 1,000 كما كانت وقت الطلب تماماً، ولا تتأثر بخطة اليوم
      assert.ok(body.planAtLastRequest);
      assert.equal(body.planAtLastRequest.id, 'plan_starter_account');
      assert.equal(body.planAtLastRequest.monthlyLimit, 1000);

      console.log('✔ Test 11: Subsequent plan changes today strictly do not alter the historical month interpretation');
    }

    // =========================================================================
    // 12. اختبار استعلام شهر سابق لا نشاط فيه (0 طلبات و 0 استهلاك)
    // يعيد consumed: 0 و planAtLastRequest: null و lastRequestAt: null
    // =========================================================================
    {
      const { accountId, apiKey } = await createTestAccount(pool, 'Zero Activity Account');

      const response = await app.inject({
        method: 'GET',
        url: '/account/usage?month=2026-07',
        headers: { authorization: `Bearer ${apiKey}` },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as HistoricalAccountUsageResponse;

      assert.equal(body.accountId, accountId);
      assert.equal(body.yearMonth, '2026-07');
      assert.equal(body.isCurrentMonth, false);
      assert.equal(body.consumed, 0);
      assert.equal(body.planAtLastRequest, null);
      assert.equal(body.lastRequestAt, null);

      console.log('✔ Test 12: Historical month with zero activity returns consumed 0 and null planAtLastRequest and lastRequestAt');
    }

    // =========================================================================
    // 13. اختبار استخراج الخطة التاريخية حتى لو كان آخر طلب في الشهر مرفوضاً (REJECTED)
    // =========================================================================
    {
      const { accountId, apiKey } = await createTestAccount(pool, 'Rejected Last Request Account');
      const { userId } = await createTestUser(pool, accountId);
      const pastMonth = '2026-06';

      // إدراج طلب مرفوض في يونيو
      const rejectedContext = {
        accountPlan: { id: 'plan_rejected_case', monthlyLimit: 3000, perRequestLimit: 150 },
        userPlan: { id: 'plan_starter_user', monthlyLimit: 500, perRequestLimit: 50 },
      };
      await pool.query(
        `INSERT INTO consumption_records (
           account_id, user_id, request_id, requested_units, status, rejection_scope, rejection_rule,
           response_body, decision_context, processed_at
         ) VALUES ($1, $2, 'req_rej_001', 200, 'REJECTED', 'account', 'max_per_request', '{}', $3, '2026-06-15T08:30:00.000Z');`,
        [accountId, userId, JSON.stringify(rejectedContext)]
      );

      const response = await app.inject({
        method: 'GET',
        url: `/account/usage?month=${pastMonth}`,
        headers: { authorization: `Bearer ${apiKey}` },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as HistoricalAccountUsageResponse;

      assert.ok(body.planAtLastRequest);
      assert.equal(body.planAtLastRequest.id, 'plan_rejected_case');
      assert.equal(body.planAtLastRequest.monthlyLimit, 3000);
      assert.equal(body.lastRequestAt, '2026-06-15T08:30:00.000Z');

      console.log('✔ Test 13: Historical plan successfully extracted from decision_context of a REJECTED last request');
    }

    // =========================================================================
    // 14. اختبار استعلام المستخدم لشهر سابق (Part 24: Historical User Usage)
    // يعيد userConsumed و accountConsumed و userPlanAtLastRequest و accountPlanAtLastRequest
    // =========================================================================
    {
      const { accountId, apiKey } = await createTestAccount(pool, 'Historical User Test Account');
      const { userId } = await createTestUser(pool, accountId);
      const pastMonth = '2026-08';

      // إدراج عدادي المستخدم والحساب
      await pool.query(
        `INSERT INTO user_monthly_usage (account_id, user_id, year_month, total_units, updated_at)
         VALUES ($1, $2, $3, 35, '2026-08-28T10:00:00.000Z');`,
        [accountId, userId, pastMonth]
      );
      await pool.query(
        `INSERT INTO account_monthly_usage (account_id, year_month, total_units, updated_at)
         VALUES ($1, $2, 90, '2026-08-28T10:00:00.000Z');`,
        [accountId, pastMonth]
      );

      // إدراج طلب المستخدم الأخير في أغسطس
      const userReqContext = {
        accountPlan: { id: 'plan_account_snap', monthlyLimit: 20000, perRequestLimit: 500 },
        userPlan: { id: 'plan_user_snap', monthlyLimit: 2000, perRequestLimit: 100 },
      };
      await pool.query(
        `INSERT INTO consumption_records (
           account_id, user_id, request_id, requested_units, status, rejection_scope, rejection_rule,
           response_body, decision_context, processed_at
         ) VALUES ($1, $2, 'req_usr_hist_01', 35, 'ACCEPTED', NULL, NULL, '{}', $3, '2026-08-28T10:00:00.000Z');`,
        [accountId, userId, JSON.stringify(userReqContext)]
      );

      const response = await app.inject({
        method: 'GET',
        url: `/users/${userId}/usage?month=${pastMonth}`,
        headers: { authorization: `Bearer ${apiKey}` },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as HistoricalUserUsageResponse;

      assert.equal(body.userId, userId);
      assert.equal(body.accountId, accountId);
      assert.equal(body.yearMonth, '2026-08');
      assert.equal(body.isCurrentMonth, false);
      assert.equal(body.userConsumed, 35);
      assert.equal(body.accountConsumed, 90);
      assert.ok(body.userPlanAtLastRequest);
      assert.equal(body.userPlanAtLastRequest.id, 'plan_user_snap');
      assert.equal(body.userPlanAtLastRequest.monthlyLimit, 2000);
      assert.ok(body.accountPlanAtLastRequest);
      assert.equal(body.accountPlanAtLastRequest.id, 'plan_account_snap');
      assert.equal(body.accountPlanAtLastRequest.monthlyLimit, 20000);
      assert.equal(body.lastRequestAt, '2026-08-28T10:00:00.000Z');

      // لا يوجد remaining
      assert.equal((body as any).userRemaining, undefined);
      assert.equal((body as any).accountRemaining, undefined);

      console.log('✔ Test 14: Historical user usage returns exact user and account counters, plans from user context, and no remaining');
    }

    // =========================================================================
    // 15. اختبار عزل المستأجرين في الاستعلام التاريخي للمستخدم
    // محاولة استعلام مستخدم يتبع حساباً آخر لشهر سابق تعيد 404 Not Found
    // =========================================================================
    {
      const { accountId: accA, apiKey: keyA } = await createTestAccount(pool, 'Tenant A Historical');
      const { accountId: accB } = await createTestAccount(pool, 'Tenant B Historical');
      const { userId: userB } = await createTestUser(pool, accB);

      const response = await app.inject({
        method: 'GET',
        url: `/users/${userB}/usage?month=2026-08`,
        headers: { authorization: `Bearer ${keyA}` },
      });

      assert.equal(response.statusCode, 404);
      assert.ok(JSON.parse(response.body).error.includes('User not found'));

      console.log('✔ Test 15: Cross-tenant isolation strictly verified on historical usage returning 404 Not Found');
    }

    // =========================================================================
    // 16. اختبار الحالة الخاصة (توجيه المستخدم 1 و 2): سياق فارغ {} مع استهلاك غير صفري
    // يعاد إجمالي العداد كما هو، وتكون معلومات الخطة null، مع الحفاظ على lastRequestAt
    // =========================================================================
    {
      const { accountId, apiKey } = await createTestAccount(pool, 'Legacy Empty Context Account');
      const { userId } = await createTestUser(pool, accountId);
      const pastMonth = '2026-05';

      // 1. عداد الشهر فيه استهلاك 50 وحدة
      await pool.query(
        `INSERT INTO account_monthly_usage (account_id, year_month, total_units, updated_at)
         VALUES ($1, $2, 50, '2026-05-15T12:00:00.000Z');`,
        [accountId, pastMonth]
      );

      // 2. سجل الطلب سياقه فارغ {} (مثل سجل قديم قبل تفعيل decision_context)
      await pool.query(
        `INSERT INTO consumption_records (
           account_id, user_id, request_id, requested_units, status, rejection_scope, rejection_rule,
           response_body, decision_context, processed_at
         ) VALUES ($1, $2, 'req_legacy_001', 50, 'ACCEPTED', NULL, NULL, '{}', '{}'::jsonb, '2026-05-15T12:00:00.000Z');`,
        [accountId, userId]
      );

      const response = await app.inject({
        method: 'GET',
        url: `/account/usage?month=${pastMonth}`,
        headers: { authorization: `Bearer ${apiKey}` },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as HistoricalAccountUsageResponse;

      // إجمالي العداد يُعاد كما هو 50 وليس صفراً
      assert.equal(body.consumed, 50, 'Consumed must reflect counter units 50, not 0');
      // معلومات الخطة null لأن السياق فارغ
      assert.equal(body.planAtLastRequest, null);
      // وقت الطلب محفوظ ومعلوم
      assert.equal(body.lastRequestAt, '2026-05-15T12:00:00.000Z');

      console.log('✔ Test 16: Empty context {} with non-zero consumption preserves counter 50, sets plan to null, and keeps lastRequestAt');
    }

    // =========================================================================
    // 17. اختبار كسر التعادل عند تساوي processed_at (توجيه المستخدم 4)
    // الترتيب بـ processed_at DESC, id DESC يضمن اختيار السجل صاحب المعرّف الأكبر id
    // =========================================================================
    {
      const { accountId, apiKey } = await createTestAccount(pool, 'Tie Breaking Account');
      const { userId } = await createTestUser(pool, accountId);
      const pastMonth = '2026-04';
      const exactTime = '2026-04-10T12:00:00.000Z';

      // إدراج طلبين بنفس processed_at تماماً بخطتين مختلفتين
      const contextPlanA = {
        accountPlan: { id: 'plan_first_insert_A', monthlyLimit: 1111, perRequestLimit: 111 },
        userPlan: { id: 'plan_starter_user', monthlyLimit: 500, perRequestLimit: 50 },
      };
      await pool.query(
        `INSERT INTO consumption_records (
           account_id, user_id, request_id, requested_units, status, rejection_scope, rejection_rule,
           response_body, decision_context, processed_at
         ) VALUES ($1, $2, 'req_tie_001', 10, 'ACCEPTED', NULL, NULL, '{}', $3, $4);`,
        [accountId, userId, JSON.stringify(contextPlanA), exactTime]
      );

      const contextPlanB = {
        accountPlan: { id: 'plan_second_insert_B', monthlyLimit: 2222, perRequestLimit: 222 },
        userPlan: { id: 'plan_starter_user', monthlyLimit: 500, perRequestLimit: 50 },
      };
      await pool.query(
        `INSERT INTO consumption_records (
           account_id, user_id, request_id, requested_units, status, rejection_scope, rejection_rule,
           response_body, decision_context, processed_at
         ) VALUES ($1, $2, 'req_tie_002', 10, 'ACCEPTED', NULL, NULL, '{}', $3, $4);`,
        [accountId, userId, JSON.stringify(contextPlanB), exactTime]
      );

      const response = await app.inject({
        method: 'GET',
        url: `/account/usage?month=${pastMonth}`,
        headers: { authorization: `Bearer ${apiKey}` },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as HistoricalAccountUsageResponse;

      // يجب أن يختار السجل الثاني ذو id الأكبر حتماً
      assert.ok(body.planAtLastRequest);
      assert.equal(
        body.planAtLastRequest.id,
        'plan_second_insert_B',
        'Tie on processed_at must deterministically be broken by higher id'
      );
      assert.equal(body.lastRequestAt, exactTime);

      console.log('✔ Test 17: Deterministic tie-breaking verified: identical processed_at broken by id DESC');
    }

    // =========================================================================
    // 18. اختبار دقة حدود بداية الشهر ونهايته بتوقيت UTC (توجيه المستخدم 4)
    // 2026-03-01T00:00:00.000Z و 2026-03-31T23:59:59.999Z ضمن مارس، و 2026-04-01T00:00:00.000Z خارجه
    // =========================================================================
    {
      const { accountId, apiKey } = await createTestAccount(pool, 'UTC Boundaries Account');
      const { userId } = await createTestUser(pool, accountId);

      const contextMarchStart = {
        accountPlan: { id: 'plan_march_start', monthlyLimit: 3001, perRequestLimit: 301 },
      };
      const contextMarchEnd = {
        accountPlan: { id: 'plan_march_end', monthlyLimit: 3031, perRequestLimit: 331 },
      };
      const contextAprilStart = {
        accountPlan: { id: 'plan_april_start', monthlyLimit: 4001, perRequestLimit: 401 },
      };

      // 1. طلب في أول ثانية من مارس (01-03 00:00:00.000Z)
      await pool.query(
        `INSERT INTO consumption_records (
           account_id, user_id, request_id, requested_units, status, rejection_scope, rejection_rule,
           response_body, decision_context, processed_at
         ) VALUES ($1, $2, 'req_bnd_01', 1, 'ACCEPTED', NULL, NULL, '{}', $3, '2026-03-01T00:00:00.000Z');`,
        [accountId, userId, JSON.stringify(contextMarchStart)]
      );

      // 2. طلب في آخر ميلي ثانية من مارس (31-03 23:59:59.999Z)
      await pool.query(
        `INSERT INTO consumption_records (
           account_id, user_id, request_id, requested_units, status, rejection_scope, rejection_rule,
           response_body, decision_context, processed_at
         ) VALUES ($1, $2, 'req_bnd_02', 1, 'ACCEPTED', NULL, NULL, '{}', $3, '2026-03-31T23:59:59.999Z');`,
        [accountId, userId, JSON.stringify(contextMarchEnd)]
      );

      // 3. طلب في أول لحظة من أبريل (01-04 00:00:00.000Z)
      await pool.query(
        `INSERT INTO consumption_records (
           account_id, user_id, request_id, requested_units, status, rejection_scope, rejection_rule,
           response_body, decision_context, processed_at
         ) VALUES ($1, $2, 'req_bnd_03', 1, 'ACCEPTED', NULL, NULL, '{}', $3, '2026-04-01T00:00:00.000Z');`,
        [accountId, userId, JSON.stringify(contextAprilStart)]
      );

      // استعلام مارس: آخر طلب في مارس يجب أن يكون طلب نهاية مارس (وليس أبريل)
      const resMarch = await app.inject({
        method: 'GET',
        url: '/account/usage?month=2026-03',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(resMarch.statusCode, 200);
      const marchBody = JSON.parse(resMarch.body) as HistoricalAccountUsageResponse;
      assert.ok(marchBody.planAtLastRequest);
      assert.equal(marchBody.planAtLastRequest.id, 'plan_march_end');
      assert.equal(marchBody.lastRequestAt, '2026-03-31T23:59:59.999Z');

      // استعلام أبريل: آخر طلب في أبريل يجب أن يكون طلب بداية أبريل
      const resApril = await app.inject({
        method: 'GET',
        url: '/account/usage?month=2026-04',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(resApril.statusCode, 200);
      const aprilBody = JSON.parse(resApril.body) as HistoricalAccountUsageResponse;
      assert.ok(aprilBody.planAtLastRequest);
      assert.equal(aprilBody.planAtLastRequest.id, 'plan_april_start');
      assert.equal(aprilBody.lastRequestAt, '2026-04-01T00:00:00.000Z');

      console.log('✔ Test 18: Exact UTC month boundaries verified: inclusive start and exclusive next month start');
    }

    // =========================================================================
    // 19. اختبار السياق غير الصالح (Invalid/Corrupted decision_context)
    // يثبت أن الحدود غير الصالحة (مثل null أو float أو أعداد غير آمنة) تعيد خطة null
    // مع بقاء الاستهلاك المحقق total_units ووقت الطلب lastRequestAt كما هما
    // =========================================================================
    {
      const { accountId, apiKey } = await createTestAccount(pool, 'Invalid Context Account');
      const { userId } = await createTestUser(pool, accountId);
      const pastMonth = '2026-02';
      const requestTime = '2026-02-14T10:30:00.000Z';

      // 1. عداد الشهر يحتوي على استهلاك محقق 60 وحدة
      await pool.query(
        `INSERT INTO account_monthly_usage (account_id, year_month, total_units, updated_at)
         VALUES ($1, $2, 60, $3);`,
        [accountId, pastMonth, requestTime]
      );

      // 2. إدراج طلب بسياق قرار يحتوي على بيانات غير صالحة (monthlyLimit = null و perRequestLimit كسر عشري 3.14)
      const corruptedContext = {
        accountPlan: {
          id: 'plan_invalid_limits',
          monthlyLimit: null, // كان سابقاً يتحول إلى 0 مع Number(null)
          perRequestLimit: 3.14, // كسر عشري غير صحيح
        },
      };

      await pool.query(
        `INSERT INTO consumption_records (
           account_id, user_id, request_id, requested_units, status, rejection_scope, rejection_rule,
           response_body, decision_context, processed_at
         ) VALUES ($1, $2, 'req_corrupted_01', 60, 'ACCEPTED', NULL, NULL, '{}', $3, $4);`,
        [accountId, userId, JSON.stringify(corruptedContext), requestTime]
      );

      const response = await app.inject({
        method: 'GET',
        url: `/account/usage?month=${pastMonth}`,
        headers: { authorization: `Bearer ${apiKey}` },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as HistoricalAccountUsageResponse;

      // أ) الاستهلاك يبقى محفوظاً من عداد الشهر كما هو
      assert.equal(body.consumed, 60, 'Consumed units must be preserved from monthly counter');
      // ب) الخطة تُعاد null لعدم صلاحية حدودها كأعداد صحيحة آمنة موجبة
      assert.equal(body.planAtLastRequest, null, 'Invalid plan limits must result in null planAtLastRequest');
      // ج) وقت الطلب المرجعي يبقى محفوظاً ومعلوماً
      assert.equal(body.lastRequestAt, requestTime, 'lastRequestAt must be preserved even if context is invalid');

      console.log('✔ Test 19: Corrupted decision_context returns null plan while strictly preserving consumed units and lastRequestAt');
    }

    console.log('--- All Get Current & Historical Usage API Tests (Parts 23 & 24) Passed Successfully! ---');
  } finally {
    await app.close();
    await pool.end();
  }
}

runUsageTests().catch((err) => {
  console.error('Usage tests failed:', err);
  process.exit(1);
});

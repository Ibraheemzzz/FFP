// tests/consumptions.test.ts
// اختبارات مسار استهلاك الحصص عبر HTTP (POST /consumptions)

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type pg from 'pg';
import { initEnvironment, loadConfig } from '../src/config.js';
import { createPool, checkDatabaseHealth } from '../src/db.js';
import { runMigrations } from '../src/migrator.js';
import { buildApp } from '../src/app.js';
import { createAccount } from '../src/accounts.js';
import { createUser } from '../src/users.js';
import type { AcceptedDecision, RejectedDecision } from '../src/types.js';

/**
 * دالة مساعدة لإنشاء حساب مع مفتاح API
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
 * دالة مساعدة لإنشاء مستخدم تحت حساب معين
 */
async function createTestUser(
  pool: pg.Pool,
  accountId: string,
  planId = 'plan_default_user'
): Promise<{ userId: string }> {
  const user = await createUser(pool, accountId, { planId });
  return { userId: user.id };
}

async function runConsumptionsHttpTests(): Promise<void> {
  console.log('--- Starting HTTP Consumption API Tests (POST /consumptions) ---');

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
    // 1. اختبارات المصادقة (Authentication Checks)
    // =========================================================================
    {
      // أ) بدون ترويسة تفويض
      const noAuthRes = await app.inject({
        method: 'POST',
        url: '/consumptions',
        payload: {
          userId: 'usr_test',
          units: 10,
          requestId: 'req_no_auth',
        },
      });
      assert.equal(noAuthRes.statusCode, 401, 'Must return 401 Unauthorized when Authorization header is missing');

      // ب) مفتاح API غير صالح
      const invalidKeyRes = await app.inject({
        method: 'POST',
        url: '/consumptions',
        headers: {
          authorization: 'Bearer invalid_api_key_123',
        },
        payload: {
          userId: 'usr_test',
          units: 10,
          requestId: 'req_invalid_auth',
        },
      });
      assert.equal(invalidKeyRes.statusCode, 401, 'Must return 401 Unauthorized for invalid API key');
      console.log('✔ Test 1: Authentication checks passed (401 on missing/invalid key)');
    }

    // =========================================================================
    // 2. اختبارات التحقق من المدخلات ورفض الحقول الزائدة (Input Validation)
    // =========================================================================
    {
      const { apiKey } = await createTestAccount(pool, 'Validation Test Account');

      // أ) تمرير accountId في جسم الطلب يُرفض بـ 400
      const accountIdInBodyRes = await app.inject({
        method: 'POST',
        url: '/consumptions',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          accountId: 'acc_some_id',
          userId: 'usr_test',
          units: 10,
          requestId: 'req_with_account_id',
        },
      });
      assert.equal(accountIdInBodyRes.statusCode, 400, 'Passing accountId in body must be rejected with 400');
      const accountIdInBodyJson = accountIdInBodyRes.json();
      assert.equal(accountIdInBodyJson.error, 'Unknown field: accountId');

      // ب) حقول مجهولة أخرى
      const unknownFieldRes = await app.inject({
        method: 'POST',
        url: '/consumptions',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          userId: 'usr_test',
          units: 10,
          requestId: 'req_unknown',
          extraField: 'not_allowed',
        },
      });
      assert.equal(unknownFieldRes.statusCode, 400, 'Unknown fields must be rejected with 400');

      // ج) حقول مفقودة
      const missingFieldRes = await app.inject({
        method: 'POST',
        url: '/consumptions',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          userId: 'usr_test',
          units: 10,
        },
      });
      assert.equal(missingFieldRes.statusCode, 400, 'Missing requestId must return 400');

      // د) وحدات غير صالحة: 0، سالبة، كسرية، نصوص
      for (const invalidUnits of [0, -10, 3.14, '50', null]) {
        const res = await app.inject({
          method: 'POST',
          url: '/consumptions',
          headers: { authorization: `Bearer ${apiKey}` },
          payload: {
            userId: 'usr_test',
            units: invalidUnits,
            requestId: `req_inv_${invalidUnits}`,
          },
        });
        assert.equal(res.statusCode, 400, `Invalid units (${invalidUnits}) must return 400`);
      }

      // هـ) معرّفات نصية فارغة
      const emptyUserRes = await app.inject({
        method: 'POST',
        url: '/consumptions',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          userId: '   ',
          units: 10,
          requestId: 'req_empty_user',
        },
      });
      assert.equal(emptyUserRes.statusCode, 400, 'Empty userId must return 400');

      console.log('✔ Test 2: Input validation and rejection of extra fields (including accountId) passed');
    }

    // =========================================================================
    // 3. اختبارات عزل المستأجرين ووجود المستخدم (Tenant Isolation & User Check)
    // =========================================================================
    {
      const tenantA = await createTestAccount(pool, 'Tenant A');
      const tenantB = await createTestAccount(pool, 'Tenant B');
      const userB = await createTestUser(pool, tenantB.accountId);

      // أ) مستخدم غير موجود على الإطلاق
      const nonExistentUserRes = await app.inject({
        method: 'POST',
        url: '/consumptions',
        headers: { authorization: `Bearer ${tenantA.apiKey}` },
        payload: {
          userId: 'usr_does_not_exist',
          units: 10,
          requestId: 'req_no_such_user',
        },
      });
      assert.equal(nonExistentUserRes.statusCode, 404, 'Non-existent user must return 404');
      assert.equal(nonExistentUserRes.json().error, 'User not found');

      // ب) محاولة استهلاك لمستخدم يتبع حساباً آخر (Tenant B) باستخدام مفتاح Tenant A
      const crossTenantRes = await app.inject({
        method: 'POST',
        url: '/consumptions',
        headers: { authorization: `Bearer ${tenantA.apiKey}` },
        payload: {
          userId: userB.userId,
          units: 10,
          requestId: 'req_cross_tenant',
        },
      });
      assert.equal(crossTenantRes.statusCode, 404, 'Cross-tenant user access must return 404 with zero info leak');
      assert.equal(crossTenantRes.json().error, 'User not found');

      console.log('✔ Test 3: Tenant isolation and non-existent user handling verified (404)');
    }

    // =========================================================================
    // 4. قبول طلب استهلاك صالح وتحديث العدادات والسجلات (Accepted Request Flow)
    // =========================================================================
    let originalAcceptedResponse: AcceptedDecision;
    let acceptedRequestId: string;
    let acceptedAccountId: string;
    let acceptedApiKey: string;
    let acceptedUserId: string;

    {
      const account = await createTestAccount(pool, 'Accepted Flow Account');
      const user = await createTestUser(pool, account.accountId);

      acceptedAccountId = account.accountId;
      acceptedApiKey = account.apiKey;
      acceptedUserId = user.userId;
      acceptedRequestId = `req_accept_${crypto.randomUUID()}`;

      const res = await app.inject({
        method: 'POST',
        url: '/consumptions',
        headers: { authorization: `Bearer ${acceptedApiKey}` },
        payload: {
          userId: user.userId,
          units: 75,
          requestId: acceptedRequestId,
        },
      });

      assert.equal(res.statusCode, 200, 'Accepted consumption must return 200 OK');
      originalAcceptedResponse = res.json() as AcceptedDecision;

      assert.equal(originalAcceptedResponse.accepted, true);
      assert.equal(originalAcceptedResponse.requestId, acceptedRequestId);
      assert.equal(originalAcceptedResponse.account.consumed, 75);
      assert.equal(originalAcceptedResponse.account.remaining, 100000 - 75);
      assert.equal(originalAcceptedResponse.user.consumed, 75);
      assert.equal(originalAcceptedResponse.user.remaining, 10000 - 75);

      // التأكد أن processedAt غير موجود في كائن الرد
      assert.equal(
        (originalAcceptedResponse as unknown as Record<string, unknown>).processedAt,
        undefined,
        'processedAt must NOT be in the HTTP response body'
      );

      // التحقق في قاعدة البيانات: زيادة العدادات وحفظ السجل
      const accUsageRes = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1',
        [account.accountId]
      );
      assert.equal(Number(accUsageRes.rows[0].total_units), 75);

      const usrUsageRes = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM user_monthly_usage WHERE user_id = $1',
        [user.userId]
      );
      assert.equal(Number(usrUsageRes.rows[0].total_units), 75);

      const recRes = await pool.query<{ status: string; requested_units: string }>(
        'SELECT status, requested_units FROM consumption_records WHERE request_id = $1',
        [acceptedRequestId]
      );
      assert.equal(recRes.rows.length, 1);
      assert.equal(recRes.rows[0].status, 'ACCEPTED');
      assert.equal(Number(recRes.rows[0].requested_units), 75);

      console.log('✔ Test 4: Accepted request returned 200, incremented counters, and saved record');
    }

    // =========================================================================
    // 5. رفض طلب بسبب الحصة دون زيادة العدادات (Quota Rejection Flow)
    // =========================================================================
    let originalRejectedResponse: RejectedDecision;
    let rejectedRequestId: string;
    let rejectedAccountId: string;
    let rejectedApiKey: string;
    let rejectedUserId: string;

    {
      const account = await createTestAccount(pool, 'Rejection Flow Account');
      const user = await createTestUser(pool, account.accountId);

      rejectedAccountId = account.accountId;
      rejectedApiKey = account.apiKey;
      rejectedUserId = user.userId;
      rejectedRequestId = `req_reject_${crypto.randomUUID()}`;

      // خطة المستخدم الافتراضية سقف الطلب الواحد فيها 500؛ نرسل 600 ليحدث الرفض
      const res = await app.inject({
        method: 'POST',
        url: '/consumptions',
        headers: { authorization: `Bearer ${rejectedApiKey}` },
        payload: {
          userId: user.userId,
          units: 600,
          requestId: rejectedRequestId,
        },
      });

      assert.equal(res.statusCode, 200, 'Quota rejection must return 200 OK');
      originalRejectedResponse = res.json() as RejectedDecision;

      assert.equal(originalRejectedResponse.accepted, false);
      assert.equal(originalRejectedResponse.requestId, rejectedRequestId);
      assert.deepEqual(originalRejectedResponse.reason, {
        scope: 'user',
        rule: 'max_per_request',
      });
      assert.equal(originalRejectedResponse.account.consumed, 0);
      assert.equal(originalRejectedResponse.account.remaining, 100000);
      assert.equal(originalRejectedResponse.user.consumed, 0);
      assert.equal(originalRejectedResponse.user.remaining, 10000);

      // التأكد أن العدادات لم تنشأ أو لم تزد في قاعدة البيانات
      const accUsageRes = await pool.query(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1',
        [account.accountId]
      );
      assert.equal(accUsageRes.rows.length, 0, 'No counter row should be created for rejected request on fresh account');

      // والتأكد من حفظ سجل الرفض
      const recRes = await pool.query<{ status: string; rejection_scope: string; rejection_rule: string }>(
        'SELECT status, rejection_scope, rejection_rule FROM consumption_records WHERE request_id = $1',
        [rejectedRequestId]
      );
      assert.equal(recRes.rows.length, 1);
      assert.equal(recRes.rows[0].status, 'REJECTED');
      assert.equal(recRes.rows[0].rejection_scope, 'user');
      assert.equal(recRes.rows[0].rejection_rule, 'max_per_request');

      console.log('✔ Test 5: Quota rejection returned 200 with accepted: false, without incrementing counters');
    }

    // =========================================================================
    // 6. اختبارات إعادة الطلب المتطابق (Idempotent Replay for Accepted & Rejected)
    // =========================================================================
    {
      // أ) إعادة طلب مقبول
      const replayAcceptedRes = await app.inject({
        method: 'POST',
        url: '/consumptions',
        headers: { authorization: `Bearer ${acceptedApiKey}` },
        payload: {
          userId: acceptedUserId,
          units: 75,
          requestId: acceptedRequestId,
        },
      });

      assert.equal(replayAcceptedRes.statusCode, 200);
      const replayAcceptedJson = replayAcceptedRes.json();
      assert.deepEqual(
        replayAcceptedJson,
        originalAcceptedResponse,
        'Idempotent replay of accepted request must return exact deep-equal original response'
      );

      // ثبات العدادات وعدد السجلات
      const accCounter = await pool.query<{ total_units: string }>(
        'SELECT total_units FROM account_monthly_usage WHERE account_id = $1',
        [acceptedAccountId]
      );
      assert.equal(Number(accCounter.rows[0].total_units), 75, 'Counter must remain unchanged after replay');

      const recCount = await pool.query(
        'SELECT id FROM consumption_records WHERE request_id = $1',
        [acceptedRequestId]
      );
      assert.equal(recCount.rows.length, 1, 'Only 1 record row must exist after replay');

      // ب) إعادة طلب مرفوض
      const replayRejectedRes = await app.inject({
        method: 'POST',
        url: '/consumptions',
        headers: { authorization: `Bearer ${rejectedApiKey}` },
        payload: {
          userId: rejectedUserId,
          units: 600,
          requestId: rejectedRequestId,
        },
      });

      assert.equal(replayRejectedRes.statusCode, 200);
      const replayRejectedJson = replayRejectedRes.json();
      assert.deepEqual(
        replayRejectedJson,
        originalRejectedResponse,
        'Idempotent replay of rejected request must return exact deep-equal original response'
      );

      const rejRecCount = await pool.query(
        'SELECT id FROM consumption_records WHERE request_id = $1',
        [rejectedRequestId]
      );
      assert.equal(rejRecCount.rows.length, 1, 'Only 1 record row must exist after rejected replay');

      console.log('✔ Test 6: Idempotent replays returned exact deep-equal responses with invariant counters and records');
    }

    // =========================================================================
    // 7. اختبار تعارض معرّف الطلب (Request ID Conflict - 409 Conflict)
    // =========================================================================
    {
      // أ) نفس requestId مع مستخدم مختلف
      const conflictUserRes = await app.inject({
        method: 'POST',
        url: '/consumptions',
        headers: { authorization: `Bearer ${acceptedApiKey}` },
        payload: {
          userId: 'usr_different_user',
          units: 75,
          requestId: acceptedRequestId,
        },
      });
      assert.equal(conflictUserRes.statusCode, 409, 'Reusing requestId with different userId must return 409 Conflict');
      assert.equal(
        conflictUserRes.json().error,
        'requestId has already been used with different request data'
      );

      // ب) نفس requestId مع وحدات مختلفة
      const conflictUnitsRes = await app.inject({
        method: 'POST',
        url: '/consumptions',
        headers: { authorization: `Bearer ${acceptedApiKey}` },
        payload: {
          userId: acceptedUserId,
          units: 120, // كان 75
          requestId: acceptedRequestId,
        },
      });
      assert.equal(conflictUnitsRes.statusCode, 409, 'Reusing requestId with different units must return 409 Conflict');

      console.log('✔ Test 7: Request ID conflict on modified payload rejected with 409 Conflict');
    }

    // =========================================================================
    // 8. اختبار الخطأ الداخلي غير المتوقع (500 Internal Server Error)
    // =========================================================================
    {
      // تطبيق بدون قاعدة بيانات لتوليد 500
      const appNoPool = buildApp({
        checkHealth: async () => false,
      });

      // ننشئ حساباً حقيقياً للحصول على مفتاح API صالح يمر من requireAuth
      const { apiKey } = await createTestAccount(pool, 'Error 500 Test Account');

      // عند إرسال الطلب لتطبيق بدون مجمع قاعدة بيانات، يفشل المسار ويعيد 500
      const errorRes = await appNoPool.inject({
        method: 'POST',
        url: '/consumptions',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          userId: 'usr_test',
          units: 10,
          requestId: 'req_500_test',
        },
      });

      assert.equal(errorRes.statusCode, 500, 'Database failure must return 500');
      const errorJson = errorRes.json();
      assert.equal(errorJson.error, 'Database pool is not configured');

      // والآن نختبر الخطأ غير المتوقع داخل معالج المسار أثناء معالجة الطلب
      // نتأكد أن رسالة الخطأ العامة هي 'Internal Server Error' ولا تكشف أي استعلامات أو تفاصيل داخلية
      const brokenPool = {
        query: pool.query.bind(pool),
        connect: async () => {
          throw new Error('FATAL: Database disk failure or secret query leak');
        },
      } as unknown as pg.Pool;

      const appBrokenPool = buildApp({
        checkHealth: async () => false,
        pool: brokenPool,
      });

      const genericErrorRes = await appBrokenPool.inject({
        method: 'POST',
        url: '/consumptions',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          userId: 'usr_test',
          units: 10,
          requestId: 'req_generic_500',
        },
      });

      assert.equal(genericErrorRes.statusCode, 500);
      assert.deepEqual(genericErrorRes.json(), { error: 'Internal Server Error' });

      console.log('✔ Test 8: Unexpected 500 returns safe generic error message without leaking internal details');
    }

    // =========================================================================
    // 9. اختبار حقن الساعة وفحص التاريخ وشهر العدادات في القاعدة (Clock Injection)
    // =========================================================================
    {
      const fixedDate = new Date('2026-11-25T14:30:00.000Z');
      const appWithClock = buildApp({
        checkHealth: () => checkDatabaseHealth(pool),
        pool,
        clock: () => fixedDate,
      });

      const { accountId, apiKey } = await createTestAccount(pool, 'Clock Account');
      const user = await createTestUser(pool, accountId);
      const clockReqId = `req_clock_${crypto.randomUUID()}`;

      const res = await appWithClock.inject({
        method: 'POST',
        url: '/consumptions',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          userId: user.userId,
          units: 40,
          requestId: clockReqId,
        },
      });

      assert.equal(res.statusCode, 200);

      // فحص قاعدة البيانات: شهر العداد هو 2026-11 ووقت المعالجة مطابق للساعة المحقونة
      const accUsageRes = await pool.query<{ year_month: string }>(
        'SELECT year_month FROM account_monthly_usage WHERE account_id = $1',
        [accountId]
      );
      assert.equal(accUsageRes.rows[0].year_month, '2026-11', 'Counter must be partitioned under 2026-11');

      const recRes = await pool.query<{ processed_at: Date }>(
        'SELECT processed_at FROM consumption_records WHERE request_id = $1',
        [clockReqId]
      );
      assert.equal(
        new Date(recRes.rows[0].processed_at).toISOString(),
        fixedDate.toISOString(),
        'processed_at must match injected clock timestamp'
      );

      console.log('✔ Test 9: Clock injection accurately sets processed_at and partitions usage into correct month');
    }

  } finally {
    await pool.end();
  }

  console.log('--- All HTTP Consumption API Tests (POST /consumptions) Passed Successfully! ---');
}

runConsumptionsHttpTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});

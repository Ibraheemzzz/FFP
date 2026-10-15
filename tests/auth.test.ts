// tests/auth.test.ts
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { AUTH_ERROR_MESSAGE, createAuthPreHandler } from '../src/auth.js';
import { initEnvironment, loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrator.js';

/**
 * دالة مساعدة لتعديل مسار اسم قاعدة البيانات داخل رابط الاتصال
 */
function getDatabaseUrl(baseUrl: string, dbName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

async function runAuthTests(): Promise<void> {
  // 1. تحميل إعدادات البيئة
  initEnvironment();
  const config = loadConfig();

  const adminPool = createPool(config.DATABASE_URL);
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const TEST_DB_NAME = `usage_metering_auth_test_${Date.now()}_${randomSuffix}`;

  let isDatabaseCreated = false;
  let testPool: pg.Pool | undefined;
  let app: FastifyInstance | undefined;
  let testExecutionError: unknown = null;

  try {
    // 2. إنشاء قاعدة بيانات الاختبار المعزولة باسم فريد وتتبع نجاح إنشائها
    await adminPool.query(`CREATE DATABASE ${TEST_DB_NAME}`);
    isDatabaseCreated = true;

    testPool = createPool(getDatabaseUrl(config.DATABASE_URL, TEST_DB_NAME));
    await runMigrations(testPool);

    // 3. بناء تطبيق Fastify
    const testApp = buildApp({
      checkHealth: async () => true,
      pool: testPool,
    });
    app = testApp;

    // 4. إنشاء حساب صالح للحصول على مفتاح API سليم
    const createRes = await testApp.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        name: 'Authentication Test Corp',
      },
    });

    assert.equal(createRes.statusCode, 201, 'Account creation should return 201');
    const createdAccount = createRes.json<{
      id: string;
      name: string;
      planId: string;
      apiKey: string;
      createdAt: string;
    }>();

    const validKey = createdAccount.apiKey;
    assert.ok(validKey.startsWith('ffp_live_'), 'Generated key must start with ffp_live_');

    // -------------------------------------------------------------------------
    // اختبار 1: مصادقة ناجحة بمفتاح سليم مع صيغ مختلفة للمخطط (Bearer, bearer, BEARER)
    // والتحقق الدقيق من الحقول الأربعة وتطابق createdAt
    // -------------------------------------------------------------------------
    const schemeVariations = ['Bearer', 'bearer', 'BEARER'];
    for (const scheme of schemeVariations) {
      const resAuthSuccess = await testApp.inject({
        method: 'GET',
        url: '/account/me',
        headers: {
          authorization: `${scheme} ${validKey}`,
        },
      });

      assert.equal(
        resAuthSuccess.statusCode,
        200,
        `Scheme variation (${scheme}) must authenticate successfully with 200 OK`
      );
      const authData = resAuthSuccess.json<Record<string, unknown>>();

      // التحقق من احتواء الرد على الحقول الأربعة المتوقعة فقط دون أي حقول إضافية
      const expectedKeys = ['createdAt', 'id', 'name', 'planId'].sort();
      const actualKeys = Object.keys(authData).sort();
      assert.deepEqual(
        actualKeys,
        expectedKeys,
        'Profile response must strictly contain only the 4 expected fields'
      );

      // التحقق من تطابق القيم مع الحساب المنشأ
      assert.equal(authData.id, createdAccount.id, 'Authenticated account ID must match');
      assert.equal(authData.name, createdAccount.name, 'Authenticated account name must match');
      assert.equal(authData.planId, createdAccount.planId, 'Authenticated plan ID must match');
      assert.equal(
        authData.createdAt,
        createdAccount.createdAt,
        'Authenticated createdAt must exactly match the creation timestamp'
      );

      // التحقق من صحة تنسيق تاريخ ISO 8601
      const parsedDate = new Date(authData.createdAt as string);
      assert.ok(!Number.isNaN(parsedDate.getTime()), 'createdAt must be a valid date');
      assert.equal(
        authData.createdAt,
        parsedDate.toISOString(),
        'createdAt must be a valid ISO 8601 string'
      );

      // التأكد الصارم من عدم إرجاع المفتاح الأصلي أو بصمته
      assert.equal(authData.apiKey, undefined, 'Raw API key must NOT be returned');
      assert.equal(authData.api_key_hash, undefined, 'API key hash must NOT be returned');
    }
    console.log('✔ Case-insensitive Bearer scheme variants (Bearer, bearer, BEARER) verified with strict fields');

    // -------------------------------------------------------------------------
    // اختبار 2: رفض الطلب عند غياب ترويسة Authorization بالكامل -> 401 + WWW-Authenticate
    // -------------------------------------------------------------------------
    const resMissingHeader = await testApp.inject({
      method: 'GET',
      url: '/account/me',
    });

    assert.equal(resMissingHeader.statusCode, 401, 'Missing Authorization header must return 401');
    assert.equal(
      resMissingHeader.headers['www-authenticate'],
      'Bearer',
      '401 response must include WWW-Authenticate: Bearer header'
    );
    assert.deepEqual(
      resMissingHeader.json(),
      { error: AUTH_ERROR_MESSAGE },
      'Error message must be the unified authentication error'
    );
    console.log('✔ Missing Authorization header rejection passed (401 + WWW-Authenticate: Bearer)');

    // -------------------------------------------------------------------------
    // اختبار 3: رفض الطلب عند استخدام نظام مصادقة غير Bearer -> 401 + WWW-Authenticate
    // (استخدام أوصاف آمنة وتجنب طباعة المفتاح أو الترويسة في رسائل الفشل)
    // -------------------------------------------------------------------------
    const nonBearerCases = [
      { desc: 'Basic authentication scheme', header: `Basic ${Buffer.from('user:pass').toString('base64')}` },
      { desc: 'Token scheme prefix', header: `Token ${validKey}` },
      { desc: 'X-API-Key scheme prefix', header: `X-API-Key ${validKey}` },
      { desc: 'Raw key without any scheme prefix', header: validKey },
    ];

    for (const testCase of nonBearerCases) {
      const resWrongScheme = await testApp.inject({
        method: 'GET',
        url: '/account/me',
        headers: {
          authorization: testCase.header,
        },
      });

      assert.equal(
        resWrongScheme.statusCode,
        401,
        `Non-Bearer scheme (${testCase.desc}) must return 401`
      );
      assert.equal(resWrongScheme.headers['www-authenticate'], 'Bearer');
      assert.deepEqual(resWrongScheme.json(), { error: AUTH_ERROR_MESSAGE });
    }
    console.log('✔ Non-Bearer authorization schemes rejection passed (401 + WWW-Authenticate: Bearer)');

    // -------------------------------------------------------------------------
    // اختبار 4: رفض الطلب عند إرسال Bearer فارغ -> 401 + WWW-Authenticate
    // (استخدام أوصاف آمنة لحالات الفراغ المختلفة)
    // -------------------------------------------------------------------------
    const emptyBearerCases = [
      { desc: 'Bearer keyword only without space', header: 'Bearer' },
      { desc: 'Bearer with single space and no token', header: 'Bearer ' },
      { desc: 'Bearer with multiple spaces', header: 'Bearer    ' },
      { desc: 'Lowercase bearer with single space', header: 'bearer ' },
      { desc: 'Uppercase BEARER with single space', header: 'BEARER ' },
    ];

    for (const testCase of emptyBearerCases) {
      const resEmptyBearer = await testApp.inject({
        method: 'GET',
        url: '/account/me',
        headers: {
          authorization: testCase.header,
        },
      });

      assert.equal(
        resEmptyBearer.statusCode,
        401,
        `Empty Bearer token (${testCase.desc}) must return 401`
      );
      assert.equal(resEmptyBearer.headers['www-authenticate'], 'Bearer');
      assert.deepEqual(resEmptyBearer.json(), { error: AUTH_ERROR_MESSAGE });
    }
    console.log('✔ Empty Bearer token rejection passed (401 + WWW-Authenticate: Bearer)');

    // -------------------------------------------------------------------------
    // اختبار 5: رفض المفاتيح ذات التنسيق غير الصالح -> 401 + WWW-Authenticate
    // (استخدام أوصاف آمنة دون إظهار قيم المفاتيح في رسائل الفشل)
    // -------------------------------------------------------------------------
    const invalidFormatCases = [
      { desc: 'Missing prefix completely', key: 'not_even_starting_with_prefix' },
      { desc: 'Wrong environment prefix', key: 'ffp_test_' + 'a'.repeat(64) },
      { desc: 'Shorter hex string than 64 characters', key: 'ffp_live_' + 'a'.repeat(63) },
      { desc: 'Longer hex string than 64 characters', key: 'ffp_live_' + 'a'.repeat(65) },
      { desc: 'Non-hexadecimal characters present', key: 'ffp_live_' + 'z'.repeat(64) },
    ];

    for (const testCase of invalidFormatCases) {
      const resInvalidFormat = await testApp.inject({
        method: 'GET',
        url: '/account/me',
        headers: {
          authorization: `Bearer ${testCase.key}`,
        },
      });

      assert.equal(
        resInvalidFormat.statusCode,
        401,
        `Malformed API key format (${testCase.desc}) must return 401`
      );
      assert.equal(resInvalidFormat.headers['www-authenticate'], 'Bearer');
      assert.deepEqual(resInvalidFormat.json(), { error: AUTH_ERROR_MESSAGE });
    }
    console.log('✔ Malformed API key formats rejection passed (401 + WWW-Authenticate: Bearer)');

    // -------------------------------------------------------------------------
    // اختبار 6: مفتاح بتنسيق سليم تماماً لكنه غير موجود في قاعدة البيانات -> 401
    // -------------------------------------------------------------------------
    const nonExistentKey = `ffp_live_${crypto.randomBytes(32).toString('hex')}`;
    const resNonExistent = await testApp.inject({
      method: 'GET',
      url: '/account/me',
      headers: {
        authorization: `Bearer ${nonExistentKey}`,
      },
    });

    assert.equal(resNonExistent.statusCode, 401, 'Non-existent key must return 401');
    assert.equal(resNonExistent.headers['www-authenticate'], 'Bearer');
    assert.deepEqual(resNonExistent.json(), { error: AUTH_ERROR_MESSAGE });
    console.log('✔ Non-existent API key rejection passed (401 + WWW-Authenticate: Bearer)');

    // -------------------------------------------------------------------------
    // اختبار 7: إثبات أن المفتاح غير صالح التنسيق يُرفض بـ 401 دون أي استدعاء لـ pool.query
    // (باستخدام Pool وهمي وعدّاد للاستدعاءات - Fail-Fast Verification)
    // -------------------------------------------------------------------------
    let queryCallCount = 0;
    const countingPool = {
      query: async () => {
        queryCallCount++;
        return { rows: [] };
      },
    } as unknown as pg.Pool;

    const failFastAuthHook = createAuthPreHandler(countingPool);
    const failFastApp = Fastify({ logger: false });

    try {
      failFastApp.get('/test-fail-fast', { preHandler: failFastAuthHook }, async () => {
        return { ok: true };
      });

      const resFailFast = await failFastApp.inject({
        method: 'GET',
        url: '/test-fail-fast',
        headers: {
          authorization: 'Bearer ffp_live_invalid_short_hex',
        },
      });

      assert.equal(resFailFast.statusCode, 401, 'Malformed key must be rejected with 401');
      assert.equal(resFailFast.headers['www-authenticate'], 'Bearer');
      assert.deepEqual(resFailFast.json(), { error: AUTH_ERROR_MESSAGE });
      assert.equal(
        queryCallCount,
        0,
        'pool.query must NOT be called when API key format is invalid (Fail-Fast)'
      );
      console.log('✔ Malformed key rejected with 401 without querying database verified (0 calls to pool.query)');
    } finally {
      await failFastApp.close();
    }

    // -------------------------------------------------------------------------
    // اختبار 8: التأكد من توقف معالجة الطلب قبل تنفيذ معالج المسار عند فشل المصادقة
    // -------------------------------------------------------------------------
    let handlerExecuted = false;
    const authHook = createAuthPreHandler(testPool);
    const spyApp = Fastify({ logger: false });

    try {
      spyApp.get('/test-auth-halt', { preHandler: authHook }, async () => {
        handlerExecuted = true;
        return { ok: true };
      });

      const resHalt = await spyApp.inject({
        method: 'GET',
        url: '/test-auth-halt',
        headers: {
          authorization: 'Bearer invalid_key',
        },
      });

      assert.equal(resHalt.statusCode, 401, 'Authentication hook must return 401 on failure');
      assert.equal(
        handlerExecuted,
        false,
        'Route handler must NOT be executed when preHandler authentication fails'
      );
      console.log('✔ Request pipeline halt before route handler verified on authentication failure');
    } finally {
      await spyApp.close();
    }

    // -------------------------------------------------------------------------
    // اختبار 9: خطأ فشل pool.query يرجع 500 برسالة عامة ويوقف معالج المسار (دون تحويله لـ 401)
    // -------------------------------------------------------------------------
    const failingPool = {
      query: async () => {
        throw new Error('connection reset by peer: secret_db_host:5432');
      },
    } as unknown as pg.Pool;

    const failingAuthHook = createAuthPreHandler(failingPool);
    const failingSpyApp = Fastify({ logger: false });
    let dbFailureHandlerExecuted = false;

    try {
      failingSpyApp.get('/test-db-failure', { preHandler: failingAuthHook }, async () => {
        dbFailureHandlerExecuted = true;
        return { ok: true };
      });

      const resDbFailure = await failingSpyApp.inject({
        method: 'GET',
        url: '/test-db-failure',
        headers: {
          authorization: `Bearer ${validKey}`,
        },
      });

      assert.equal(
        resDbFailure.statusCode,
        500,
        'Database query failure must return 500 Internal Server Error, NOT 401'
      );
      assert.deepEqual(
        resDbFailure.json(),
        { error: 'Internal Server Error' },
        'Response must be generic Internal Server Error'
      );
      assert.equal(
        JSON.stringify(resDbFailure.json()).includes('secret_db_host'),
        false,
        'Response must not leak database error or connection details'
      );
      assert.equal(
        dbFailureHandlerExecuted,
        false,
        'Route handler must NOT be executed when database failure occurs in preHandler'
      );
      console.log('✔ Database query failure returns safe 500 without leaking details and halts pipeline');
    } finally {
      await failingSpyApp.close();
    }

    // -------------------------------------------------------------------------
    // اختبار 10: خطأ غياب مجموعة الاتصال (Pool) هو خطأ خادم داخلي 500 وليس 401
    // -------------------------------------------------------------------------
    const appWithoutPool = buildApp({
      checkHealth: async () => true,
    });

    try {
      const resNoPool = await appWithoutPool.inject({
        method: 'GET',
        url: '/account/me',
        headers: {
          authorization: `Bearer ${validKey}`,
        },
      });

      assert.equal(resNoPool.statusCode, 500, 'Missing pool must return 500 Internal Server Error, NOT 401');
      assert.deepEqual(resNoPool.json(), { error: 'Database pool is not configured' });
      console.log('✔ Missing pool returns 500 error and is not converted to 401 passed');
    } finally {
      await appWithoutPool.close();
    }

    // -------------------------------------------------------------------------
    // اختبار 11: بقاء المسارات العامة مفتوحة دون اشتراط ترويسة Authorization
    // -------------------------------------------------------------------------
    // أ. GET /health
    const resHealth = await testApp.inject({
      method: 'GET',
      url: '/health',
    });
    assert.equal(resHealth.statusCode, 200, 'Liveness probe /health must remain public without auth');

    // ب. GET /health/ready (مطلوب صراحة في المتطلبات)
    const resReady = await testApp.inject({
      method: 'GET',
      url: '/health/ready',
    });
    assert.equal(resReady.statusCode, 200, 'Readiness probe /health/ready must remain public without auth');

    // ج. POST /accounts (تسجيل الحسابات الجديدة)
    const resNewAccount = await testApp.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        name: 'Another Public Signup Corp',
      },
    });
    assert.equal(resNewAccount.statusCode, 201, 'Account registration /accounts must remain public without auth');
    console.log('✔ Public endpoints (/health, /health/ready, POST /accounts) remain publicly accessible');
  } catch (err) {
    testExecutionError = err;
  } finally {
    // -------------------------------------------------------------------------
    // تنظيف متسلسل ومستقل للموارد (Sequential and Independent Resource Cleanup)
    // -------------------------------------------------------------------------
    let cleanupError: unknown = null;

    if (app) {
      try {
        await app.close();
      } catch (err) {
        cleanupError = cleanupError ?? err;
        console.error('Failed to close application cleanly during cleanup:', err);
      }
    }

    if (testPool) {
      try {
        await testPool.end();
      } catch (err) {
        cleanupError = cleanupError ?? err;
        console.error('Failed to close testPool cleanly during cleanup:', err);
      }
    }

    if (isDatabaseCreated) {
      try {
        await adminPool.query(`DROP DATABASE ${TEST_DB_NAME}`);
      } catch (err) {
        cleanupError = cleanupError ?? err;
        console.error(`Failed to drop test database ${TEST_DB_NAME} during cleanup:`, err);
      }
    }

    try {
      await adminPool.end();
    } catch (err) {
      cleanupError = cleanupError ?? err;
      console.error('Failed to close adminPool cleanly during cleanup:', err);
    }

    // الحفاظ على خطأ الاختبار الأصلي وعدم طمسه بخطأ التنظيف
    if (testExecutionError) {
      throw testExecutionError;
    }

    if (cleanupError) {
      throw cleanupError;
    }
  }
}

try {
  await runAuthTests();
  console.log('\nAll API key authentication tests passed successfully.');
} catch (err) {
  console.error('\nAuthentication test failed:', err);
  process.exit(1);
}

// tests/errors-and-logging.test.ts
// اختبارات الأخطاء المنظمة، تتبع الطلبات، وسرية السجلات (Part 26: Errors & Logging)

import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type pg from 'pg';
import { initEnvironment, loadConfig } from '../src/config.js';
import { createPool, checkDatabaseHealth, withAccountLock } from '../src/db.js';
import { runMigrations } from '../src/migrator.js';
import { buildApp } from '../src/app.js';
import { createAccount } from '../src/accounts.js';
import { createUser } from '../src/users.js';

interface CapturedLogEntry {
  level?: number;
  time?: number;
  pid?: number;
  hostname?: string;
  reqId?: string;
  requestId?: string;
  event?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  durationMs?: number;
  msg?: string;
  [key: string]: unknown;
}

/**
 * دالة مساعدة لإنشاء دفق تسجيل ملتقط في الذاكرة
 */
function createLogCaptureStream(): {
  stream: Writable;
  getLogs: () => CapturedLogEntry[];
  clearLogs: () => void;
  getAllLogsText: () => string;
} {
  const logs: CapturedLogEntry[] = [];
  const rawChunks: string[] = [];

  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const text = chunk.toString();
      rawChunks.push(text);
      try {
        const parsed = JSON.parse(text);
        logs.push(parsed);
      } catch {
        // إذا كان السطر غير قابل للتحويل كـ JSON
      }
      callback();
    },
  });

  return {
    stream,
    getLogs: () => [...logs],
    clearLogs: () => {
      logs.length = 0;
      rawChunks.length = 0;
    },
    getAllLogsText: () => rawChunks.join('\n'),
  };
}

async function runErrorsAndLoggingTests(): Promise<void> {
  console.log('--- Starting Errors & Logging Tests (Part 26: Errors, Tracing & Log Secrecy) ---');

  initEnvironment();
  const config = loadConfig();

  const pool = createPool(config.DATABASE_URL, {
    max: 20,
    connectionTimeoutMillis: 10000,
    statementTimeoutMillis: 15000,
    queryTimeoutMillis: 20000,
  });

  await runMigrations(pool);

  const capture = createLogCaptureStream();
  const app = buildApp({
    checkHealth: () => checkDatabaseHealth(pool),
    pool,
    logger: {
      level: 'info',
      stream: capture.stream,
    },
  });

  try {
    // =========================================================================
    // 1. اختبار توليد x-request-id من الخادم وحصانته ضد تزوير العميل
    // =========================================================================
    console.log('Test 1: Server generates x-request-id and ignores client header...');
    capture.clearLogs();

    // 1.1 طلب عادي دون ترويسة x-request-id من العميل
    const res1 = await app.inject({
      method: 'GET',
      url: '/health',
    });
    assert.equal(res1.statusCode, 200);
    const reqId1 = res1.headers['x-request-id'] as string;
    assert.ok(reqId1, 'Response must contain x-request-id header');
    assert.match(
      reqId1,
      /^req_[0-9a-f]{32}$/,
      'Server-generated request ID must follow req_<uuid_hex> format'
    );

    // 1.2 طلب مع محاولة تزوير x-request-id من العميل
    const clientSpoofedId = 'client-spoofed-req-id-9999';
    const res2 = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-request-id': clientSpoofedId,
        'request-id': clientSpoofedId,
      },
    });
    assert.equal(res2.statusCode, 200);
    const reqId2 = res2.headers['x-request-id'] as string;
    assert.notEqual(
      reqId2,
      clientSpoofedId,
      'Server MUST ignore client-supplied x-request-id and generate its own'
    );
    assert.match(
      reqId2,
      /^req_[0-9a-f]{32}$/,
      'Server-generated ID must match expected format even when client sent spoofed header'
    );
    assert.notEqual(reqId1, reqId2, 'Subsequent requests must receive unique IDs');
    console.log('✔ Test 1 passed: Server generates x-request-id immune to client spoofing');

    // =========================================================================
    // 2. اختبار التسجيل المنظم للطلب المكتمل (Structured Request Logging)
    // =========================================================================
    console.log('Test 2: Structured request completion logging in onResponse...');
    capture.clearLogs();

    const sensitiveQueryVal = 'super_secret_query_token_abc123';
    const res3 = await app.inject({
      method: 'GET',
      url: `/health?debug=true&token=${sensitiveQueryVal}`,
    });
    assert.equal(res3.statusCode, 200);
    const res3ReqId = res3.headers['x-request-id'] as string;

    const logs3 = capture.getLogs();
    const completedLog = logs3.find((l) => l.event === 'request_completed');
    assert.ok(completedLog, 'onResponse must log request_completed event');
    assert.equal(completedLog.requestId, res3ReqId, 'Log requestId must match response header');
    assert.equal(completedLog.method, 'GET', 'Log method must match request method');
    assert.equal(
      completedLog.path,
      '/health',
      'Log path MUST be stripped of all query parameters'
    );
    assert.equal(completedLog.statusCode, 200, 'Log statusCode must match HTTP status');
    assert.equal(typeof completedLog.durationMs, 'number', 'durationMs must be a number');
    assert.ok((completedLog.durationMs as number) >= 0, 'durationMs must be non-negative');

    const allLogs3Text = capture.getAllLogsText();
    assert.ok(
      !allLogs3Text.includes(sensitiveQueryVal),
      'Query string parameters must NEVER appear anywhere in the logs'
    );
    console.log('✔ Test 2 passed: Structured request logging with stripped query parameters');

    // =========================================================================
    // 3. اختبار تدقيق سرية السجلات مع مفتاح API حقيقي صادر من createAccount
    // =========================================================================
    console.log('Test 3: Log secrecy audit with real API key from createAccount...');
    const account = await createAccount(pool, {
      name: 'Audit Secrecy Account',
      planId: 'plan_default_account',
    });
    const realApiKey = account.apiKey;
    assert.ok(realApiKey && realApiKey.startsWith('ffp_live_'), 'Account API key must be valid');

    capture.clearLogs();

    // إرسال طلب موثق بالمفتاح الحقيقي
    const resAuth = await app.inject({
      method: 'GET',
      url: '/account/me',
      headers: {
        authorization: `Bearer ${realApiKey}`,
      },
    });
    assert.equal(resAuth.statusCode, 200);
    const authBody = resAuth.json();
    assert.equal(authBody.id, account.id);

    // فحص جميع السجلات الناتجة
    const allAuthLogs = capture.getAllLogsText();
    assert.ok(
      !allAuthLogs.includes(realApiKey),
      'The real API key MUST NEVER appear anywhere in the logs'
    );
    assert.ok(
      !allAuthLogs.includes('Bearer'),
      'The Authorization header text MUST NOT appear in the logs'
    );
    console.log('✔ Test 3 passed: Real API key is completely absent from all logs');

    // =========================================================================
    // 4. اختبار حجب تفاصيل الأخطاء غير المتوقعة (500) وعدم تسريب الأسرار في السجلات
    // =========================================================================
    console.log('Test 4: Sensitive error suppression in 500 response and logs...');
    capture.clearLogs();

    const sensitiveDatabaseSecret = 'SecretDbPass#9999_SUPER_CONFIDENTIAL_VAL';

    // إنشاء تطبيق مخصص لفحص مسار خطأ غير متوقع يتضمن كلمة مرور حساسة
    const faultyApp = buildApp({
      checkHealth: async () => {
        throw new Error(`Connection failed: postgres://postgres:${sensitiveDatabaseSecret}@db:5432/db`);
      },
      pool,
      logger: {
        level: 'info',
        stream: capture.stream,
      },
    });

    const res500 = await faultyApp.inject({
      method: 'GET',
      url: '/health/ready',
    });

    assert.equal(res500.statusCode, 500);
    assert.deepEqual(res500.json(), { error: 'Internal Server Error' });
    assert.ok(
      !res500.body.includes(sensitiveDatabaseSecret),
      'Sensitive database password must NOT be leaked in 500 HTTP response'
    );

    const all500Logs = capture.getAllLogsText();
    assert.ok(
      !all500Logs.includes(sensitiveDatabaseSecret),
      'Sensitive database password must NOT be leaked anywhere in server logs'
    );
    assert.ok(
      !all500Logs.includes('Connection failed'),
      'Raw error message must NOT be printed in unexpected request failure logs'
    );

    const logs500 = capture.getLogs();
    const failedLog = logs500.find((l) => l.event === 'request_failed');
    assert.ok(failedLog, 'Must log structured request_failed event on 500');
    assert.equal(failedLog.msg, 'Unexpected request failure');
    assert.equal(failedLog.requestId, res500.headers['x-request-id']);
    console.log('✔ Test 4 passed: Unexpected 500 error suppresses raw error and protects secrets');

    // =========================================================================
    // 5. اختبار تمييز أخطاء Fastify المعروفة (400, 413, 415) بدلاً من تحويلها إلى 500
    // =========================================================================
    console.log('Test 5: Fastify known error codes preservation (400, 413, 415)...');

    // 5.1 خطأ صياغة JSON غير صالحة (FST_ERR_CTP_INVALID_JSON_BODY) -> 400
    const resMalformedJson = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: {
        'content-type': 'application/json',
      },
      body: '{ "name": "Broken JSON, missing brace',
    });
    assert.equal(resMalformedJson.statusCode, 400);
    assert.deepEqual(
      resMalformedJson.json(),
      { error: 'Invalid request body' },
      'Malformed JSON must return 400 with { error: "Invalid request body" } without code field'
    );

    // 5.2 خطأ جسم JSON فارغ (FST_ERR_CTP_EMPTY_JSON_BODY) -> 400
    const resEmptyJson = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: {
        'content-type': 'application/json',
      },
      body: '',
    });
    assert.equal(resEmptyJson.statusCode, 400);
    assert.deepEqual(resEmptyJson.json(), { error: 'Invalid request body' });

    // 5.3 خطأ نوع محتوى غير مدعوم (FST_ERR_CTP_INVALID_MEDIA_TYPE) -> 415
    const resUnsupportedMedia = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: {
        'content-type': 'text/xml',
      },
      body: '<account><name>XML Account</name></account>',
    });
    assert.equal(resUnsupportedMedia.statusCode, 415);
    assert.deepEqual(
      resUnsupportedMedia.json(),
      { error: 'Unsupported Media Type' },
      'Unsupported media type must return 415 without converting to 500'
    );

    // 5.4 خطأ جسم أكبر من الحد المسموح (FST_ERR_CTP_BODY_TOO_LARGE) -> 413
    // Fastify الافتراضي 1 ميجابايت؛ نرسل 1.5 ميجابايت لتجاوزه
    const largeBody = JSON.stringify({ name: 'A'.repeat(1.5 * 1024 * 1024) });
    const resPayloadTooLarge = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: {
        'content-type': 'application/json',
      },
      body: largeBody,
    });
    assert.equal(resPayloadTooLarge.statusCode, 413);
    assert.deepEqual(
      resPayloadTooLarge.json(),
      { error: 'Payload Too Large' },
      'Payload too large must return 413 without converting to 500'
    );

    // 5.5 الحفاظ على أخطاء التحقق القائمة 4xx دون التأثير عليها
    const resValidation400 = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: '' }),
    });
    assert.equal(resValidation400.statusCode, 400);
    assert.deepEqual(resValidation400.json(), { error: 'Account name must not be empty' });

    const resNotFound404 = await app.inject({
      method: 'GET',
      url: '/users/usr_nonexistent_9999',
      headers: {
        authorization: `Bearer ${realApiKey}`,
      },
    });
    assert.equal(resNotFound404.statusCode, 404);
    assert.deepEqual(resNotFound404.json(), { error: 'User not found' });

    // 5.6 التحقق من أن SyntaxError الداخلي ينتج 500 وليس 400
    // نسجل المسارات التجريبية على نسخة تطبيق اختبار مخصصة قبل بدء حقن الطلبات
    const edgeCaseApp = buildApp({
      checkHealth: async () => true,
      pool,
    });

    edgeCaseApp.get('/test-internal-syntax-error', async () => {
      // محاكاة استدعاء داخلي فشل فيه JSON.parse
      JSON.parse('{ invalid internal json syntax');
    });

    edgeCaseApp.get('/test-unknown-4xx-error', async () => {
      const customErr: any = new Error('Sensitive internal diagnostic error message');
      customErr.statusCode = 400;
      throw customErr;
    });

    const resInternalSyntax = await edgeCaseApp.inject({
      method: 'GET',
      url: '/test-internal-syntax-error',
    });
    assert.equal(
      resInternalSyntax.statusCode,
      500,
      'Internal SyntaxError must return 500 Internal Server Error, NOT 400'
    );
    assert.deepEqual(resInternalSyntax.json(), { error: 'Internal Server Error' });

    // 5.7 التحقق من أن أي خطأ مجهول يحمل حالة 4xx يتحول إلى 500 دون تسريب رسالته
    const resUnknown4xx = await edgeCaseApp.inject({
      method: 'GET',
      url: '/test-unknown-4xx-error',
    });
    assert.equal(
      resUnknown4xx.statusCode,
      500,
      'Unknown error carrying 4xx statusCode must be converted to 500 without leaking error message'
    );
    assert.deepEqual(resUnknown4xx.json(), { error: 'Internal Server Error' });
    assert.ok(
      !resUnknown4xx.body.includes('Sensitive internal diagnostic error message'),
      'Sensitive diagnostic message must not be leaked to the client'
    );
    await edgeCaseApp.close();
    console.log('✔ Test 5 passed: Fastify error codes (400, 413, 415), internal SyntaxError (500), and unknown 4xx handled accurately');

    // =========================================================================
    // 6. اختبار التراجع الذري عند انقضاء مهلة الاستعلام (Statement Timeout 57014)
    // =========================================================================
    console.log('Test 6: PostgreSQL statement timeout inside transaction guarantees atomic rollback...');

    const initialName = 'Timeout Test Account Initial';
    const accountForTimeout = await createAccount(pool, {
      name: initialName,
      planId: 'plan_default_account',
    });

    // ننفذ عملية داخل معاملة withAccountLock تضبط مهلة 50ms وتستدعي sleep(150ms)
    let caughtTimeoutError: any = null;
    try {
      await withAccountLock(pool, accountForTimeout.id, async (client) => {
        // إجراء تعديل تجريبي داخل المعاملة
        await client.query(
          'UPDATE accounts SET name = $1 WHERE id = $2',
          ['Modified Name Should Be Rolled Back', accountForTimeout.id]
        );

        // ضبط مهلة قصيرة وتنفيذ استعلام يتجاوزها
        await client.query('SET LOCAL statement_timeout = 50');
        await client.query('SELECT pg_sleep(0.15)');
      });
    } catch (err: any) {
      caughtTimeoutError = err;
    }

    assert.ok(caughtTimeoutError, 'Must throw error when statement timeout occurs');
    assert.equal(caughtTimeoutError.code, '57014', 'PostgreSQL error code must be 57014 (query_canceled)');

    // التحقق أن التعديل تم التراجع عنه بالكامل في قاعدة البيانات (Atomic Rollback)
    const checkAccountRes = await pool.query(
      'SELECT name FROM accounts WHERE id = $1',
      [accountForTimeout.id]
    );
    assert.equal(
      checkAccountRes.rows[0].name,
      initialName,
      'Account name modification must be rolled back completely after timeout'
    );
    console.log('✔ Test 6 passed: Statement timeout 57014 triggers clean transaction rollback');

    // =========================================================================
    // 7. تدقيق أمني ثابت لملفات الكود المصدرية (Source Code Static Audit)
    // =========================================================================
    console.log('Test 7: Static audit of source files for raw error logging...');

    const filesToAudit = ['src/app.ts', 'src/auth.ts', 'src/server.ts', 'src/db.ts'];
    for (const relativePath of filesToAudit) {
      const fullPath = resolve(process.cwd(), relativePath);
      const content = readFileSync(fullPath, 'utf-8');

      // 7.1 التأكد من عدم وجود console.error(..., err) أو console.error(..., error)
      const hasConsoleErrorWithArg = /console\.error\([^)]*(?:err|error)\.message/i.test(content);
      assert.ok(
        !hasConsoleErrorWithArg,
        `File ${relativePath} must NOT log error.message to console`
      );

      // 7.2 التأكد من عدم وجود console.error(..., err)
      const hasConsoleErrorObject = /console\.error\([^)]*,\s*(?:err|error)\s*\)/i.test(content);
      assert.ok(
        !hasConsoleErrorObject,
        `File ${relativePath} must NOT pass raw error object to console.error`
      );
    }
    console.log('✔ Test 7 passed: Source files audit confirmed zero raw error leakage');

    console.log('\n--- All Part 26 Errors & Logging Tests Passed Successfully! ---');
  } finally {
    await app.close();
    await pool.end();
  }
}

runErrorsAndLoggingTests().catch((error) => {
  console.error('Errors and logging test suite failed:', error);
  process.exit(1);
});

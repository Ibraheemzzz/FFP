import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { buildApp } from '../../src/app.js';
import { initEnvironment, loadConfig } from '../../src/config.js';
import { createPool } from '../../src/db.js';
import { runMigrations } from '../../src/migrator.js';
import { createClientServer } from '../server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDir = path.resolve(__dirname, '..');

function getDatabaseUrl(baseUrl: string, dbName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

async function setupIsolatedDatabase(adminPool: pg.Pool, dbName: string): Promise<void> {
  await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await adminPool.query(`CREATE DATABASE ${dbName}`);
}

async function runClientTests(): Promise<void> {
  console.log('[test] Starting standalone client test suite...');

  // 1. Static asset verification
  console.log('[test] 1. Checking client files and structure...');
  const htmlPath = path.join(clientDir, 'index.html');
  const cssPath = path.join(clientDir, 'style.css');
  const jsPath = path.join(clientDir, 'app.js');

  assert.ok(fs.existsSync(htmlPath), 'index.html must exist in client directory');
  assert.ok(fs.existsSync(cssPath), 'style.css must exist in client directory');
  assert.ok(fs.existsSync(jsPath), 'app.js must exist in client directory');

  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const cssContent = fs.readFileSync(cssPath, 'utf8');
  const jsContent = fs.readFileSync(jsPath, 'utf8');

  assert.ok(htmlContent.includes('rel="stylesheet" href="style.css"'), 'HTML must link to style.css');
  assert.ok(htmlContent.includes('src="app.js"'), 'HTML must script app.js');
  assert.ok(htmlContent.includes('Usage Metering & Quotas Service'), 'HTML must contain English title');
  assert.ok(cssContent.length > 500, 'style.css must contain styling definitions');
  assert.ok(jsContent.includes('function createNewAccount'), 'app.js must define createNewAccount');
  assert.ok(jsContent.includes('function createUser'), 'app.js must define createUser');
  assert.ok(jsContent.includes('function sendConsumption'), 'app.js must define sendConsumption');
  assert.ok(jsContent.includes('function runScenario'), 'app.js must define runScenario');
  assert.ok(jsContent.includes('function maskToken'), 'app.js must define maskToken');
  assert.ok(!jsContent.includes('.innerHTML ='), 'app.js must not assign to innerHTML directly (safe DOM rendering)');

  // Verify English content (no Arabic characters in client code/markup)
  const arabicRegex = /[\u0600-\u06FF]/;
  assert.equal(arabicRegex.test(htmlContent), false, 'client/index.html must be 100% English');
  assert.equal(arabicRegex.test(cssContent), false, 'client/style.css must be 100% English');
  assert.equal(arabicRegex.test(jsContent), false, 'client/app.js must be 100% English');
  console.log('  -> Static files integrity and XSS prevention verified.');

  // 2. Initialize database and boot Fastify service
  console.log('[test] 2. Booting backend service and client reverse proxy...');
  initEnvironment();
  const config = loadConfig();
  const adminPool = createPool(config.DATABASE_URL);
  const TEST_DB_NAME = 'usage_metering_client_test';

  let testPool: pg.Pool | undefined;
  let proxyServer: ReturnType<typeof createClientServer> | undefined;

  try {
    await setupIsolatedDatabase(adminPool, TEST_DB_NAME);
    testPool = createPool(getDatabaseUrl(config.DATABASE_URL, TEST_DB_NAME));
    await runMigrations(testPool);

    const app = buildApp({
      checkHealth: async () => true,
      pool: testPool,
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const appAddress = app.server.address();
    const servicePort = typeof appAddress === 'object' && appAddress ? appAddress.port : 3000;
    const serviceUrl = `http://127.0.0.1:${servicePort}`;

    proxyServer = createClientServer({ apiBaseUrl: serviceUrl });
    await new Promise<void>((resolve) => proxyServer!.listen(0, '127.0.0.1', () => resolve()));
    const proxyAddress = proxyServer.address();
    const proxyPort = typeof proxyAddress === 'object' && proxyAddress ? proxyAddress.port : 4000;
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    // 3. Test static file serving & strict whitelist security
    console.log('[test] 3. Testing static file whitelist & path traversal prevention...');
    const resHtml = await fetch(`${proxyUrl}/`);
    assert.equal(resHtml.status, 200);
    assert.ok(resHtml.headers.get('content-type')?.includes('text/html'));
    const bodyHtml = await resHtml.text();
    assert.ok(bodyHtml.includes('Interactive Web Console'));

    const resCss = await fetch(`${proxyUrl}/style.css`);
    assert.equal(resCss.status, 200);
    assert.ok(resCss.headers.get('content-type')?.includes('text/css'));

    const resJs = await fetch(`${proxyUrl}/app.js`);
    assert.equal(resJs.status, 200);
    assert.ok(resJs.headers.get('content-type')?.includes('javascript'));

    // Verify non-whitelisted path returns 404
    const resForbidden = await fetch(`${proxyUrl}/server.ts`);
    assert.equal(resForbidden.status, 404);

    const resTraversal = await fetch(`${proxyUrl}/../package.json`);
    assert.equal(resTraversal.status, 404);

    // 4. Test reverse-proxy forward and origin locking
    console.log('[test] 4. Testing reverse-proxy forwarding and authority locking...');
    const resHealth = await fetch(`${proxyUrl}/api/health/ready`);
    assert.equal(resHealth.status, 200);
    const healthData = (await resHealth.json()) as { ready: boolean; database: string };
    assert.equal(healthData.ready, true);
    assert.equal(healthData.database, 'connected');

    // 5. End-to-end scenario execution through the proxy
    console.log('[test] 5. Running end-to-end scenario flow through proxy...');

    // A. Create Account
    const accRes = await fetch(`${proxyUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Web Client Automated Account' }),
    });
    assert.equal(accRes.status, 201);
    const accData = (await accRes.json()) as { id: string; apiKey: string };
    assert.ok(accData.apiKey.startsWith('ffp_live_'));
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accData.apiKey}`,
    };

    // B. Create Two Users with Different Plans
    console.log('  -> Creating 2 users with different plans...');
    const user1Res = await fetch(`${proxyUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ externalId: 'user_default_plan' }),
    });
    assert.equal(user1Res.status, 201);
    const user1Data = (await user1Res.json()) as { id: string; planId: string };
    assert.equal(user1Data.planId, 'plan_default_user');

    const customPlanRes = await fetch(`${proxyUrl}/api/plans`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'VIP User Plan',
        type: 'USER',
        monthlyLimit: 25000,
        perRequestLimit: 800,
      }),
    });
    assert.equal(customPlanRes.status, 201);
    const customPlanData = (await customPlanRes.json()) as { id: string };

    const user2Res = await fetch(`${proxyUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        planId: customPlanData.id,
        externalId: 'user_vip_plan',
      }),
    });
    assert.equal(user2Res.status, 201);
    const user2Data = (await user2Res.json()) as { id: string; planId: string };
    assert.equal(user2Data.planId, customPlanData.id);

    // C. Normal Consumption (Allowed)
    console.log('  -> Testing normal consumption (Allowed)...');
    const reqId1 = 'req_client_web_001_' + Date.now();
    const consumeRes1 = await fetch(`${proxyUrl}/api/consumptions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        userId: user1Data.id,
        units: 20,
        requestId: reqId1,
      }),
    });
    assert.equal(consumeRes1.status, 200);
    const consumeData1 = (await consumeRes1.json()) as { accepted: boolean; user: { consumed: number; remaining: number } };
    assert.equal(consumeData1.accepted, true);
    assert.equal(consumeData1.user.consumed, 20);

    // D. Idempotent Replay with exact original payload (Zero double deduction)
    console.log('  -> Testing idempotency replay with exact original payload...');
    const consumeResReplay = await fetch(`${proxyUrl}/api/consumptions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        userId: user1Data.id,
        units: 20,
        requestId: reqId1,
      }),
    });
    assert.equal(consumeResReplay.status, 200);
    const consumeDataReplay = (await consumeResReplay.json()) as { accepted: boolean; user: { consumed: number } };
    assert.equal(consumeDataReplay.accepted, true);
    assert.equal(consumeDataReplay.user.consumed, 20, 'Idempotency replay must not deduct again');

    // E. Rejection: User Per-Request Cap Exceeded (Rule 2: user / max_per_request)
    console.log('  -> Testing rejection: User per-request limit...');
    const reqIdUserCap = 'req_client_web_cap_' + Date.now();
    const consumeResCap = await fetch(`${proxyUrl}/api/consumptions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        userId: user1Data.id,
        units: 600, // perRequestLimit is 500
        requestId: reqIdUserCap,
      }),
    });
    assert.equal(consumeResCap.status, 200);
    const consumeDataCap = (await consumeResCap.json()) as { accepted: boolean; reason: { scope: string; rule: string } };
    assert.equal(consumeDataCap.accepted, false);
    assert.equal(consumeDataCap.reason.scope, 'user');
    assert.equal(consumeDataCap.reason.rule, 'max_per_request');

    // F. Rejection: User Monthly Allowance Exceeded (Rule 3: user / monthly_allowance)
    console.log('  -> Testing rejection: User monthly allowance limit...');
    const tightUserPlanRes = await fetch(`${proxyUrl}/api/plans`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'Tight User Plan',
        type: 'USER',
        monthlyLimit: 30,
        perRequestLimit: 500,
      }),
    });
    assert.equal(tightUserPlanRes.status, 201);
    const tightUserPlan = (await tightUserPlanRes.json()) as { id: string };

    await fetch(`${proxyUrl}/api/users/${user1Data.id}/plan`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ planId: tightUserPlan.id }),
    });

    const reqIdUserMonthly = 'req_client_web_umonth_' + Date.now();
    const consumeResUserMonthly = await fetch(`${proxyUrl}/api/consumptions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        userId: user1Data.id,
        units: 25, // Consumed is 20 + 25 = 45 > monthlyLimit 30
        requestId: reqIdUserMonthly,
      }),
    });
    assert.equal(consumeResUserMonthly.status, 200);
    const consumeDataUserMonthly = (await consumeResUserMonthly.json()) as { accepted: boolean; reason: { scope: string; rule: string } };
    assert.equal(consumeDataUserMonthly.accepted, false);
    assert.equal(consumeDataUserMonthly.reason.scope, 'user');
    assert.equal(consumeDataUserMonthly.reason.rule, 'monthly_allowance');

    // G. Rejection: Account Monthly Allowance Exceeded (Rule 4: account / monthly_allowance)
    console.log('  -> Testing rejection: Account monthly allowance limit...');
    const tightAccountPlanRes = await fetch(`${proxyUrl}/api/plans`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'Tight Account Plan',
        type: 'ACCOUNT',
        monthlyLimit: 35,
        perRequestLimit: 500,
      }),
    });
    assert.equal(tightAccountPlanRes.status, 201);
    const tightAccountPlan = (await tightAccountPlanRes.json()) as { id: string };

    await fetch(`${proxyUrl}/api/account/plan`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ planId: tightAccountPlan.id }),
    });

    const reqIdAccMonthly = 'req_client_web_amonth_' + Date.now();
    // User 2 has consumed 0, VIP user plan has 25000 monthly limit.
    // Requesting 40 units:
    // 40 <= account perRequest (500) -> Rule 1 passes
    // 40 <= user perRequest (800) -> Rule 2 passes
    // 0 + 40 <= user monthly (25000) -> Rule 3 passes
    // Account consumed is 20 (from user1). 20 + 40 = 60 > account monthly limit (35) -> Rule 4 REJECTS!
    const consumeResAccMonthly = await fetch(`${proxyUrl}/api/consumptions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        userId: user2Data.id,
        units: 40,
        requestId: reqIdAccMonthly,
      }),
    });
    assert.equal(consumeResAccMonthly.status, 200);
    const consumeDataAccMonthly = (await consumeResAccMonthly.json()) as { accepted: boolean; reason: { scope: string; rule: string } };
    assert.equal(consumeDataAccMonthly.accepted, false);
    assert.equal(consumeDataAccMonthly.reason.scope, 'account');
    assert.equal(consumeDataAccMonthly.reason.rule, 'monthly_allowance');

    // H. Plan upgrade without resetting consumption (preserving counters)
    console.log('  -> Testing plan upgrade without resetting consumption...');
    const upgradedAccountPlanRes = await fetch(`${proxyUrl}/api/plans`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'Upgraded Account Plan',
        type: 'ACCOUNT',
        monthlyLimit: 50000,
        perRequestLimit: 1000,
      }),
    });
    const upgradedAccountPlan = (await upgradedAccountPlanRes.json()) as { id: string };

    await fetch(`${proxyUrl}/api/account/plan`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ planId: upgradedAccountPlan.id }),
    });

    const usageRes = await fetch(`${proxyUrl}/api/account/usage`, {
      headers: authHeaders,
    });
    assert.equal(usageRes.status, 200);
    const usageData = (await usageRes.json()) as { usage: { consumed: number; remaining: number }; plan: { monthlyLimit: number } };
    assert.equal(usageData.usage.consumed, 20, 'Consumed units must be strictly preserved across plan change');
    assert.equal(usageData.usage.remaining, 49980, 'Remaining allowance must update immediately');

    // I. Test Individual Plan Lookup (GET /plans/:planId)
    console.log('  -> Testing single plan lookup (GET /plans/:id)...');
    const singlePlanRes = await fetch(`${proxyUrl}/api/plans/${customPlanData.id}`, { headers: authHeaders });
    assert.equal(singlePlanRes.status, 200);
    const singlePlan = (await singlePlanRes.json()) as { id: string; name: string; monthlyLimit: number };
    assert.equal(singlePlan.id, customPlanData.id);
    assert.equal(singlePlan.name, 'VIP User Plan');

    // J. Test Individual User Lookup (GET /users/:userId)
    console.log('  -> Testing single user profile lookup (GET /users/:id)...');
    const singleUserRes = await fetch(`${proxyUrl}/api/users/${user1Data.id}`, { headers: authHeaders });
    assert.equal(singleUserRes.status, 200);
    const singleUser = (await singleUserRes.json()) as { id: string; accountId: string; externalId: string };
    assert.equal(singleUser.id, user1Data.id);
    assert.equal(singleUser.externalId, 'user_default_plan');

    // K. Test Historical Usage Queries (?month=YYYY-MM)
    console.log('  -> Testing historical usage queries (closed month format)...');
    const histAccRes = await fetch(`${proxyUrl}/api/account/usage?month=2026-09`, { headers: authHeaders });
    assert.equal(histAccRes.status, 200);
    const histAccData = (await histAccRes.json()) as { isCurrentMonth: boolean; consumed: number; remaining?: unknown };
    assert.equal(histAccData.isCurrentMonth, false);
    assert.equal(histAccData.consumed, 0);
    assert.equal(histAccData.remaining, undefined, 'Historical response must omit remaining balance');

    const histUserRes = await fetch(`${proxyUrl}/api/users/${user1Data.id}/usage?month=2026-09`, { headers: authHeaders });
    assert.equal(histUserRes.status, 200);
    const histUserData = (await histUserRes.json()) as { isCurrentMonth: boolean; userConsumed: number; remaining?: unknown };
    assert.equal(histUserData.isCurrentMonth, false);
    assert.equal(histUserData.userConsumed, 0);

    // L. Test Request History Filters & Pagination (GET /requests)
    console.log('  -> Testing request history filters & pagination...');
    // Page 1: limit 2, offset 0
    const page1Res = await fetch(`${proxyUrl}/api/requests?limit=2&offset=0`, { headers: authHeaders });
    assert.equal(page1Res.status, 200);
    const page1Data = (await page1Res.json()) as { items: Array<{ id: string }>; pagination: { limit: number; offset: number; hasMore: boolean } };
    assert.equal(page1Data.items.length, 2);
    assert.equal(page1Data.pagination.offset, 0);
    assert.equal(page1Data.pagination.hasMore, true);

    // Page 2: limit 2, offset 2
    const page2Res = await fetch(`${proxyUrl}/api/requests?limit=2&offset=2`, { headers: authHeaders });
    assert.equal(page2Res.status, 200);
    const page2Data = (await page2Res.json()) as { items: Array<{ id: string }>; pagination: { offset: number } };
    assert.equal(page2Data.items.length, 2);
    assert.equal(page2Data.pagination.offset, 2);
    assert.notEqual(page1Data.items[0].id, page2Data.items[0].id, 'Page 2 items must differ from Page 1');

    // Filter by status=ACCEPTED
    const accFilterRes = await fetch(`${proxyUrl}/api/requests?status=ACCEPTED`, { headers: authHeaders });
    assert.equal(accFilterRes.status, 200);
    const accFilterData = (await accFilterRes.json()) as { items: Array<{ status: string }> };
    assert.ok(accFilterData.items.length > 0);
    assert.ok(accFilterData.items.every((i) => i.status === 'ACCEPTED'));

    // Filter by status=REJECTED
    const rejFilterRes = await fetch(`${proxyUrl}/api/requests?status=REJECTED`, { headers: authHeaders });
    assert.equal(rejFilterRes.status, 200);
    const rejFilterData = (await rejFilterRes.json()) as { items: Array<{ status: string }> };
    assert.ok(rejFilterData.items.length > 0);
    assert.ok(rejFilterData.items.every((i) => i.status === 'REJECTED'));

    // Filter by userId
    const userFilterRes = await fetch(`${proxyUrl}/api/requests?userId=${user1Data.id}`, { headers: authHeaders });
    assert.equal(userFilterRes.status, 200);
    const userFilterData = (await userFilterRes.json()) as { items: Array<{ userId: string }> };
    assert.ok(userFilterData.items.length > 0);
    assert.ok(userFilterData.items.every((i) => i.userId === user1Data.id));

    await app.close();
    console.log('[test] All standalone client tests completed successfully.');
  } finally {
    if (proxyServer) {
      await new Promise<void>((resolve) => proxyServer!.close(() => resolve()));
    }
    if (testPool) {
      await testPool.end();
    }
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await adminPool.end();
  }
}

runClientTests().catch((err) => {
  console.error('[test] Standalone client test failed:', err);
  process.exit(1);
});

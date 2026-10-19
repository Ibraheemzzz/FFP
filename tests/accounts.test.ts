// tests/accounts.test.ts
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { initEnvironment, loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrator.js';

/**
 * Helper to construct a database URL with a specific database name
 */
function getDatabaseUrl(baseUrl: string, dbName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/**
 * Helper to initialize a fully isolated test database
 */
async function setupIsolatedDatabase(adminPool: ReturnType<typeof createPool>, dbName: string): Promise<void> {
  await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await adminPool.query(`CREATE DATABASE ${dbName}`);
}

async function runAccountTests(): Promise<void> {
  // 1. Load environment configuration
  initEnvironment();
  const config = loadConfig();

  const adminPool = createPool(config.DATABASE_URL);
  const TEST_DB_NAME = 'usage_metering_accounts_test';
  let testPool: pg.Pool | undefined;
  let app: FastifyInstance | undefined;

  try {
    // 2. Setup isolated test database and run migrations
    await setupIsolatedDatabase(adminPool, TEST_DB_NAME);
    testPool = createPool(getDatabaseUrl(config.DATABASE_URL, TEST_DB_NAME));
    await runMigrations(testPool);

    // 3. Build Fastify app connected to test database
    const testApp = buildApp({
      checkHealth: async () => true,
      pool: testPool,
    });
    app = testApp;

    // -------------------------------------------------------------------------
    // Test 1: Successfully create account with default public plan (plan_default_account)
    // -------------------------------------------------------------------------
    const resDefault = await testApp.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        name: 'Acme Corporation',
      },
    });

    assert.equal(resDefault.statusCode, 201, 'Should return HTTP 201 Created');
    const createdAccount = resDefault.json<{
      id: string;
      name: string;
      planId: string;
      apiKey: string;
      createdAt: string;
    }>();

    assert.ok(createdAccount.id.startsWith('acc_'), 'Account ID should have standard prefix acc_');
    assert.equal(createdAccount.name, 'Acme Corporation', 'Account name must match input');
    assert.equal(createdAccount.planId, 'plan_default_account', 'Default plan should be plan_default_account');
    assert.ok(createdAccount.apiKey.startsWith('ffp_live_'), 'API key must start with ffp_live_');
    assert.equal(createdAccount.apiKey.length, 9 + 64, 'API key should contain 64 hex characters after prefix');
    assert.ok(!Number.isNaN(Date.parse(createdAccount.createdAt)), 'createdAt should be a valid ISO date');
    console.log('✔ Account creation with default public plan passed (POST /accounts -> 201)');

    // -------------------------------------------------------------------------
    // Test 2: Verify API key confidentiality and SHA-256 hash storage in DB
    // -------------------------------------------------------------------------
    const dbAccountRes = await testPool.query<{
      id: string;
      name: string;
      api_key_hash: string;
      plan_id: string;
    }>('SELECT id, name, api_key_hash, plan_id FROM accounts WHERE id = $1', [createdAccount.id]);

    assert.equal(dbAccountRes.rows.length, 1, 'Account record must exist in DB');
    const dbRow = dbAccountRes.rows[0];

    // Ensure raw API key was never stored in the database
    assert.notEqual(dbRow.api_key_hash, createdAccount.apiKey, 'Raw API key must NEVER be stored in the database');

    // Ensure stored value strictly matches SHA-256 hash of the complete API key
    const expectedHash = crypto.createHash('sha256').update(createdAccount.apiKey).digest('hex');
    assert.equal(dbRow.api_key_hash, expectedHash, 'Database must strictly store SHA-256 hash of the complete API key');
    console.log('✔ API key confidentiality and SHA-256 hash storage verified');

    // -------------------------------------------------------------------------
    // Test 3: Re-submitting request generates distinct account with independent key
    // -------------------------------------------------------------------------
    const resDuplicate = await testApp.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        name: 'Acme Corporation',
      },
    });

    assert.equal(resDuplicate.statusCode, 201, 'Re-submission should succeed with 201');
    const secondAccount = resDuplicate.json<{ id: string; apiKey: string }>();
    assert.notEqual(secondAccount.id, createdAccount.id, 'New account must have a unique ID');
    assert.notEqual(secondAccount.apiKey, createdAccount.apiKey, 'New account must have a new unique API key');
    console.log('✔ Account re-submission generates distinct account verified (no idempotency)');

    // -------------------------------------------------------------------------
    // Test 4: Create account with specified public ACCOUNT plan
    // -------------------------------------------------------------------------
    // Insert second public ACCOUNT plan
    await testPool.query(
      `INSERT INTO plans (id, name, type, monthly_limit, per_request_limit, owner_account_id)
       VALUES ('plan_enterprise_account', 'Enterprise Account Plan', 'ACCOUNT', 1000000, 5000, NULL)`
    );

    const resCustomPlan = await testApp.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        name: 'Enterprise Corp',
        planId: 'plan_enterprise_account',
      },
    });

    assert.equal(resCustomPlan.statusCode, 201, 'Should return HTTP 201 Created');
    const enterpriseAccount = resCustomPlan.json<{ planId: string }>();
    assert.equal(enterpriseAccount.planId, 'plan_enterprise_account', 'Assigned plan should match requested planId');
    console.log('✔ Account creation with specified public ACCOUNT plan passed');

    // -------------------------------------------------------------------------
    // Test 5: Reject account creation with non-existent plan
    // -------------------------------------------------------------------------
    const resMissingPlan = await testApp.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        name: 'Ghost Plan Corp',
        planId: 'plan_non_existent',
      },
    });

    assert.equal(resMissingPlan.statusCode, 400, 'Non-existent plan should return HTTP 400');
    assert.match(resMissingPlan.json<{ error: string }>().error, /does not exist/i);
    console.log('✔ Non-existent plan rejection passed (HTTP 400)');

    // -------------------------------------------------------------------------
    // Test 6: Reject account creation with USER plan
    // -------------------------------------------------------------------------
    const resUserPlan = await testApp.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        name: 'User Plan Rejection Corp',
        planId: 'plan_default_user',
      },
    });

    assert.equal(resUserPlan.statusCode, 400, 'USER plan for account should return HTTP 400');
    assert.match(resUserPlan.json<{ error: string }>().error, /is a USER plan, not an ACCOUNT plan/i);
    console.log('✔ USER plan assignment rejection for account passed (HTTP 400)');

    // -------------------------------------------------------------------------
    // Test 7: Reject assigning custom plan owned by another account
    // -------------------------------------------------------------------------
    // Insert custom plan owned by the first account
    await testPool.query(
      `INSERT INTO plans (id, name, type, monthly_limit, per_request_limit, owner_account_id)
       VALUES ('plan_custom_acme', 'Acme Custom Plan', 'ACCOUNT', 200000, 2000, $1)`,
      [createdAccount.id]
    );

    const resStolenPlan = await testApp.inject({
      method: 'POST',
      url: '/accounts',
      payload: {
        name: 'Copycat Corp',
        planId: 'plan_custom_acme',
      },
    });

    assert.equal(resStolenPlan.statusCode, 400, 'Custom plan of another account should return HTTP 400');
    assert.match(resStolenPlan.json<{ error: string }>().error, /owned by another account/i);
    console.log('✔ Cross-account custom plan assignment rejection passed (HTTP 400)');

    // -------------------------------------------------------------------------
    // Test 8: Input validation rejecting empty, long, and invalid type names/planId
    // -------------------------------------------------------------------------
    const invalidInputs: Array<{ payload: unknown; headers?: Record<string, string>; desc: string }> = [
      { payload: null, headers: { 'content-type': 'application/json' }, desc: 'Null body' },
      { payload: '"string-instead-of-object"', headers: { 'content-type': 'application/json' }, desc: 'String body instead of JSON object' },
      { payload: {}, desc: 'Missing name property' },
      { payload: { name: '' }, desc: 'Empty name' },
      { payload: { name: '   ' }, desc: 'Whitespace-only name' },
      { payload: { name: 12345 }, desc: 'Numeric name' },
      { payload: { name: 'A'.repeat(101) }, desc: 'Name exceeding 100 characters' },
      { payload: { name: 'Valid Name', planId: 999 }, desc: 'Numeric planId' },
      { payload: { name: 'Valid Name', planId: '' }, desc: 'Empty planId' },
      { payload: { name: 'Valid Name', planId: '   ' }, desc: 'Whitespace-only planId' },
      { payload: { name: 'Valid Name', planId: 'p'.repeat(65) }, desc: 'PlanId exceeding 64 characters' },
    ];

    for (const testCase of invalidInputs) {
      const resInvalid = await testApp.inject({
        method: 'POST',
        url: '/accounts',
        headers: testCase.headers,
        payload: testCase.payload as Record<string, unknown>,
      });

      assert.equal(
        resInvalid.statusCode,
        400,
        `Input validation failed for case: ${testCase.desc} (expected 400, got ${resInvalid.statusCode})`
      );
      assert.ok(typeof resInvalid.json<{ error: string }>().error === 'string', 'Error message must be returned');
    }
    console.log('✔ Input validation tests for name and planId passed (HTTP 400 on invalid inputs)');

    // -------------------------------------------------------------------------
    // Test 9: Handling missing database pool configuration
    // -------------------------------------------------------------------------
    const appWithoutPool = buildApp({
      checkHealth: async () => true,
    });
    try {
      const resNoPool = await appWithoutPool.inject({
        method: 'POST',
        url: '/accounts',
        payload: { name: 'No Pool Corp' },
      });
      assert.equal(resNoPool.statusCode, 500, 'Should return HTTP 500 when database pool is not configured');
      console.log('✔ Missing pool configuration error handling passed (HTTP 500)');
    } finally {
      await appWithoutPool.close();
    }

    // -------------------------------------------------------------------------
    // Test 10: Simulate database query failure during account creation
    // -------------------------------------------------------------------------
    const failingDbPool = {
      query: async () => {
        throw new Error('fatal connection reset by peer on internal_host:5432');
      },
    } as unknown as pg.Pool;

    const appWithFailingDb = buildApp({
      checkHealth: async () => true,
      pool: failingDbPool,
    });

    try {
      const resDbError = await appWithFailingDb.inject({
        method: 'POST',
        url: '/accounts',
        payload: { name: 'Failure Test Corp' },
      });

      assert.equal(resDbError.statusCode, 500, 'Database failure must return HTTP 500');
      assert.deepEqual(
        resDbError.json(),
        { error: 'Internal Server Error' },
        'Must return generic error message'
      );
      assert.equal(
        JSON.stringify(resDbError.json()).includes('internal_host'),
        false,
        'Internal database error details must NOT leak to the client'
      );
      console.log('✔ Database failure during account creation returns safe 500 without leaking details');
    } finally {
      await appWithFailingDb.close();
    }
  } finally {
    if (app) {
      await app.close();
    }
    if (testPool) {
      await testPool.end();
    }
    // Cleanup isolated test database
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    } catch {
      // Ignore cleanup error if locked
    }
    await adminPool.end();
  }
}

try {
  await runAccountTests();
  console.log('\nAll account management tests passed successfully.');
} catch (err) {
  console.error('\nAccount test failed:', err);
  process.exit(1);
}

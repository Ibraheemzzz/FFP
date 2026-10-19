// tests/isolation.test.ts
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
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

async function runIsolationTests(): Promise<void> {
  // 1. Load environment configuration
  initEnvironment();
  const config = loadConfig();

  const adminPool = createPool(config.DATABASE_URL);
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const TEST_DB_NAME = `usage_metering_isolation_test_${Date.now()}_${randomSuffix}`;

  let isDatabaseCreated = false;
  let testPool: pg.Pool | undefined;
  let app: FastifyInstance | undefined;
  let testExecutionError: unknown = null;

  try {
    // 2. Setup isolated test database with unique name
    await adminPool.query(`CREATE DATABASE ${TEST_DB_NAME}`);
    isDatabaseCreated = true;

    testPool = createPool(getDatabaseUrl(config.DATABASE_URL, TEST_DB_NAME));
    await runMigrations(testPool);

    // 3. Build Fastify application
    const testApp = buildApp({
      checkHealth: async () => true,
      pool: testPool,
    });
    app = testApp;

    // 4. Create two independent accounts (Account A and Account B)
    const resAccountA = await testApp.inject({
      method: 'POST',
      url: '/accounts',
      payload: { name: 'Tenant Alpha' },
    });
    assert.equal(resAccountA.statusCode, 201, 'Account A creation should return 201');
    const accountA = resAccountA.json<{ id: string; apiKey: string }>();

    const resAccountB = await testApp.inject({
      method: 'POST',
      url: '/accounts',
      payload: { name: 'Tenant Beta' },
    });
    assert.equal(resAccountB.statusCode, 201, 'Account B creation should return 201');
    const accountB = resAccountB.json<{ id: string; apiKey: string }>();

    // 5. Setup test data directly via SQL queries
    // a. Private plan owned exclusively by Account A
    await testPool.query(
      `INSERT INTO plans (id, name, type, monthly_limit, per_request_limit, owner_account_id)
       VALUES ('plan_private_alpha', 'Alpha Custom Plan', 'ACCOUNT', 80000, 800, $1)`,
      [accountA.id]
    );

    // b. User belonging to Account A
    await testPool.query(
      `INSERT INTO users (id, account_id, plan_id, external_id)
       VALUES ('usr_alpha_1', $1, 'plan_default_user', 'ext_alpha_1')`,
      [accountA.id]
    );

    // -------------------------------------------------------------------------
    // Test 1: Account A successfully retrieves its own private plan -> 200 OK
    // -------------------------------------------------------------------------
    const resAOwnPlan = await testApp.inject({
      method: 'GET',
      url: '/plans/plan_private_alpha',
      headers: {
        authorization: `Bearer ${accountA.apiKey}`,
      },
    });

    assert.equal(resAOwnPlan.statusCode, 200, 'Owner account must be able to read its private plan');
    const planAData = resAOwnPlan.json<{
      id: string;
      name: string;
      type: string;
      monthlyLimit: number;
      perRequestLimit: number;
      ownerAccountId: string | null;
    }>();
    assert.equal(planAData.id, 'plan_private_alpha');
    assert.equal(planAData.ownerAccountId, accountA.id);
    assert.equal(planAData.monthlyLimit, 80000);
    console.log('✔ Account successfully retrieved its own private plan (GET /plans/:planId -> 200)');

    // -------------------------------------------------------------------------
    // Test 2: Both accounts successfully retrieve public plan (owner_account_id IS NULL) -> 200 OK
    // -------------------------------------------------------------------------
    const resAPublic = await testApp.inject({
      method: 'GET',
      url: '/plans/plan_default_account',
      headers: {
        authorization: `Bearer ${accountA.apiKey}`,
      },
    });
    assert.equal(resAPublic.statusCode, 200, 'Account A must be able to read public plans');
    assert.equal(resAPublic.json<{ ownerAccountId: string | null }>().ownerAccountId, null);

    const resBPublic = await testApp.inject({
      method: 'GET',
      url: '/plans/plan_default_account',
      headers: {
        authorization: `Bearer ${accountB.apiKey}`,
      },
    });
    assert.equal(resBPublic.statusCode, 200, 'Account B must be able to read public plans');
    assert.equal(resBPublic.json<{ ownerAccountId: string | null }>().ownerAccountId, null);
    console.log('✔ Both accounts successfully retrieved accessible public plan (200)');

    // -------------------------------------------------------------------------
    // Test 3: Account B attempts to query Account A's private plan -> 404 Not Found
    // (Access control enforced in the query itself)
    // -------------------------------------------------------------------------
    const resBOtherPrivate = await testApp.inject({
      method: 'GET',
      url: '/plans/plan_private_alpha',
      headers: {
        authorization: `Bearer ${accountB.apiKey}`,
      },
    });

    assert.equal(
      resBOtherPrivate.statusCode,
      404,
      'Account B must receive 404 when requesting private plan of Account A'
    );
    assert.deepEqual(
      resBOtherPrivate.json(),
      { error: 'Plan not found' },
      'Error message must unify missing and inaccessible resources'
    );
    console.log('✔ Cross-account private plan access rejected with 404 Not Found');

    // -------------------------------------------------------------------------
    // Test 4: Account B queries a completely non-existent plan -> identical 404 Not Found response
    // -------------------------------------------------------------------------
    const resBNonExistent = await testApp.inject({
      method: 'GET',
      url: '/plans/plan_completely_nonexistent',
      headers: {
        authorization: `Bearer ${accountB.apiKey}`,
      },
    });

    assert.equal(resBNonExistent.statusCode, 404, 'Non-existent plan must return 404');
    assert.deepEqual(
      resBNonExistent.json(),
      { error: 'Plan not found' },
      'Non-existent plan must return the exact same error response as an inaccessible plan'
    );
    console.log('✔ Non-existent plan returns identical 404 response (unifying missing and inaccessible)');

    // -------------------------------------------------------------------------
    // Test 5: Spoofed accountId via query parameters and custom headers
    // Spoofed identifier is ignored; identity strictly derives from authenticated key -> 404 Not Found
    // -------------------------------------------------------------------------
    const resSpoofed = await testApp.inject({
      method: 'GET',
      url: `/plans/plan_private_alpha?accountId=${accountA.id}`,
      headers: {
        authorization: `Bearer ${accountB.apiKey}`,
        'x-account-id': accountA.id,
      },
    });

    assert.equal(
      resSpoofed.statusCode,
      404,
      'Spoofed accountId in query params and headers must be ignored; identity relies strictly on API key'
    );
    assert.deepEqual(resSpoofed.json(), { error: 'Plan not found' });
    console.log('✔ Spoofed accountId via query params and headers ignored; identity strictly derived from API key');

    // -------------------------------------------------------------------------
    // Test 6: Direct SQL query test for user ownership condition
    // Note: This test verifies query conditions directly in DB; user routes tested in subsequent parts
    // -------------------------------------------------------------------------
    const userQuery = 'SELECT id, account_id, plan_id FROM users WHERE id = $1 AND account_id = $2';

    // a. Account A query for its user -> successfully returns row
    const resUserA = await testPool.query(userQuery, ['usr_alpha_1', accountA.id]);
    assert.equal(resUserA.rows.length, 1, 'Query for user with owner accountId must return row');
    assert.equal(resUserA.rows[0].id, 'usr_alpha_1');

    // b. Account B query for same user -> returns 0 rows (isolation inside query)
    const resUserB = await testPool.query(userQuery, ['usr_alpha_1', accountB.id]);
    assert.equal(
      resUserB.rows.length,
      0,
      'Query for user with non-owner accountId must return 0 rows (isolation inside query)'
    );
    console.log('✔ Direct SQL query condition for user ownership verified (0 rows returned for non-owner account)');

    // -------------------------------------------------------------------------
    // Test 7: Reject unauthenticated access to route -> 401 Unauthorized
    // -------------------------------------------------------------------------
    const resUnauth = await testApp.inject({
      method: 'GET',
      url: '/plans/plan_default_account',
    });
    assert.equal(resUnauth.statusCode, 401, 'Unauthenticated access to /plans/:planId must return 401');
    assert.equal(resUnauth.headers['www-authenticate'], 'Bearer');

    // -------------------------------------------------------------------------
    // Test 8: Handle database errors with generic safe 500 without leaking details
    // -------------------------------------------------------------------------
    const failingDbPool = {
      query: async () => {
        throw new Error('connection timeout: internal_db_cluster:5432');
      },
    } as unknown as pg.Pool;

    const appWithFailingDb = buildApp({
      checkHealth: async () => true,
      pool: failingDbPool,
    });

    try {
      const resDbError = await appWithFailingDb.inject({
        method: 'GET',
        url: '/plans/plan_default_account',
        headers: {
          authorization: `Bearer ${accountA.apiKey}`,
        },
      });

      assert.equal(resDbError.statusCode, 500, 'Database failure on /plans/:planId must return 500');
      assert.deepEqual(resDbError.json(), { error: 'Internal Server Error' });
      assert.equal(
        JSON.stringify(resDbError.json()).includes('internal_db_cluster'),
        false,
        'Internal database error details must NOT leak to the client'
      );
      console.log('✔ Safe 500 error returned on database failure during plan retrieval');
    } finally {
      await appWithFailingDb.close();
    }
  } catch (err) {
    testExecutionError = err;
  } finally {
    // -------------------------------------------------------------------------
    // Sequential and Independent Resource Cleanup
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

    // Preserve original test error and do not mask with cleanup error
    if (testExecutionError) {
      throw testExecutionError;
    }

    if (cleanupError) {
      throw cleanupError;
    }
  }
}

try {
  await runIsolationTests();
  console.log('\nAll account isolation and multi-tenancy tests passed successfully.');
} catch (err) {
  console.error('\nIsolation test failed:', err);
  process.exit(1);
}

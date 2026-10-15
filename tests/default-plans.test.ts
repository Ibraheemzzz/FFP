// tests/default-plans.test.ts
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { initEnvironment, loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrator.js';
import { listAccessiblePlans, type Plan } from '../src/plans.js';

function getDatabaseUrl(baseUrl: string, dbName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

async function runDefaultPlansTests(): Promise<void> {
  initEnvironment();
  const config = loadConfig();

  const adminPool = createPool(config.DATABASE_URL);
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const TEST_DB_NAME = `usage_metering_plans_test_${Date.now()}_${randomSuffix}`;

  let isDatabaseCreated = false;
  let testPool: pg.Pool | undefined;
  let app: FastifyInstance | undefined;
  let testExecutionError: unknown = null;

  try {
    // 1. Create isolated test database and apply migrations
    await adminPool.query(`CREATE DATABASE ${TEST_DB_NAME}`);
    isDatabaseCreated = true;

    testPool = createPool(getDatabaseUrl(config.DATABASE_URL, TEST_DB_NAME));
    await runMigrations(testPool);

    const testApp = buildApp({
      checkHealth: async () => true,
      pool: testPool,
    });
    app = testApp;

    // ==========================================
    // Test 1: Seeded default plans verification
    // ==========================================
    const accountPlanRow = await testPool.query(
      `SELECT id, name, type, monthly_limit, per_request_limit, owner_account_id
       FROM plans WHERE id = 'plan_default_account'`
    );
    assert.equal(accountPlanRow.rowCount, 1, 'Default account plan must exist after migration');
    const accPlan = accountPlanRow.rows[0];
    assert.equal(accPlan.type, 'ACCOUNT');
    assert.equal(Number(accPlan.monthly_limit), 100000);
    assert.equal(Number(accPlan.per_request_limit), 1000);
    assert.equal(accPlan.owner_account_id, null, 'Default plan must be public (owner is NULL)');

    const userPlanRow = await testPool.query(
      `SELECT id, name, type, monthly_limit, per_request_limit, owner_account_id
       FROM plans WHERE id = 'plan_default_user'`
    );
    assert.equal(userPlanRow.rowCount, 1, 'Default user plan must exist after migration');
    const usrPlan = userPlanRow.rows[0];
    assert.equal(usrPlan.type, 'USER');
    assert.equal(Number(usrPlan.monthly_limit), 10000);
    assert.equal(Number(usrPlan.per_request_limit), 500);
    assert.equal(usrPlan.owner_account_id, null, 'Default user plan must be public');
    console.log('✔ Default seeded plans exist with expected attributes (Part 12)');

    // ==========================================
    // Test 2: Idempotence of migration re-run
    // ==========================================
    await runMigrations(testPool);
    const countCheck = await testPool.query(
      `SELECT COUNT(*) FROM plans WHERE id IN ('plan_default_account', 'plan_default_user')`
    );
    assert.equal(parseInt(countCheck.rows[0].count, 10), 2, 'Re-running migrations must not duplicate seed plans');
    console.log('✔ Re-running migrations is idempotent and preserves seeded plans');

    // ==========================================
    // Test 3: Normal authenticated listing (Account sees public plans)
    // ==========================================
    const resAccountA = await testApp.inject({
      method: 'POST',
      url: '/accounts',
      payload: { name: 'Acme Corp' },
    });
    assert.equal(resAccountA.statusCode, 201);
    const accountA = resAccountA.json<{ id: string; apiKey: string }>();

    const resListAll = await testApp.inject({
      method: 'GET',
      url: '/plans',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
    });
    assert.equal(resListAll.statusCode, 200);
    const allPlans = resListAll.json<Plan[]>();
    assert.ok(Array.isArray(allPlans), 'Response must be an array of plans');
    const planIds = allPlans.map((p) => p.id);
    assert.ok(planIds.includes('plan_default_account'), 'Public account plan must be listed');
    assert.ok(planIds.includes('plan_default_user'), 'Public user plan must be listed');
    console.log('✔ Account without custom plans sees all public default plans via GET /plans (200)');

    // ==========================================
    // Test 4: Query filtering by ?type=ACCOUNT and ?type=USER
    // ==========================================
    const resFilterAccount = await testApp.inject({
      method: 'GET',
      url: '/plans?type=ACCOUNT',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
    });
    assert.equal(resFilterAccount.statusCode, 200);
    const accountPlans = resFilterAccount.json<Plan[]>();
    assert.ok(accountPlans.every((p) => p.type === 'ACCOUNT'), 'Filter must return only ACCOUNT plans');
    assert.ok(accountPlans.some((p) => p.id === 'plan_default_account'));

    const resFilterUser = await testApp.inject({
      method: 'GET',
      url: '/plans?type=USER',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
    });
    assert.equal(resFilterUser.statusCode, 200);
    const userPlans = resFilterUser.json<Plan[]>();
    assert.ok(userPlans.every((p) => p.type === 'USER'), 'Filter must return only USER plans');
    assert.ok(userPlans.some((p) => p.id === 'plan_default_user'));
    console.log('✔ Filtering by ?type=ACCOUNT and ?type=USER passed');

    // ==========================================
    // Test 5: Multi-tenant isolation for custom plans
    // ==========================================
    const resAccountB = await testApp.inject({
      method: 'POST',
      url: '/accounts',
      payload: { name: 'Beta Ltd' },
    });
    assert.equal(resAccountB.statusCode, 201);
    const accountB = resAccountB.json<{ id: string; apiKey: string }>();

    // Seed private custom plans directly via SQL
    await testPool.query(
      `INSERT INTO plans (id, name, type, monthly_limit, per_request_limit, owner_account_id)
       VALUES ('plan_custom_alpha', 'Alpha Private Plan', 'ACCOUNT', 60000, 600, $1)`,
      [accountA.id]
    );

    await testPool.query(
      `INSERT INTO plans (id, name, type, monthly_limit, per_request_limit, owner_account_id)
       VALUES ('plan_custom_beta', 'Beta Private Plan', 'ACCOUNT', 70000, 700, $1)`,
      [accountB.id]
    );

    // Account A listing
    const resPlansA = await testApp.inject({
      method: 'GET',
      url: '/plans',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
    });
    assert.equal(resPlansA.statusCode, 200);
    const plansA = resPlansA.json<Plan[]>();
    const idsA = plansA.map((p) => p.id);
    assert.ok(idsA.includes('plan_default_account'), 'Account A sees default account plan');
    assert.ok(idsA.includes('plan_default_user'), 'Account A sees default user plan');
    assert.ok(idsA.includes('plan_custom_alpha'), 'Account A sees its own custom plan');
    assert.ok(!idsA.includes('plan_custom_beta'), 'Account A must NOT see Account B private plan');

    // Account B listing
    const resPlansB = await testApp.inject({
      method: 'GET',
      url: '/plans',
      headers: { authorization: `Bearer ${accountB.apiKey}` },
    });
    assert.equal(resPlansB.statusCode, 200);
    const plansB = resPlansB.json<Plan[]>();
    const idsB = plansB.map((p) => p.id);
    assert.ok(idsB.includes('plan_default_account'));
    assert.ok(idsB.includes('plan_default_user'));
    assert.ok(idsB.includes('plan_custom_beta'), 'Account B sees its own custom plan');
    assert.ok(!idsB.includes('plan_custom_alpha'), 'Account B must NOT see Account A private plan');
    console.log('✔ Multi-tenant isolation verified in GET /plans (private plans visible only to owner)');

    // ==========================================
    // Test 6: Testing 200 with [] in an isolated setup without matching plans
    // ==========================================
    // An account without custom plans sees public plans.
    // To legitimately prove that GET /plans returns 200 with [] (and listAccessiblePlans returns []),
    // we test against an isolated database setup where no plans match the requested scope,
    // rather than using an invalid type (such as UNKNOWN), which must strictly be rejected with 400.
    const isolatedDbName = `usage_metering_empty_plans_test_${Date.now()}_${randomSuffix}`;
    let isIsolatedDbCreated = false;
    let isolatedPool: pg.Pool | undefined;
    let isolatedApp: FastifyInstance | undefined;

    try {
      await adminPool.query(`CREATE DATABASE ${isolatedDbName}`);
      isIsolatedDbCreated = true;
      isolatedPool = createPool(getDatabaseUrl(config.DATABASE_URL, isolatedDbName));

      // Apply initial schema only (migration 001) WITHOUT seeding default plans (migration 002)
      await isolatedPool.query(`
        CREATE TABLE plans (
            id VARCHAR(64) PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            type VARCHAR(10) NOT NULL,
            monthly_limit BIGINT NOT NULL,
            per_request_limit BIGINT NOT NULL,
            owner_account_id VARCHAR(64) NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE accounts (
            id VARCHAR(64) PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            api_key_hash CHAR(64) NOT NULL UNIQUE,
            plan_id VARCHAR(64) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      // Seed dummy account and a USER plan only (so ACCOUNT plans are completely empty)
      await isolatedPool.query(
        `INSERT INTO plans (id, name, type, monthly_limit, per_request_limit, owner_account_id)
         VALUES ('plan_single_user', 'Solo User Plan', 'USER', 1000, 100, NULL)`
      );

      const fakeKeyHash = crypto.createHash('sha256').update('ffp_live_1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff').digest('hex');
      await isolatedPool.query(
        `INSERT INTO accounts (id, name, api_key_hash, plan_id)
         VALUES ('acc_isolated_01', 'Isolated Account', $1, 'plan_single_user')`,
        [fakeKeyHash]
      );

      isolatedApp = buildApp({
        checkHealth: async () => true,
        pool: isolatedPool,
      });

      // Request GET /plans?type=ACCOUNT where zero ACCOUNT plans exist in the system
      const resEmptyList = await isolatedApp.inject({
        method: 'GET',
        url: '/plans?type=ACCOUNT',
        headers: {
          authorization: 'Bearer ffp_live_1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
        },
      });
      assert.equal(resEmptyList.statusCode, 200, 'When no plans match, status must be 200 OK');
      assert.deepEqual(resEmptyList.json(), [], 'Response payload must be empty array []');

      // Also verify listAccessiblePlans directly returns []
      const directEmpty = await listAccessiblePlans(isolatedPool, 'acc_isolated_01', 'ACCOUNT');
      assert.deepEqual(directEmpty, [], 'listAccessiblePlans must return [] when no rows match');
    } finally {
      if (isolatedApp) {
        await isolatedApp.close();
      }
      if (isolatedPool) {
        await isolatedPool.end();
      }
      if (isIsolatedDbCreated) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
          [isolatedDbName]
        );
        await adminPool.query(`DROP DATABASE ${isolatedDbName}`);
      }
    }
    console.log('✔ Empty result returns 200 with [] verified in isolated zero-match setup');

    // ==========================================
    // Test 7: Filter input validation & error handling
    // ==========================================
    // Invalid type: empty string
    const resEmptyType = await testApp.inject({
      method: 'GET',
      url: '/plans?type=',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
    });
    assert.equal(resEmptyType.statusCode, 400);
    assert.equal(
      resEmptyType.json<{ error: string }>().error,
      "Invalid plan type filter. Allowed values: 'ACCOUNT', 'USER'"
    );

    // Invalid type: lowercase 'account'
    const resLowerType = await testApp.inject({
      method: 'GET',
      url: '/plans?type=account',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
    });
    assert.equal(resLowerType.statusCode, 400);

    // Invalid type: unsupported value 'CUSTOM'
    const resCustomType = await testApp.inject({
      method: 'GET',
      url: '/plans?type=CUSTOM',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
    });
    assert.equal(resCustomType.statusCode, 400);

    // Invalid type: unsupported value 'UNKNOWN' must return 400 (not [])
    const resUnknownType = await testApp.inject({
      method: 'GET',
      url: '/plans?type=UNKNOWN',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
    });
    assert.equal(resUnknownType.statusCode, 400, 'Unknown type filter must be rejected with 400, not return []');

    // Invalid type: duplicated/array query parameter
    const resArrayType = await testApp.inject({
      method: 'GET',
      url: '/plans?type=ACCOUNT&type=USER',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
    });
    assert.equal(resArrayType.statusCode, 400);

    // Unauthenticated request
    const resUnauth = await testApp.inject({
      method: 'GET',
      url: '/plans',
    });
    assert.equal(resUnauth.statusCode, 401);
    assert.equal(resUnauth.headers['www-authenticate'], 'Bearer');
    console.log('✔ Filter parameter validation and 401 unauthorized tests passed');

    // ==========================================
    // Test 8: Simulated database failure on plans query specifically (after auth succeeds)
    // ==========================================
    // We create a custom pool wrapper where accounts queries succeed (so auth passes in preHandler),
    // but the plans query inside the route handler throws an error.
    let authPassed = false;
    const failingPlansPool = {
      query: async (text: string, params?: unknown[]) => {
        if (text.includes('FROM accounts')) {
          authPassed = true;
          return testPool!.query(text, params);
        }
        if (text.includes('FROM plans')) {
          throw new Error('Simulated database failure during plans query');
        }
        return testPool!.query(text, params);
      },
    } as unknown as pg.Pool;

    const failingApp = buildApp({
      checkHealth: async () => true,
      pool: failingPlansPool,
    });

    const resFailingQuery = await failingApp.inject({
      method: 'GET',
      url: '/plans',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
    });

    assert.equal(authPassed, true, 'Authentication must succeed first before plans query failure occurs');
    assert.equal(resFailingQuery.statusCode, 500, 'Failure during plans query must return 500');
    assert.equal(resFailingQuery.json<{ error: string }>().error, 'Internal Server Error');
    console.log('✔ Database failure in plans query specifically (after auth succeeds) returns safe 500');

  } catch (error) {
    testExecutionError = error;
  } finally {
    // Cleanup
    if (app) {
      try {
        await app.close();
      } catch (err) {
        console.error('Failed to close test Fastify application cleanly');
      }
    }

    if (testPool) {
      try {
        await testPool.end();
      } catch (err) {
        console.error('Failed to close test database pool cleanly');
      }
    }

    if (isDatabaseCreated) {
      try {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
          [TEST_DB_NAME]
        );
        await adminPool.query(`DROP DATABASE ${TEST_DB_NAME}`);
      } catch (err) {
        console.error('Failed to drop test database cleanly');
      }
    }

    try {
      await adminPool.end();
    } catch (err) {
      console.error('Failed to close admin database pool cleanly');
    }

    if (testExecutionError) {
      throw testExecutionError;
    }
  }

  console.log('\nAll default plans tests passed successfully.');
}

runDefaultPlansTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

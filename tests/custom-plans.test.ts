// tests/custom-plans.test.ts
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { initEnvironment, loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrator.js';
import type { Plan } from '../src/plans.js';

function getDatabaseUrl(baseUrl: string, dbName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

async function runCustomPlansTests(): Promise<void> {
  initEnvironment();
  const config = loadConfig();

  const adminPool = createPool(config.DATABASE_URL);
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const TEST_DB_NAME = `usage_metering_custom_plans_test_${Date.now()}_${randomSuffix}`;

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

    // Register two distinct accounts: Account A and Account B
    const resAccountA = await testApp.inject({
      method: 'POST',
      url: '/accounts',
      payload: { name: 'Alpha Tenant' },
    });
    assert.equal(resAccountA.statusCode, 201);
    const accountA = resAccountA.json<{ id: string; apiKey: string }>();

    const resAccountB = await testApp.inject({
      method: 'POST',
      url: '/accounts',
      payload: { name: 'Beta Tenant' },
    });
    assert.equal(resAccountB.statusCode, 201);
    const accountB = resAccountB.json<{ id: string; apiKey: string }>();

    // ==========================================
    // Test 1: Create custom ACCOUNT and USER plans (POST /plans -> 201 Created)
    // ==========================================
    const resCreateAccountPlan = await testApp.inject({
      method: 'POST',
      url: '/plans',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        name: 'Alpha Custom Account Plan',
        type: 'ACCOUNT',
        monthlyLimit: 500000,
        perRequestLimit: 2500,
      },
    });
    assert.equal(resCreateAccountPlan.statusCode, 201);
    const customAccountPlan = resCreateAccountPlan.json<Plan>();
    assert.ok(customAccountPlan.id.startsWith('plan_'), 'Plan ID must start with plan_ prefix');
    assert.equal(resCreateAccountPlan.headers.location, `/plans/${customAccountPlan.id}`);
    assert.equal(customAccountPlan.name, 'Alpha Custom Account Plan');
    assert.equal(customAccountPlan.type, 'ACCOUNT');
    assert.equal(customAccountPlan.monthlyLimit, 500000);
    assert.equal(customAccountPlan.perRequestLimit, 2500);
    assert.equal(customAccountPlan.ownerAccountId, accountA.id, 'Plan must be owned exclusively by Account A');
    assert.ok(customAccountPlan.createdAt);
    assert.ok(customAccountPlan.updatedAt);

    const resCreateUserPlan = await testApp.inject({
      method: 'POST',
      url: '/plans',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        name: 'Alpha Custom User Plan',
        type: 'USER',
        monthlyLimit: 20000,
        perRequestLimit: 200,
      },
    });
    assert.equal(resCreateUserPlan.statusCode, 201);
    const customUserPlan = resCreateUserPlan.json<Plan>();
    assert.equal(customUserPlan.type, 'USER');
    assert.equal(customUserPlan.ownerAccountId, accountA.id);
    console.log('✔ Creation of custom ACCOUNT and USER plans verified (201 Created + Location header)');

    // ==========================================
    // Test 2: Zero-limit acceptance on creation and modification (monthlyLimit: 0, perRequestLimit: 0)
    // ==========================================
    const resZeroLimits = await testApp.inject({
      method: 'POST',
      url: '/plans',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        name: 'Alpha Paused Tier Plan',
        type: 'USER',
        monthlyLimit: 0,
        perRequestLimit: 0,
      },
    });
    assert.equal(resZeroLimits.statusCode, 201, 'Zero limits must be accepted on creation');
    const zeroPlan = resZeroLimits.json<Plan>();
    assert.equal(zeroPlan.monthlyLimit, 0);
    assert.equal(zeroPlan.perRequestLimit, 0);

    // Update existing plan to 0
    const resUpdateToZero = await testApp.inject({
      method: 'PATCH',
      url: `/plans/${customAccountPlan.id}`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        monthlyLimit: 0,
      },
    });
    assert.equal(resUpdateToZero.statusCode, 200, 'Updating monthlyLimit to 0 must be accepted');
    assert.equal(resUpdateToZero.json<Plan>().monthlyLimit, 0, 'Value 0 must be preserved');
    console.log('✔ Zero-limit quotas (0) accepted and preserved on both creation and modification');

    // ==========================================
    // Test 3: Partial updates (PATCH /plans/:planId) and field preservation
    // ==========================================
    const resPatchPartial = await testApp.inject({
      method: 'PATCH',
      url: `/plans/${customUserPlan.id}`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        monthlyLimit: 35000,
      },
    });
    assert.equal(resPatchPartial.statusCode, 200);
    const patchedUserPlan = resPatchPartial.json<Plan>();
    assert.equal(patchedUserPlan.monthlyLimit, 35000, 'monthlyLimit should be updated');
    assert.equal(patchedUserPlan.name, 'Alpha Custom User Plan', 'name must be strictly preserved');
    assert.equal(patchedUserPlan.perRequestLimit, 200, 'perRequestLimit must be strictly preserved');
    assert.equal(patchedUserPlan.type, 'USER', 'type must be preserved');

    // Update name only
    const resPatchName = await testApp.inject({
      method: 'PATCH',
      url: `/plans/${customUserPlan.id}`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        name: 'Alpha Renamed User Plan',
      },
    });
    assert.equal(resPatchName.statusCode, 200);
    const renamedPlan = resPatchName.json<Plan>();
    assert.equal(renamedPlan.name, 'Alpha Renamed User Plan');
    assert.equal(renamedPlan.monthlyLimit, 35000, 'monthlyLimit must be preserved');
    assert.equal(renamedPlan.perRequestLimit, 200, 'perRequestLimit must be preserved');
    console.log('✔ Partial updates preserve omitted fields atomically via COALESCE');

    // ==========================================
    // Test 4: Explicit rejection of null for update fields
    // ==========================================
    const resNullName = await testApp.inject({
      method: 'PATCH',
      url: `/plans/${customUserPlan.id}`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { name: null },
    });
    assert.equal(resNullName.statusCode, 400);
    assert.equal(resNullName.json<{ error: string }>().error, 'name must not be null');

    const resNullMonthly = await testApp.inject({
      method: 'PATCH',
      url: `/plans/${customUserPlan.id}`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { monthlyLimit: null },
    });
    assert.equal(resNullMonthly.statusCode, 400);
    assert.equal(resNullMonthly.json<{ error: string }>().error, 'monthlyLimit must not be null');

    const resNullPerReq = await testApp.inject({
      method: 'PATCH',
      url: `/plans/${customUserPlan.id}`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { perRequestLimit: null },
    });
    assert.equal(resNullPerReq.statusCode, 400);
    assert.equal(resNullPerReq.json<{ error: string }>().error, 'perRequestLimit must not be null');
    console.log('✔ Explicit rejection of null in update fields passed (400 Bad Request)');

    // ==========================================
    // Test 5: Strict rejection of type modification in PATCH
    // ==========================================
    const resChangeType = await testApp.inject({
      method: 'PATCH',
      url: `/plans/${customUserPlan.id}`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { type: 'ACCOUNT' },
    });
    assert.equal(resChangeType.statusCode, 400);
    assert.equal(resChangeType.json<{ error: string }>().error, 'Plan type cannot be changed');
    console.log('✔ Modifying plan type in PATCH is strictly forbidden (400 Bad Request)');

    // ==========================================
    // Test 6: Input validation on POST and PATCH (Unknown fields, empty body, boundaries)
    // ==========================================
    // Empty body on PATCH
    const resEmptyPatch = await testApp.inject({
      method: 'PATCH',
      url: `/plans/${customUserPlan.id}`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {},
    });
    assert.equal(resEmptyPatch.statusCode, 400);
    assert.equal(
      resEmptyPatch.json<{ error: string }>().error,
      'At least one field must be provided for update'
    );

    // Unknown field on PATCH
    const resUnknownPatch = await testApp.inject({
      method: 'PATCH',
      url: `/plans/${customUserPlan.id}`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { extraProperty: 'invalid' },
    });
    assert.equal(resUnknownPatch.statusCode, 400);
    assert.equal(resUnknownPatch.json<{ error: string }>().error, 'Unknown field: extraProperty');

    // Unknown field on POST
    const resUnknownPost = await testApp.inject({
      method: 'POST',
      url: '/plans',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        name: 'Valid Name',
        type: 'ACCOUNT',
        monthlyLimit: 1000,
        perRequestLimit: 100,
        owner_account_id: 'spoofed_id',
      },
    });
    assert.equal(resUnknownPost.statusCode, 400);
    assert.equal(resUnknownPost.json<{ error: string }>().error, 'Unknown field: owner_account_id');

    // Negative limit on PATCH
    const resNegativeLimit = await testApp.inject({
      method: 'PATCH',
      url: `/plans/${customUserPlan.id}`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { monthlyLimit: -5 },
    });
    assert.equal(resNegativeLimit.statusCode, 400);
    assert.equal(resNegativeLimit.json<{ error: string }>().error, 'monthlyLimit must not be negative');
    console.log('✔ Input validation and strict unknown field rejection verified');

    // ==========================================
    // Test 7: Public default plan modification protection (403 Forbidden)
    // ==========================================
    const resModifyDefaultAccount = await testApp.inject({
      method: 'PATCH',
      url: '/plans/plan_default_account',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { name: 'Compromised Default Account Plan' },
    });
    assert.equal(resModifyDefaultAccount.statusCode, 403);
    assert.equal(
      resModifyDefaultAccount.json<{ error: string }>().error,
      'Default public plans cannot be modified'
    );

    const resModifyDefaultUser = await testApp.inject({
      method: 'PATCH',
      url: '/plans/plan_default_user',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { monthlyLimit: 9999999 },
    });
    assert.equal(resModifyDefaultUser.statusCode, 403);
    assert.equal(
      resModifyDefaultUser.json<{ error: string }>().error,
      'Default public plans cannot be modified'
    );
    console.log('✔ Protection of public seeded plans verified (403 Forbidden on modification attempts)');

    // ==========================================
    // Test 8: Multi-tenant cross-account isolation (404 Not Found)
    // ==========================================
    // Account B attempts to update Account A's custom plan
    const resCrossUpdate = await testApp.inject({
      method: 'PATCH',
      url: `/plans/${customUserPlan.id}`,
      headers: { authorization: `Bearer ${accountB.apiKey}` },
      payload: { name: 'Hacked by Account B' },
    });
    assert.equal(resCrossUpdate.statusCode, 404, 'Cross-tenant plan modification must return 404');
    assert.equal(resCrossUpdate.json<{ error: string }>().error, 'Plan not found');

    // Verify in database that Account A plan name was NOT modified
    const dbCheck = await testPool.query(
      `SELECT name FROM plans WHERE id = $1`,
      [customUserPlan.id]
    );
    assert.equal(dbCheck.rows[0].name, 'Alpha Renamed User Plan');

    // Account B attempts to read Account A's custom plan
    const resCrossRead = await testApp.inject({
      method: 'GET',
      url: `/plans/${customUserPlan.id}`,
      headers: { authorization: `Bearer ${accountB.apiKey}` },
    });
    assert.equal(resCrossRead.statusCode, 404, 'Cross-tenant plan retrieval must return 404');

    // Updating non-existent plan ID
    const resNotFoundUpdate = await testApp.inject({
      method: 'PATCH',
      url: '/plans/plan_completely_non_existent',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { name: 'Non-existent' },
    });
    assert.equal(resNotFoundUpdate.statusCode, 404);
    assert.equal(resNotFoundUpdate.json<{ error: string }>().error, 'Plan not found');
    console.log('✔ Cross-tenant plan isolation verified (404 Not Found for foreign private plans)');

    // ==========================================
    // Test 9: Concurrent updates to different fields of the same plan
    // ==========================================
    // Create a dedicated plan for concurrency testing
    const resConcurrentBase = await testApp.inject({
      method: 'POST',
      url: '/plans',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        name: 'Concurrent Base Plan',
        type: 'ACCOUNT',
        monthlyLimit: 100000,
        perRequestLimit: 1000,
      },
    });
    assert.equal(resConcurrentBase.statusCode, 201);
    const concurrentPlanId = resConcurrentBase.json<Plan>().id;

    // Fire two simultaneous requests updating different fields:
    // Request 1 updates name, Request 2 updates monthlyLimit
    const [resConcurrent1, resConcurrent2] = await Promise.all([
      testApp.inject({
        method: 'PATCH',
        url: `/plans/${concurrentPlanId}`,
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: { name: 'Simultaneously Updated Name' },
      }),
      testApp.inject({
        method: 'PATCH',
        url: `/plans/${concurrentPlanId}`,
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: { monthlyLimit: 777777 },
      }),
    ]);

    assert.equal(resConcurrent1.statusCode, 200);
    assert.equal(resConcurrent2.statusCode, 200);

    // Fetch the plan and verify that BOTH field updates survived without one overwriting the other
    const resFinalCheck = await testApp.inject({
      method: 'GET',
      url: `/plans/${concurrentPlanId}`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
    });
    assert.equal(resFinalCheck.statusCode, 200);
    const finalPlan = resFinalCheck.json<Plan>();
    assert.equal(finalPlan.name, 'Simultaneously Updated Name', 'Name update must survive concurrent execution');
    assert.equal(finalPlan.monthlyLimit, 777777, 'monthlyLimit update must survive concurrent execution');
    assert.equal(finalPlan.perRequestLimit, 1000, 'Untouched perRequestLimit must remain intact');
    console.log('✔ Concurrent updates to distinct fields of the same plan both survived');

    // ==========================================
    // Test 10: Independence of monthly consumption and assignments from plan definition updates
    // ==========================================
    // 1. Assign customAccountPlan to accountA in accounts table
    await testPool.query(
      `UPDATE accounts SET plan_id = $1 WHERE id = $2`,
      [customAccountPlan.id, accountA.id]
    );

    // 2. Create user assigned to customUserPlan
    const resCreateUser = await testApp.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        externalId: 'ext_assigned_user_01',
        planId: customUserPlan.id,
      },
    });
    assert.equal(resCreateUser.statusCode, 201);
    const assignedUser = resCreateUser.json<{ id: string; planId: string }>();

    // 3. Seed non-zero monthly consumption for both account and user in 2026-10
    await testPool.query(
      `INSERT INTO account_monthly_usage (account_id, year_month, total_units)
       VALUES ($1, '2026-10', 4500)`,
      [accountA.id]
    );
    await testPool.query(
      `INSERT INTO user_monthly_usage (account_id, user_id, year_month, total_units)
       VALUES ($1, $2, '2026-10', 1200)`,
      [accountA.id, assignedUser.id]
    );

    // 4. Update account plan definition via PATCH /plans/:planId
    const resUpdateAccountPlan = await testApp.inject({
      method: 'PATCH',
      url: `/plans/${customAccountPlan.id}`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        monthlyLimit: 900000,
        perRequestLimit: 3000,
      },
    });
    assert.equal(resUpdateAccountPlan.statusCode, 200);

    // 5. Update user plan definition via PATCH /plans/:planId
    const resUpdateUserPlan = await testApp.inject({
      method: 'PATCH',
      url: `/plans/${customUserPlan.id}`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        monthlyLimit: 40000,
        perRequestLimit: 450,
      },
    });
    assert.equal(resUpdateUserPlan.statusCode, 200);

    // 6. Verify that account assignment and account monthly usage remain unchanged
    const accountCheck = await testPool.query(
      `SELECT plan_id FROM accounts WHERE id = $1`,
      [accountA.id]
    );
    assert.equal(accountCheck.rows[0].plan_id, customAccountPlan.id, 'Account plan assignment must remain unchanged');

    const accountUsageCheck = await testPool.query(
      `SELECT total_units FROM account_monthly_usage WHERE account_id = $1 AND year_month = '2026-10'`,
      [accountA.id]
    );
    assert.equal(
      Number(accountUsageCheck.rows[0].total_units),
      4500,
      'Account monthly consumption must not be modified or reset by plan update'
    );

    // 7. Verify that user assignment (via API) and user monthly usage remain unchanged
    const resGetUser = await testApp.inject({
      method: 'GET',
      url: `/users/${assignedUser.id}`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
    });
    assert.equal(resGetUser.statusCode, 200);
    assert.equal(resGetUser.json<{ planId: string }>().planId, customUserPlan.id, 'User plan assignment must remain unchanged');

    const userUsageCheck = await testPool.query(
      `SELECT total_units FROM user_monthly_usage WHERE user_id = $1 AND year_month = '2026-10'`,
      [assignedUser.id]
    );
    assert.equal(
      Number(userUsageCheck.rows[0].total_units),
      1200,
      'User monthly consumption must not be modified or reset by plan update'
    );

    console.log('✔ Modifying plan definition preserves existing account & user assignments and historical monthly consumption intact');

    // ==========================================
    // Test 11: Authentication & simulated database error handling
    // ==========================================
    // Unauthenticated POST /plans
    const resUnauthPost = await testApp.inject({
      method: 'POST',
      url: '/plans',
      payload: {
        name: 'Unauth Plan',
        type: 'ACCOUNT',
        monthlyLimit: 1000,
        perRequestLimit: 100,
      },
    });
    assert.equal(resUnauthPost.statusCode, 401);
    assert.equal(resUnauthPost.headers['www-authenticate'], 'Bearer');

    // Unauthenticated PATCH /plans/:planId
    const resUnauthPatch = await testApp.inject({
      method: 'PATCH',
      url: `/plans/${customUserPlan.id}`,
      payload: { name: 'Unauth' },
    });
    assert.equal(resUnauthPatch.statusCode, 401);

    // Simulated database failure after auth passes
    const failingPlansPool = {
      query: async (text: string, params?: unknown[]) => {
        if (text.includes('FROM accounts')) {
          return testPool!.query(text, params);
        }
        if (text.includes('INSERT INTO plans') || text.includes('UPDATE plans')) {
          throw new Error('Simulated database failure during plan modification');
        }
        return testPool!.query(text, params);
      },
    } as unknown as pg.Pool;

    const failingApp = buildApp({
      checkHealth: async () => true,
      pool: failingPlansPool,
    });

    const resFailingPost = await failingApp.inject({
      method: 'POST',
      url: '/plans',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        name: 'Failure Test',
        type: 'ACCOUNT',
        monthlyLimit: 1000,
        perRequestLimit: 100,
      },
    });
    assert.equal(resFailingPost.statusCode, 500);
    assert.equal(resFailingPost.json<{ error: string }>().error, 'Internal Server Error');

    const resFailingPatch = await failingApp.inject({
      method: 'PATCH',
      url: `/plans/${customUserPlan.id}`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { name: 'Failure Patch' },
    });
    assert.equal(resFailingPatch.statusCode, 500);
    assert.equal(resFailingPatch.json<{ error: string }>().error, 'Internal Server Error');
    console.log('✔ Authentication checks and database failure handling verified (safe 500 responses)');

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

  console.log('\nAll custom plans tests passed successfully.');
}

runCustomPlansTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

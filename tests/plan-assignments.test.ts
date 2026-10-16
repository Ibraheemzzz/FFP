// tests/plan-assignments.test.ts
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

async function runPlanAssignmentsTests(): Promise<void> {
  initEnvironment();
  const config = loadConfig();

  const adminPool = createPool(config.DATABASE_URL);
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const TEST_DB_NAME = `usage_metering_plan_assignments_test_${Date.now()}_${randomSuffix}`;

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

    // 2. Register two distinct accounts: Account A and Account B
    const resAccountA = await testApp.inject({
      method: 'POST',
      url: '/accounts',
      payload: { name: 'Acme Alpha' },
    });
    assert.equal(resAccountA.statusCode, 201);
    const accountA = resAccountA.json<{ id: string; apiKey: string; planId: string }>();
    assert.equal(accountA.planId, 'plan_default_account', 'Account A initially has default account plan');

    const resAccountB = await testApp.inject({
      method: 'POST',
      url: '/accounts',
      payload: { name: 'Beta Industries' },
    });
    assert.equal(resAccountB.statusCode, 201);
    const accountB = resAccountB.json<{ id: string; apiKey: string; planId: string }>();

    // 3. Create custom plans
    // Account A creates a custom ACCOUNT plan
    const resCustomAccA = await testApp.inject({
      method: 'POST',
      url: '/plans',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        name: 'Alpha Custom Account Plan',
        type: 'ACCOUNT',
        monthlyLimit: 250000,
        perRequestLimit: 2000,
      },
    });
    assert.equal(resCustomAccA.statusCode, 201);
    const customAccPlanA = resCustomAccA.json<Plan>();

    // Account B creates a custom ACCOUNT plan
    const resCustomAccB = await testApp.inject({
      method: 'POST',
      url: '/plans',
      headers: { authorization: `Bearer ${accountB.apiKey}` },
      payload: {
        name: 'Beta Private Account Plan',
        type: 'ACCOUNT',
        monthlyLimit: 300000,
        perRequestLimit: 3000,
      },
    });
    assert.equal(resCustomAccB.statusCode, 201);
    const customAccPlanB = resCustomAccB.json<Plan>();

    // Account A creates a custom USER plan
    const resCustomUsrA = await testApp.inject({
      method: 'POST',
      url: '/plans',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        name: 'Alpha Custom User Plan',
        type: 'USER',
        monthlyLimit: 15000,
        perRequestLimit: 150,
      },
    });
    assert.equal(resCustomUsrA.statusCode, 201);
    const customUsrPlanA = resCustomUsrA.json<Plan>();

    // ==========================================
    // Test 1: Successful account plan switching (PATCH /account/plan -> 200 OK)
    // ==========================================
    const resSwitchAccountPlan = await testApp.inject({
      method: 'PATCH',
      url: '/account/plan',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        planId: customAccPlanA.id,
      },
    });
    assert.equal(resSwitchAccountPlan.statusCode, 200);
    const updatedAccountProfile = resSwitchAccountPlan.json<{
      id: string;
      name: string;
      planId: string;
      createdAt: string;
    }>();
    assert.equal(updatedAccountProfile.id, accountA.id);
    assert.equal(updatedAccountProfile.planId, customAccPlanA.id);

    // Verify in database directly
    const dbAccountCheck = await testPool.query(
      `SELECT plan_id FROM accounts WHERE id = $1`,
      [accountA.id]
    );
    assert.equal(dbAccountCheck.rows[0].plan_id, customAccPlanA.id);
    console.log('✔ Account plan switched successfully to custom account plan (PATCH /account/plan -> 200)');

    // ==========================================
    // Test 2: Re-assigning the current plan itself (No-op accepted)
    // ==========================================
    const resReassignSamePlan = await testApp.inject({
      method: 'PATCH',
      url: '/account/plan',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        planId: customAccPlanA.id,
      },
    });
    assert.equal(resReassignSamePlan.statusCode, 200);
    assert.equal(resReassignSamePlan.json<{ planId: string }>().planId, customAccPlanA.id);
    console.log('✔ Re-assigning current plan accepted and verified as idempotent');

    // ==========================================
    // Test 3: Rejection of USER plan assigned to an account (400 Bad Request)
    // ==========================================
    const resAssignUserPlanToAccount = await testApp.inject({
      method: 'PATCH',
      url: '/account/plan',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        planId: customUsrPlanA.id,
      },
    });
    assert.equal(resAssignUserPlanToAccount.statusCode, 400);
    assert.ok(
      resAssignUserPlanToAccount.json<{ error: string }>().error.includes('is a USER plan, not an ACCOUNT plan'),
      'Must reject assigning USER plan to an account'
    );

    // Verify in database: planId remains unchanged
    const dbAccountCheckUnchanged = await testPool.query(
      `SELECT plan_id FROM accounts WHERE id = $1`,
      [accountA.id]
    );
    assert.equal(dbAccountCheckUnchanged.rows[0].plan_id, customAccPlanA.id);
    console.log('✔ Assigning USER plan to an account strictly rejected with 400');

    // ==========================================
    // Test 4: Rejection of non-existent plan and foreign account plan with unified error message
    // ==========================================
    // Case A: Non-existent plan
    const resNonExistent = await testApp.inject({
      method: 'PATCH',
      url: '/account/plan',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        planId: 'plan_completely_imaginary_000',
      },
    });
    assert.equal(resNonExistent.statusCode, 400);
    const nonExistentError = resNonExistent.json<{ error: string }>().error;
    assert.equal(nonExistentError, 'Plan not found or not accessible');

    // Case B: Foreign account plan (owned by Account B)
    const resForeignPlan = await testApp.inject({
      method: 'PATCH',
      url: '/account/plan',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        planId: customAccPlanB.id,
      },
    });
    assert.equal(resForeignPlan.statusCode, 400);
    const foreignPlanError = resForeignPlan.json<{ error: string }>().error;
    assert.equal(foreignPlanError, 'Plan not found or not accessible');

    // Prove both return the exact same error string
    assert.equal(
      nonExistentError,
      foreignPlanError,
      'Non-existent and foreign plans must return unified error to prevent tenant discovery'
    );

    // Verify in DB that Account A plan remains intact
    const dbCheckIntact = await testPool.query(
      `SELECT plan_id FROM accounts WHERE id = $1`,
      [accountA.id]
    );
    assert.equal(dbCheckIntact.rows[0].plan_id, customAccPlanA.id);
    console.log('✔ Non-existent and foreign plans return unified 400 without modifying current plan');

    // ==========================================
    // Test 5: Input validation on PATCH /account/plan (Empty body, unknown fields, nulls, accountId injection)
    // ==========================================
    // Empty body
    const resEmptyBody = await testApp.inject({
      method: 'PATCH',
      url: '/account/plan',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {},
    });
    assert.equal(resEmptyBody.statusCode, 400);
    assert.equal(
      resEmptyBody.json<{ error: string }>().error,
      'At least one field must be provided for update'
    );

    // Null planId
    const resNullPlanId = await testApp.inject({
      method: 'PATCH',
      url: '/account/plan',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { planId: null },
    });
    assert.equal(resNullPlanId.statusCode, 400);
    assert.equal(resNullPlanId.json<{ error: string }>().error, 'planId must not be null');

    // Empty string planId
    const resEmptyPlanId = await testApp.inject({
      method: 'PATCH',
      url: '/account/plan',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { planId: '   ' },
    });
    assert.equal(resEmptyPlanId.statusCode, 400);
    assert.equal(resEmptyPlanId.json<{ error: string }>().error, 'planId must not be empty');

    // Unknown field
    const resUnknownField = await testApp.inject({
      method: 'PATCH',
      url: '/account/plan',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        planId: 'plan_default_account',
        extraProperty: 'forbidden',
      },
    });
    assert.equal(resUnknownField.statusCode, 400);
    assert.equal(resUnknownField.json<{ error: string }>().error, 'Unknown field: extraProperty');

    // Attempting to spoof accountId in body
    const resSpoofedAccountId = await testApp.inject({
      method: 'PATCH',
      url: '/account/plan',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        planId: 'plan_default_account',
        accountId: accountB.id,
      },
    });
    assert.equal(resSpoofedAccountId.statusCode, 400);
    assert.equal(resSpoofedAccountId.json<{ error: string }>().error, 'Unknown field: accountId');
    console.log('✔ Strict input validation and unknown field rejection on PATCH /account/plan passed');

    // ==========================================
    // Test 6: User plan switching & type boundary (PATCH /users/:userId/plan)
    // ==========================================
    // Create a user for Account A
    const resCreateUser = await testApp.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        externalId: 'ext_user_alpha_01',
        planId: 'plan_default_user',
      },
    });
    assert.equal(resCreateUser.statusCode, 201);
    const user1 = resCreateUser.json<{ id: string; planId: string }>();

    // Switch User 1 to custom user plan
    const resSwitchUserPlan = await testApp.inject({
      method: 'PATCH',
      url: `/users/${user1.id}/plan`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        planId: customUsrPlanA.id,
      },
    });
    assert.equal(resSwitchUserPlan.statusCode, 200);
    assert.equal(resSwitchUserPlan.json<{ planId: string }>().planId, customUsrPlanA.id);

    // Attempt to assign an ACCOUNT plan to user
    const resAssignAccountPlanToUser = await testApp.inject({
      method: 'PATCH',
      url: `/users/${user1.id}/plan`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        planId: customAccPlanA.id,
      },
    });
    assert.equal(resAssignAccountPlanToUser.statusCode, 400);

    // Verify User 1's plan in DB remains customUsrPlanA
    const dbUserCheck = await testPool.query(
      `SELECT plan_id FROM users WHERE id = $1`,
      [user1.id]
    );
    assert.equal(dbUserCheck.rows[0].plan_id, customUsrPlanA.id);
    console.log('✔ User plan switching and ACCOUNT type rejection for users verified');

    // ==========================================
    // Test 7: Preservation of monthly consumption across account and user plan switches
    // ==========================================
    // Seed monthly consumption for Account A and User 1
    await testPool.query(
      `INSERT INTO account_monthly_usage (account_id, year_month, total_units)
       VALUES ($1, '2026-10', 5500)`,
      [accountA.id]
    );
    await testPool.query(
      `INSERT INTO user_monthly_usage (account_id, user_id, year_month, total_units)
       VALUES ($1, $2, '2026-10', 1500)`,
      [accountA.id, user1.id]
    );

    // Switch Account A's plan back to default public account plan
    const resSwitchBackAcc = await testApp.inject({
      method: 'PATCH',
      url: '/account/plan',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        planId: 'plan_default_account',
      },
    });
    assert.equal(resSwitchBackAcc.statusCode, 200);

    // Switch User 1's plan back to default user plan
    const resSwitchBackUsr = await testApp.inject({
      method: 'PATCH',
      url: `/users/${user1.id}/plan`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        planId: 'plan_default_user',
      },
    });
    assert.equal(resSwitchBackUsr.statusCode, 200);

    // Verify in database: Consumption counters are strictly preserved!
    const dbAccountUsage = await testPool.query(
      `SELECT total_units FROM account_monthly_usage WHERE account_id = $1 AND year_month = '2026-10'`,
      [accountA.id]
    );
    assert.equal(
      Number(dbAccountUsage.rows[0].total_units),
      5500,
      'Account monthly usage must remain exactly 5500 after plan switch'
    );

    const dbUserUsage = await testPool.query(
      `SELECT total_units FROM user_monthly_usage WHERE user_id = $1 AND year_month = '2026-10'`,
      [user1.id]
    );
    assert.equal(
      Number(dbUserUsage.rows[0].total_units),
      1500,
      'User monthly usage must remain exactly 1500 after plan switch'
    );

    // Re-assigning the same plan while having consumption preserves consumption
    const resReassignAccSame = await testApp.inject({
      method: 'PATCH',
      url: '/account/plan',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        planId: 'plan_default_account',
      },
    });
    assert.equal(resReassignAccSame.statusCode, 200);

    const dbAccountUsageAfterSame = await testPool.query(
      `SELECT total_units FROM account_monthly_usage WHERE account_id = $1 AND year_month = '2026-10'`,
      [accountA.id]
    );
    assert.equal(Number(dbAccountUsageAfterSame.rows[0].total_units), 5500);
    console.log('✔ Switching or re-assigning account/user plans strictly preserves monthly consumption (total_units)');

    // ==========================================
    // Test 8: Authentication & error isolation
    // ==========================================
    // Unauthenticated PATCH /account/plan
    const resUnauth = await testApp.inject({
      method: 'PATCH',
      url: '/account/plan',
      payload: { planId: 'plan_default_account' },
    });
    assert.equal(resUnauth.statusCode, 401);
    assert.equal(resUnauth.headers['www-authenticate'], 'Bearer');

    // Missing database pool
    const poolMissingApp = buildApp({
      checkHealth: async () => true,
      pool: undefined,
    });
    const resMissingPool = await poolMissingApp.inject({
      method: 'PATCH',
      url: '/account/plan',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { planId: 'plan_default_account' },
    });
    assert.equal(resMissingPool.statusCode, 500);

    // Simulated database failure on accounts update
    const failingPool = {
      query: async (text: string, params?: unknown[]) => {
        if (text.includes('FROM accounts WHERE api_key_hash')) {
          return testPool!.query(text, params);
        }
        if (text.includes('FROM plans WHERE id')) {
          return testPool!.query(text, params);
        }
        if (text.includes('UPDATE accounts')) {
          throw new Error('Simulated database error during account update');
        }
        return testPool!.query(text, params);
      },
    } as unknown as pg.Pool;

    const failingApp = buildApp({
      checkHealth: async () => true,
      pool: failingPool,
    });

    const resFailingUpdate = await failingApp.inject({
      method: 'PATCH',
      url: '/account/plan',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { planId: 'plan_default_account' },
    });
    assert.equal(resFailingUpdate.statusCode, 500);
    assert.equal(resFailingUpdate.json<{ error: string }>().error, 'Internal Server Error');
    console.log('✔ Authentication checks and database failure isolation verified');

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

  console.log('\nAll plan assignment tests passed successfully.');
}

runPlanAssignmentsTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

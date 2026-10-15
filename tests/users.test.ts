// tests/users.test.ts
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { initEnvironment, loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrator.js';

function getDatabaseUrl(baseUrl: string, dbName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

async function runUsersTests(): Promise<void> {
  initEnvironment();
  const config = loadConfig();

  const adminPool = createPool(config.DATABASE_URL);
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const TEST_DB_NAME = `usage_metering_users_test_${Date.now()}_${randomSuffix}`;

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

    // 2. Create two distinct accounts: Tenant Alpha and Tenant Beta
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

    // 3. Seed custom plans directly via SQL
    // A custom USER plan owned by Account A
    await testPool.query(
      `INSERT INTO plans (id, name, type, monthly_limit, per_request_limit, owner_account_id)
       VALUES ('plan_user_alpha', 'Alpha Custom User Plan', 'USER', 5000, 100, $1)`,
      [accountA.id]
    );

    // A custom USER plan owned by Account B
    await testPool.query(
      `INSERT INTO plans (id, name, type, monthly_limit, per_request_limit, owner_account_id)
       VALUES ('plan_user_beta', 'Beta Custom User Plan', 'USER', 8000, 200, $1)`,
      [accountB.id]
    );

    // ==========================================
    // Test 1: Create user with default plan and empty body {}
    // ==========================================
    const resCreateDefault = await testApp.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {},
    });
    assert.equal(resCreateDefault.statusCode, 201, 'Empty payload should create user with default plan');
    const userDefault = resCreateDefault.json<{
      id: string;
      accountId: string;
      planId: string;
      externalId: string | null;
      createdAt: string;
    }>();
    assert.ok(userDefault.id.startsWith('usr_'), 'User id should have usr_ prefix');
    assert.equal(userDefault.accountId, accountA.id, 'User accountId must match authenticated account');
    assert.equal(userDefault.planId, 'plan_default_user', 'User should receive default user plan');
    assert.equal(userDefault.externalId, null, 'User externalId should be null when omitted');
    assert.ok(!Number.isNaN(Date.parse(userDefault.createdAt)), 'createdAt should be a valid ISO date');
    console.log('✔ User creation with default plan passed (POST /users -> 201)');

    // ==========================================
    // Test 2: Create user with externalId and custom accessible user plan
    // ==========================================
    const resCreateCustom = await testApp.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        externalId: 'emp_101',
        planId: 'plan_user_alpha',
      },
    });
    assert.equal(resCreateCustom.statusCode, 201, 'User with valid externalId and custom plan should be created');
    const userCustom = resCreateCustom.json<{
      id: string;
      accountId: string;
      planId: string;
      externalId: string | null;
    }>();
    assert.equal(userCustom.externalId, 'emp_101');
    assert.equal(userCustom.planId, 'plan_user_alpha');
    console.log('✔ User creation with externalId and custom user plan passed (201)');

    // ==========================================
    // Test 3: Multi-tenant isolation for externalId (Tenant B uses same externalId)
    // ==========================================
    const resCreateTenantB = await testApp.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${accountB.apiKey}` },
      payload: {
        externalId: 'emp_101',
      },
    });
    assert.equal(resCreateTenantB.statusCode, 201, 'Tenant B should be allowed to use same externalId');
    const userTenantB = resCreateTenantB.json<{ id: string; accountId: string; externalId: string }>();
    assert.equal(userTenantB.accountId, accountB.id);
    assert.equal(userTenantB.externalId, 'emp_101');
    console.log('✔ Multi-tenant externalId isolation verified (same externalId across distinct accounts allowed)');

    // ==========================================
    // Test 4: Duplicate externalId within same account rejected with 409 Conflict
    // ==========================================
    const resDuplicate = await testApp.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {
        externalId: 'emp_101',
      },
    });
    assert.equal(resDuplicate.statusCode, 409, 'Duplicate externalId for same account must return 409');
    const duplicateBody = resDuplicate.json<{ error: string }>();
    assert.equal(
      duplicateBody.error,
      'User with this externalId already exists for this account'
    );
    console.log('✔ Duplicate externalId within same account rejected with 409 Conflict');

    // ==========================================
    // Test 5: Concurrent duplicate externalId requests race condition (one 201, one 409)
    // ==========================================
    const concurrentExternalId = 'emp_concurrent_race';
    const [resRace1, resRace2] = await Promise.all([
      testApp.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: { externalId: concurrentExternalId },
      }),
      testApp.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: { externalId: concurrentExternalId },
      }),
    ]);
    const statuses = [resRace1.statusCode, resRace2.statusCode].sort();
    assert.deepEqual(
      statuses,
      [201, 409],
      'Under concurrent creation with same externalId, exactly one request must succeed (201) and one fail (409)'
    );
    console.log('✔ Concurrent duplicate externalId race condition verified (one 201, one 409)');

    // ==========================================
    // Test 6: Input validation on POST /users
    // ==========================================
    // Invalid body shapes
    const invalidBodies = [
      { payload: 'null', desc: 'null body' },
      { payload: JSON.stringify([1, 2, 3]), desc: 'array body' },
      { payload: JSON.stringify('primitive string'), desc: 'primitive string body' },
      { payload: JSON.stringify(12345), desc: 'primitive number body' },
    ];
    for (const testCase of invalidBodies) {
      const res = await testApp.inject({
        method: 'POST',
        url: '/users',
        headers: {
          authorization: `Bearer ${accountA.apiKey}`,
          'content-type': 'application/json',
        },
        payload: testCase.payload,
      });
      assert.equal(res.statusCode, 400, `POST /users with ${testCase.desc} should return 400`);
      assert.equal(res.json<{ error: string }>().error, 'Request body must be a valid JSON object');
    }

    // Invalid externalId: non-string, empty string, whitespace only, > 100 chars
    const invalidExternalIds = [
      { val: 12345, expectedErr: 'externalId must be a string' },
      { val: true, expectedErr: 'externalId must be a string' },
      { val: '', expectedErr: 'externalId must not be empty' },
      { val: '   ', expectedErr: 'externalId must not be empty' },
      { val: 'a'.repeat(101), expectedErr: 'externalId must not exceed 100 characters' },
    ];
    for (const testCase of invalidExternalIds) {
      const res = await testApp.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: { externalId: testCase.val },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json<{ error: string }>().error, testCase.expectedErr);
    }

    // Invalid planId: non-string, empty string, whitespace only, > 64 chars
    const invalidPlanIds = [
      { val: 9999, expectedErr: 'planId must be a string' },
      { val: false, expectedErr: 'planId must be a string' },
      { val: '', expectedErr: 'planId must not be empty' },
      { val: '   ', expectedErr: 'planId must not be empty' },
      { val: 'p'.repeat(65), expectedErr: 'planId must not exceed 64 characters' },
    ];
    for (const testCase of invalidPlanIds) {
      const res = await testApp.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: { planId: testCase.val },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json<{ error: string }>().error, testCase.expectedErr);
    }

    // Strict unknown and case-mismatched fields rejection on POST /users
    const unknownFieldCases = [
      {
        payload: { extraField: 'invalid' },
        expectedErr: 'Unknown field: extraField',
      },
      {
        payload: { externalID: 'emp_casing_test' },
        expectedErr: 'Unknown field: externalID',
      },
      {
        payload: { PlanId: 'plan_default_user' },
        expectedErr: 'Unknown field: PlanId',
      },
      {
        payload: { externalId: 'emp_valid_name', externalID: 'emp_dup_name' },
        expectedErr: 'Unknown field: externalID',
      },
    ];

    for (const testCase of unknownFieldCases) {
      const res = await testApp.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: testCase.payload,
      });
      assert.equal(res.statusCode, 400, 'Unknown or case-mismatched field must return 400');
      assert.equal(res.json<{ error: string }>().error, testCase.expectedErr);
    }

    // Verify database state: no user was saved for rejected requests
    const dbUsersCheck = await testPool.query(
      `SELECT COUNT(*) FROM users WHERE external_id IN ('emp_casing_test', 'emp_valid_name', 'emp_dup_name')`
    );
    assert.equal(
      parseInt(dbUsersCheck.rows[0].count, 10),
      0,
      'No user must be created in database for rejected payloads with unknown fields'
    );
    console.log('✔ Input validation and strict unknown-field rejection for POST /users passed (HTTP 400)');

    // ==========================================
    // Test 7: Plan validation rules on POST /users
    // ==========================================
    // ACCOUNT plan rejection
    const resAccountPlan = await testApp.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { planId: 'plan_default_account' },
    });
    assert.equal(resAccountPlan.statusCode, 400);
    assert.equal(resAccountPlan.json<{ error: string }>().error, 'Plan type must be USER');

    // Non-existent plan rejection (unified message)
    const resNonExistentPlan = await testApp.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { planId: 'plan_does_not_exist' },
    });
    assert.equal(resNonExistentPlan.statusCode, 400);
    assert.equal(
      resNonExistentPlan.json<{ error: string }>().error,
      'Plan not found or not accessible'
    );

    // Other tenant's private plan rejection (identical unified message)
    const resOtherTenantPlan = await testApp.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { planId: 'plan_user_beta' },
    });
    assert.equal(resOtherTenantPlan.statusCode, 400);
    assert.equal(
      resOtherTenantPlan.json<{ error: string }>().error,
      'Plan not found or not accessible'
    );
    console.log('✔ Plan validation on user creation verified (ACCOUNT type rejected, missing & foreign plans unified to 400)');

    // ==========================================
    // Test 8: Get User (GET /users/:userId)
    // ==========================================
    // Successful retrieval of own user
    const resGetOwn = await testApp.inject({
      method: 'GET',
      url: `/users/${userCustom.id}`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
    });
    assert.equal(resGetOwn.statusCode, 200);
    const fetchedUser = resGetOwn.json<{
      id: string;
      accountId: string;
      planId: string;
      externalId: string | null;
      createdAt: string;
    }>();
    assert.equal(fetchedUser.id, userCustom.id);
    assert.equal(fetchedUser.accountId, accountA.id);
    assert.equal(fetchedUser.planId, 'plan_user_alpha');
    assert.equal(fetchedUser.externalId, 'emp_101');

    // Non-existent user returns 404
    const resGetNonExistent = await testApp.inject({
      method: 'GET',
      url: '/users/usr_does_not_exist',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
    });
    assert.equal(resGetNonExistent.statusCode, 404);
    assert.equal(resGetNonExistent.json<{ error: string }>().error, 'User not found');

    // Tenant isolation: Tenant B trying to access Tenant A's user returns 404
    const resCrossTenantGet = await testApp.inject({
      method: 'GET',
      url: `/users/${userCustom.id}`,
      headers: { authorization: `Bearer ${accountB.apiKey}` },
    });
    assert.equal(resCrossTenantGet.statusCode, 404, 'Cross-tenant user access must return 404');
    assert.equal(resCrossTenantGet.json<{ error: string }>().error, 'User not found');
    console.log('✔ User retrieval & tenant isolation passed (GET /users/:userId -> 200 for owner, 404 for others)');

    // ==========================================
    // Test 9: Update User Plan (PATCH /users/:userId/plan)
    // ==========================================
    // Successful plan update for own user
    const resUpdateSuccess = await testApp.inject({
      method: 'PATCH',
      url: `/users/${userDefault.id}/plan`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { planId: 'plan_user_alpha' },
    });
    assert.equal(resUpdateSuccess.statusCode, 200, 'User plan update should succeed with 200');
    const updatedUser = resUpdateSuccess.json<{ id: string; planId: string }>();
    assert.equal(updatedUser.id, userDefault.id);
    assert.equal(updatedUser.planId, 'plan_user_alpha');

    // Verify change in database
    const dbCheck = await testPool.query('SELECT plan_id FROM users WHERE id = $1', [userDefault.id]);
    assert.equal(dbCheck.rows[0].plan_id, 'plan_user_alpha');

    // Validation errors on PATCH
    const invalidPatchBodies = [
      { payload: {}, expectedErr: 'planId is required' },
      { payload: { planId: 123 }, expectedErr: 'planId must be a string' },
      { payload: { planId: '   ' }, expectedErr: 'planId must not be empty' },
      { payload: { planId: 'x'.repeat(65) }, expectedErr: 'planId must not exceed 64 characters' },
    ];
    for (const testCase of invalidPatchBodies) {
      const res = await testApp.inject({
        method: 'PATCH',
        url: `/users/${userDefault.id}/plan`,
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: testCase.payload,
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json<{ error: string }>().error, testCase.expectedErr);
    }

    // Strict unknown and case-mismatched fields rejection on PATCH
    const unknownPatchCases = [
      {
        payload: { planId: 'plan_default_user', extraField: 'invalid' },
        expectedErr: 'Unknown field: extraField',
      },
      {
        payload: { PlanId: 'plan_default_user' },
        expectedErr: 'Unknown field: PlanId',
      },
      {
        payload: { plan_id: 'plan_default_user' },
        expectedErr: 'Unknown field: plan_id',
      },
    ];
    for (const testCase of unknownPatchCases) {
      const res = await testApp.inject({
        method: 'PATCH',
        url: `/users/${userDefault.id}/plan`,
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: testCase.payload,
      });
      assert.equal(res.statusCode, 400, 'Unknown or case-mismatched field in PATCH must return 400');
      assert.equal(res.json<{ error: string }>().error, testCase.expectedErr);
    }

    // Verify user plan in database remained unchanged after rejected PATCH attempts
    const dbPlanCheckAfterRejected = await testPool.query('SELECT plan_id FROM users WHERE id = $1', [userDefault.id]);
    assert.equal(
      dbPlanCheckAfterRejected.rows[0].plan_id,
      'plan_user_alpha',
      'User plan must not be modified in database upon rejected PATCH request'
    );

    // Rejection of ACCOUNT plan on PATCH
    const resPatchAccountPlan = await testApp.inject({
      method: 'PATCH',
      url: `/users/${userDefault.id}/plan`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { planId: 'plan_default_account' },
    });
    assert.equal(resPatchAccountPlan.statusCode, 400);
    assert.equal(resPatchAccountPlan.json<{ error: string }>().error, 'Plan type must be USER');

    // Rejection of non-existent plan on PATCH
    const resPatchMissingPlan = await testApp.inject({
      method: 'PATCH',
      url: `/users/${userDefault.id}/plan`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { planId: 'plan_missing' },
    });
    assert.equal(resPatchMissingPlan.statusCode, 400);
    assert.equal(resPatchMissingPlan.json<{ error: string }>().error, 'Plan not found or not accessible');

    // Rejection of other tenant's private plan on PATCH
    const resPatchForeignPlan = await testApp.inject({
      method: 'PATCH',
      url: `/users/${userDefault.id}/plan`,
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { planId: 'plan_user_beta' },
    });
    assert.equal(resPatchForeignPlan.statusCode, 400);
    assert.equal(resPatchForeignPlan.json<{ error: string }>().error, 'Plan not found or not accessible');

    // Cross-tenant PATCH rejection (Tenant B trying to update Tenant A's user returns 404)
    const resPatchCrossTenant = await testApp.inject({
      method: 'PATCH',
      url: `/users/${userDefault.id}/plan`,
      headers: { authorization: `Bearer ${accountB.apiKey}` },
      payload: { planId: 'plan_default_user' },
    });
    assert.equal(resPatchCrossTenant.statusCode, 404, 'Updating another tenant user must return 404');
    assert.equal(resPatchCrossTenant.json<{ error: string }>().error, 'User not found');

    // Non-existent user PATCH returns 404
    const resPatchNonExistent = await testApp.inject({
      method: 'PATCH',
      url: '/users/usr_non_existent/plan',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: { planId: 'plan_default_user' },
    });
    assert.equal(resPatchNonExistent.statusCode, 404);
    assert.equal(resPatchNonExistent.json<{ error: string }>().error, 'User not found');
    console.log('✔ User plan update passed (PATCH /users/:userId/plan -> 200, 400, 404)');

    // ==========================================
    // Test 10: Database error and missing pool handling
    // ==========================================
    // Missing pool configuration
    const appWithoutPool = buildApp({
      checkHealth: async () => true,
    });
    const resNoPool = await appWithoutPool.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {},
    });
    assert.equal(resNoPool.statusCode, 500);
    assert.equal(resNoPool.json<{ error: string }>().error, 'Database pool is not configured');

    // Database failure simulation on user creation
    const failingPool = {
      query: async () => {
        throw new Error('Database simulated failure');
      },
    } as unknown as pg.Pool;

    const appWithFailingPool = buildApp({
      checkHealth: async () => true,
      pool: failingPool,
    });
    const resDbFailure = await appWithFailingPool.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${accountA.apiKey}` },
      payload: {},
    });
    assert.equal(resDbFailure.statusCode, 500);
    assert.equal(resDbFailure.json<{ error: string }>().error, 'Internal Server Error');
    console.log('✔ Safe 500 error returned on missing pool and unexpected database errors');

  } catch (error) {
    testExecutionError = error;
  } finally {
    // 4. Guaranteed cleanup: close app, close testPool, drop test database, close adminPool
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

  console.log('\nAll user management tests passed successfully.');
}

runUsersTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

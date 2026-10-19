// tests/plan-changes.test.ts
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { updateAccountPlan } from '../src/accounts.js';
import { buildApp } from '../src/app.js';
import { initEnvironment, loadConfig } from '../src/config.js';
import { createPool, withAccountLock } from '../src/db.js';
import { AccountNotFoundError } from '../src/errors.js';
import { runMigrations } from '../src/migrator.js';
import { type Plan, updateCustomPlan } from '../src/plans.js';
import { type User, updateUserPlan } from '../src/users.js';

function getDatabaseUrl(
  baseUrl: string,
  dbName: string,
  queryParams?: Record<string, string>
): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${dbName}`;
  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      parsed.searchParams.set(key, value);
    }
  }
  return parsed.toString();
}

/**
 * Helper to test exclusive lock contention for each operation in an isolated environment:
 * - Creates a distinct connection pool (waiterPool) tagged with application_name
 * - Holds the account lock in an independent connection (holderClient)
 * - Observes blocking relationships in pg_stat_activity via pg_blocking_pids using testPool
 * - Uses an observation timeout shorter than statement_timeout
 * - Unlocks and verifies operation completion with guaranteed cleanup
 */
async function assertLockContentionForOperation(
  testPool: pg.Pool,
  dbUrl: string,
  accountId: string,
  operationName: string,
  runOperation: (waiterPool: pg.Pool) => Promise<void>
): Promise<void> {
  const holderClient = await testPool.connect();
  let holderCleanedUp = false;
  let testError: unknown = null;
  let cleanupError: unknown = null;

  const testTag = `waiter_${operationName}_${crypto.randomBytes(4).toString('hex')}`;
  const waiterPoolUrl = new URL(dbUrl);
  waiterPoolUrl.searchParams.set('application_name', testTag);
  const waiterPool = createPool(waiterPoolUrl.toString(), {
    max: 1,
    statementTimeoutMillis: 5000,
    queryTimeoutMillis: 7000,
  });

  // 1. Define opPromise externally so it is always accessible in finally
  let opPromise: Promise<void> | undefined;
  let operationCompleted = false;

  try {
    // 2. Acquire exclusive lock on account row in independent holder connection
    const holderPidResult = await holderClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const holderPid = holderPidResult.rows[0].pid;

    await holderClient.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await holderClient.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);

    // 3. Launch waiter operation handling rejection early to prevent unhandledRejection
    opPromise = runOperation(waiterPool).then(() => {
      operationCompleted = true;
    });

    // Handle rejection early while keeping opPromise rejected for await later
    void opPromise.catch(() => {});

    // 4. Observe blocking in pg_stat_activity with timeout shorter than statement_timeout (5000ms)
    const OBSERVATION_TIMEOUT_MS = 1000;
    const pollIntervalMs = 25;
    const startTime = Date.now();
    let detectedWaiterBlocking = false;

    while (Date.now() - startTime < OBSERVATION_TIMEOUT_MS) {
      const checkResult = await testPool.query<{ pid: number }>(
        `SELECT pid
         FROM pg_stat_activity
         WHERE application_name = $1
           AND $2 = ANY(pg_blocking_pids(pid))`,
        [testTag, holderPid]
      );

      if ((checkResult.rowCount ?? 0) > 0) {
        detectedWaiterBlocking = true;
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    assert.equal(
      detectedWaiterBlocking,
      true,
      `Expected waiter operation '${operationName}' [${testTag}] to be blocked by holder PID ${holderPid}`
    );
    assert.equal(
      operationCompleted,
      false,
      `Operation '${operationName}' should not complete while holder maintains exclusive lock`
    );

    // 5. Release lock via ROLLBACK to end test contention in normal flow
    await holderClient.query('ROLLBACK');
    holderCleanedUp = true;

    // 6. Wait for waiter operation completion after lock is released
    await opPromise;
    assert.equal(
      operationCompleted,
      true,
      `Operation '${operationName}' should complete after lock is released`
    );
  } catch (err) {
    testError = err;
  } finally {
    // Sequential cleanup:
    // a. Roll back holder transaction and release lock first so waiter is not stuck
    if (!holderCleanedUp) {
      try {
        await holderClient.query('ROLLBACK');
        holderCleanedUp = true;
      } catch (err) {
        if (!cleanupError) {
          cleanupError = err;
        }
      }
    }

    // b. Release holder client (safely discard if rollback failed)
    try {
      holderClient.release(!holderCleanedUp);
    } catch (err) {
      if (!cleanupError) {
        cleanupError = err;
      }
    }

    // c. Wait for waiter operation to settle after release (preserving original error)
    if (opPromise) {
      try {
        await opPromise;
      } catch (err) {
        if (!testError) {
          testError = err;
        }
      }
    }

    // d. Close waiterPool after operation has settled
    try {
      await waiterPool.end();
    } catch (err) {
      if (!cleanupError) {
        cleanupError = err;
      }
    }

    // e. Propagate original error and cleanup errors
    if (cleanupError) {
      console.error(`Cleanup failed for operation '${operationName}':`, cleanupError);
      if (!testError) {
        throw cleanupError;
      }
    }

    if (testError) {
      throw testError;
    }
  }
}

async function runPlanChangesTests(): Promise<void> {
  initEnvironment();
  const config = loadConfig();

  const adminPool = createPool(config.DATABASE_URL);
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const TEST_DB_NAME = `usage_metering_plan_changes_test_${Date.now()}_${randomSuffix}`;

  let isDatabaseCreated = false;
  let testPool: pg.Pool | undefined;
  let app: FastifyInstance | undefined;
  let testExecutionError: unknown = null;

  try {
    // 1. Setup isolated test database and apply migrations
    await adminPool.query(`CREATE DATABASE ${TEST_DB_NAME}`);
    isDatabaseCreated = true;

    const testDbBaseUrl = getDatabaseUrl(config.DATABASE_URL, TEST_DB_NAME);
    testPool = createPool(testDbBaseUrl, {
      max: 10,
      statementTimeoutMillis: 5000,
      queryTimeoutMillis: 7000,
    });
    await runMigrations(testPool);

    const testApp = buildApp({
      checkHealth: async () => true,
      pool: testPool,
    });
    app = testApp;

    // 2. Register two independent accounts: Account A and Account B
    const createAccARes = await app.inject({
      method: 'POST',
      url: '/accounts',
      payload: { name: 'Account A' },
    });
    assert.equal(createAccARes.statusCode, 201);
    const accountA = JSON.parse(createAccARes.body) as { id: string; apiKey: string };

    const createAccBRes = await app.inject({
      method: 'POST',
      url: '/accounts',
      payload: { name: 'Account B' },
    });
    assert.equal(createAccBRes.statusCode, 201);
    const accountB = JSON.parse(createAccBRes.body) as { id: string; apiKey: string };

    // =========================================================================
    // Test 1: Immediate effect after modifying plan via PATCH /plans/:planId
    // =========================================================================
    {
      // Create private plan for Account A
      const createPlanRes = await app.inject({
        method: 'POST',
        url: '/plans',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: {
          name: 'Account A Custom Tier',
          type: 'ACCOUNT',
          monthlyLimit: 1000,
          perRequestLimit: 100,
        },
      });
      assert.equal(createPlanRes.statusCode, 201);
      const planA = JSON.parse(createPlanRes.body) as Plan;

      // Modify plan limits
      const updatePlanRes = await app.inject({
        method: 'PATCH',
        url: `/plans/${planA.id}`,
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: {
          monthlyLimit: 2500,
          perRequestLimit: 250,
        },
      });
      assert.equal(updatePlanRes.statusCode, 200);
      const updatedPlan = JSON.parse(updatePlanRes.body) as Plan;
      assert.equal(updatedPlan.monthlyLimit, 2500);
      assert.equal(updatedPlan.perRequestLimit, 250);

      // Verify that immediate subsequent read sees new limits directly
      const getPlanRes = await app.inject({
        method: 'GET',
        url: `/plans/${planA.id}`,
        headers: { authorization: `Bearer ${accountA.apiKey}` },
      });
      assert.equal(getPlanRes.statusCode, 200);
      const fetchedPlan = JSON.parse(getPlanRes.body) as Plan;
      assert.equal(fetchedPlan.monthlyLimit, 2500);
      assert.equal(fetchedPlan.perRequestLimit, 250);

      console.log('✔ Test 1 passed: Immediate visibility of updated plan limits');
    }

    // =========================================================================
    // Test 2: Modifying shared plan reflects immediately on all assigned users
    // =========================================================================
    {
      // Create shared private user plan
      const createSharedPlanRes = await app.inject({
        method: 'POST',
        url: '/plans',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: {
          name: 'Shared Team Plan',
          type: 'USER',
          monthlyLimit: 500,
          perRequestLimit: 50,
        },
      });
      assert.equal(createSharedPlanRes.statusCode, 201);
      const sharedPlan = JSON.parse(createSharedPlanRes.body) as Plan;

      // Create users and assign shared plan
      const user1Res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: { externalId: 'ext_user_1', planId: sharedPlan.id },
      });
      assert.equal(user1Res.statusCode, 201);
      const user1 = JSON.parse(user1Res.body) as User;

      const user2Res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: { externalId: 'ext_user_2', planId: sharedPlan.id },
      });
      assert.equal(user2Res.statusCode, 201);
      const user2 = JSON.parse(user2Res.body) as User;

      // Modify shared plan by increasing limits
      const updateSharedPlanRes = await app.inject({
        method: 'PATCH',
        url: `/plans/${sharedPlan.id}`,
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: {
          monthlyLimit: 1200,
          perRequestLimit: 120,
        },
      });
      assert.equal(updateSharedPlanRes.statusCode, 200);

      // Verify via GET /users/:userId that plan assignment is retained
      const getUser1Res = await app.inject({
        method: 'GET',
        url: `/users/${user1.id}`,
        headers: { authorization: `Bearer ${accountA.apiKey}` },
      });
      assert.equal(getUser1Res.statusCode, 200);
      assert.equal((JSON.parse(getUser1Res.body) as User).planId, sharedPlan.id);

      const getUser2Res = await app.inject({
        method: 'GET',
        url: `/users/${user2.id}`,
        headers: { authorization: `Bearer ${accountA.apiKey}` },
      });
      assert.equal(getUser2Res.statusCode, 200);
      assert.equal((JSON.parse(getUser2Res.body) as User).planId, sharedPlan.id);

      // Verify via direct SQL JOIN test query using schema column names
      const joinResult = await testPool.query<{
        id: string;
        plan_id: string;
        monthly_limit: string;
        per_request_limit: string;
      }>(
        `SELECT u.id, u.plan_id, p.monthly_limit, p.per_request_limit
         FROM users u
         JOIN plans p ON u.plan_id = p.id
         WHERE u.account_id = $1 AND u.id IN ($2, $3)`,
        [accountA.id, user1.id, user2.id]
      );

      assert.equal(joinResult.rows.length, 2);
      for (const row of joinResult.rows) {
        assert.equal(row.plan_id, sharedPlan.id);
        assert.equal(Number(row.monthly_limit), 1200);
        assert.equal(Number(row.per_request_limit), 120);
      }

      console.log('✔ Test 2 passed: Shared plan modification immediately visible to multiple assigned users');
    }

    // =========================================================================
    // Test 3: Plan downgrade below current consumption does not reset or alter total_units
    // =========================================================================
    {
      // Create account plan with prior consumption
      const createAccPlanRes = await app.inject({
        method: 'POST',
        url: '/plans',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: {
          name: 'Downgrade Target Plan',
          type: 'ACCOUNT',
          monthlyLimit: 1000,
          perRequestLimit: 200,
        },
      });
      assert.equal(createAccPlanRes.statusCode, 201);
      const accPlan = JSON.parse(createAccPlanRes.body) as Plan;

      await app.inject({
        method: 'PATCH',
        url: '/account/plan',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: { planId: accPlan.id },
      });

      // Seed non-zero monthly usage for account and user
      const currentMonth = '2026-10';
      await testPool.query(
        `INSERT INTO account_monthly_usage (account_id, year_month, total_units)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id, year_month) DO UPDATE SET total_units = EXCLUDED.total_units`,
        [accountA.id, currentMonth, 850]
      );

      // Seed usage for user
      const testUserRes = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: { externalId: 'user_downgrade_test' },
      });
      assert.equal(testUserRes.statusCode, 201);
      const testUser = JSON.parse(testUserRes.body) as User;

      await testPool.query(
        `INSERT INTO user_monthly_usage (account_id, user_id, year_month, total_units)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, year_month) DO UPDATE SET total_units = EXCLUDED.total_units`,
        [accountA.id, testUser.id, currentMonth, 450]
      );

      // Downgrade account plan limits to 300 (below 850 consumed)
      const downgradeAccPlanRes = await app.inject({
        method: 'PATCH',
        url: `/plans/${accPlan.id}`,
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: { monthlyLimit: 300 },
      });
      assert.equal(downgradeAccPlanRes.statusCode, 200);

      // Verify account cumulative consumption remains unchanged
      const accUsageCheck = await testPool.query<{ total_units: string }>(
        `SELECT total_units FROM account_monthly_usage WHERE account_id = $1 AND year_month = $2`,
        [accountA.id, currentMonth]
      );
      assert.equal(Number(accUsageCheck.rows[0].total_units), 850);

      // Verify user cumulative consumption remains unchanged
      const userUsageCheck = await testPool.query<{ total_units: string }>(
        `SELECT total_units FROM user_monthly_usage WHERE user_id = $1 AND year_month = $2`,
        [testUser.id, currentMonth]
      );
      assert.equal(Number(userUsageCheck.rows[0].total_units), 450);

      console.log('✔ Test 3 passed: Plan downgrade below current consumption preserves historical total_units intact');
    }

    // =========================================================================
    // Test 4: Rigorous proof of three operations waiting for lock and unblocking after ROLLBACK
    // =========================================================================
    {
      // 4.1 Prove updateCustomPlan contention via independent waiterPool
      const customPlanRes = await app.inject({
        method: 'POST',
        url: '/plans',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: {
          name: 'Lock Test Plan',
          type: 'ACCOUNT',
          monthlyLimit: 700,
          perRequestLimit: 70,
        },
      });
      assert.equal(customPlanRes.statusCode, 201);
      const lockTestPlan = JSON.parse(customPlanRes.body) as Plan;

      await assertLockContentionForOperation(
        testPool,
        testDbBaseUrl,
        accountA.id,
        'updateCustomPlan',
        async (waiterPool) => {
          await updateCustomPlan(waiterPool, lockTestPlan.id, accountA.id, {
            monthlyLimit: 750,
          });
        }
      );

      // 4.2 Prove updateAccountPlan contention via independent waiterPool
      await assertLockContentionForOperation(
        testPool,
        testDbBaseUrl,
        accountA.id,
        'updateAccountPlan',
        async (waiterPool) => {
          await updateAccountPlan(waiterPool, accountA.id, lockTestPlan.id);
        }
      );

      // 4.3 Prove updateUserPlan contention via independent waiterPool
      const lockUserRes = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: { externalId: 'lock_test_user' },
      });
      assert.equal(lockUserRes.statusCode, 201);
      const lockUser = JSON.parse(lockUserRes.body) as User;

      const userPlanRes = await app.inject({
        method: 'POST',
        url: '/plans',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: {
          name: 'Lock Test User Plan',
          type: 'USER',
          monthlyLimit: 300,
          perRequestLimit: 30,
        },
      });
      assert.equal(userPlanRes.statusCode, 201);
      const lockUserPlan = JSON.parse(userPlanRes.body) as Plan;

      await assertLockContentionForOperation(
        testPool,
        testDbBaseUrl,
        accountA.id,
        'updateUserPlan',
        async (waiterPool) => {
          await updateUserPlan(waiterPool, lockUser.id, accountA.id, lockUserPlan.id);
        }
      );

      console.log('✔ Test 4 passed: Provable lock contention and clean unblocking for all three operations');
    }

    // =========================================================================
    // Test 5: Cross-Tenant Non-Blocking execution
    // =========================================================================
    {
      const holderClient = await testPool.connect();
      let holderCleanedUp = false;

      try {
        await holderClient.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await holderClient.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountA.id]);

        // Account B executes plan modification concurrently without blocking
        const updateBRes = await app.inject({
          method: 'PATCH',
          url: '/account/plan',
          headers: { authorization: `Bearer ${accountB.apiKey}` },
          payload: { planId: 'plan_default_account' },
        });

        assert.equal(updateBRes.statusCode, 200);

        // Account B creates and modifies private plan immediately
        const createBPlanRes = await app.inject({
          method: 'POST',
          url: '/plans',
          headers: { authorization: `Bearer ${accountB.apiKey}` },
          payload: {
            name: 'Account B Independent Plan',
            type: 'ACCOUNT',
            monthlyLimit: 5000,
            perRequestLimit: 500,
          },
        });
        assert.equal(createBPlanRes.statusCode, 201);
        const planB = JSON.parse(createBPlanRes.body) as Plan;

        const updateBPlanRes = await app.inject({
          method: 'PATCH',
          url: `/plans/${planB.id}`,
          headers: { authorization: `Bearer ${accountB.apiKey}` },
          payload: { monthlyLimit: 6000 },
        });
        assert.equal(updateBPlanRes.statusCode, 200);

        await holderClient.query('ROLLBACK');
        holderCleanedUp = true;
      } finally {
        if (!holderCleanedUp) {
          try {
            await holderClient.query('ROLLBACK');
            holderCleanedUp = true;
          } catch {
            // handle error
          }
        }
        holderClient.release(!holderCleanedUp);
      }

      console.log('✔ Test 5 passed: Cross-tenant non-blocking execution verified');
    }

    // =========================================================================
    // Test 6: Atomic rollback of actual modifications upon failure before commit
    // =========================================================================
    {
      const initialAccountCheck = await testPool.query<{ plan_id: string }>(
        'SELECT plan_id FROM accounts WHERE id = $1',
        [accountA.id]
      );
      const originalPlanId = initialAccountCheck.rows[0].plan_id;

      // Create distinct plan to prove rollback
      const rollbackProbeRes = await app.inject({
        method: 'POST',
        url: '/plans',
        headers: { authorization: `Bearer ${accountA.apiKey}` },
        payload: {
          name: 'Rollback Probe Plan',
          type: 'ACCOUNT',
          monthlyLimit: 9999,
          perRequestLimit: 999,
        },
      });
      assert.equal(rollbackProbeRes.statusCode, 201);
      const rollbackProbePlan = JSON.parse(rollbackProbeRes.body) as Plan;
      const distinctNewPlanId = rollbackProbePlan.id;

      // Prove that value to be written is strictly different from original
      assert.notEqual(
        distinctNewPlanId,
        originalPlanId,
        'distinctNewPlanId must be strictly different from originalPlanId to prove genuine rollback'
      );

      let errorCaught = false;
      try {
        await withAccountLock(testPool!, accountA.id, async (client) => {
          // Actual write modifying DB during transaction
          await client.query('UPDATE accounts SET plan_id = $1 WHERE id = $2', [
            distinctNewPlanId,
            accountA.id,
          ]);
          // Simulate failure before commit
          throw new Error('Simulated atomic failure before commit');
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'Simulated atomic failure before commit') {
          errorCaught = true;
        }
      }

      assert.equal(errorCaught, true, 'Expected simulated error to be thrown by transaction runner');

      // Verify DB rolled back modification completely and preserved original planId
      const verifyAccountCheck = await testPool.query<{ plan_id: string }>(
        'SELECT plan_id FROM accounts WHERE id = $1',
        [accountA.id]
      );
      assert.equal(verifyAccountCheck.rows[0].plan_id, originalPlanId);
      assert.notEqual(verifyAccountCheck.rows[0].plan_id, distinctNewPlanId);

      console.log('✔ Test 6 passed: Atomic rollback verified upon failure before commit (with proven distinct planId)');
    }

    // =========================================================================
    // Test 7: Verify AccountNotFoundError (404) handling across three operations when account missing
    // =========================================================================
    {
      const nonExistentAccountId = 'acc_non_existent_000000000000';

      // 7.1 withAccountLock throws AccountNotFoundError directly
      let notFoundThrown = false;
      try {
        await withAccountLock(testPool!, nonExistentAccountId, async () => {
          // should not be reached
        });
      } catch (err) {
        if (err instanceof AccountNotFoundError) {
          notFoundThrown = true;
        }
      }
      assert.equal(notFoundThrown, true, 'Expected AccountNotFoundError when locking missing account');

      // 7.2 Check direct calls with non-existent account
      await assert.rejects(
        () => updateCustomPlan(testPool!, 'any_plan', nonExistentAccountId, { name: 'New' }),
        AccountNotFoundError
      );

      await assert.rejects(
        () => updateAccountPlan(testPool!, nonExistentAccountId, 'any_plan'),
        AccountNotFoundError
      );

      await assert.rejects(
        () => updateUserPlan(testPool!, 'any_user', nonExistentAccountId, 'any_plan'),
        AccountNotFoundError
      );

      console.log('✔ Test 7 passed: Missing account handled safely with AccountNotFoundError across all three operations');
    }

    console.log('\nAll plan change, locking, and immediate effect tests passed successfully.');
  } catch (error) {
    testExecutionError = error;
    console.error('Test suite failed with error:', error);
  } finally {
    if (app) {
      await app.close();
    }
    if (testPool) {
      await testPool.end();
    }
    if (isDatabaseCreated) {
      try {
        await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
      } catch {
        console.error(`Failed to drop test database: ${TEST_DB_NAME}`);
      }
    }
    await adminPool.end();

    if (testExecutionError) {
      process.exit(1);
    }
  }
}

void runPlanChangesTests();

// tests/consumed-and-remaining.test.ts
// اختبارات المستهلك والمتبقي وقراءة العدادات الشهرية (Part 19: Consumed and Remaining)

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type pg from 'pg';
import { initEnvironment, loadConfig } from '../src/config.js';
import { createPool, type DbExecutor } from '../src/db.js';
import { runMigrations } from '../src/migrator.js';
import {
  calculateUsageSnapshot,
  getAccountMonthlyUsage,
  getUserMonthlyUsage,
} from '../src/consumptions.js';

async function runConsumedAndRemainingTests(): Promise<void> {
  console.log('--- Starting Consumed and Remaining Tests (Part 19) ---');

  // ==========================================
  // Test Group 1: Pure calculateUsageSnapshot Unit Tests
  // ==========================================
  {
    // 1. Normal usage: limit 100, consumed 40 -> remaining 60
    const snapshot1 = calculateUsageSnapshot(100, 40);
    assert.equal(snapshot1.consumed, 40);
    assert.equal(snapshot1.remaining, 60);

    // 2. Full usage: limit 100, consumed 100 -> remaining 0
    const snapshot2 = calculateUsageSnapshot(100, 100);
    assert.equal(snapshot2.consumed, 100);
    assert.equal(snapshot2.remaining, 0);

    // 3. Zero usage: limit 100, consumed 0 -> remaining 100
    const snapshot3 = calculateUsageSnapshot(100, 0);
    assert.equal(snapshot3.consumed, 0);
    assert.equal(snapshot3.remaining, 100);

    // 4. Downgraded plan (consumed > limit): limit 50, consumed 80 -> remaining 0 (NEVER negative)
    const snapshot4 = calculateUsageSnapshot(50, 80);
    assert.equal(snapshot4.consumed, 80, 'Consumed must reflect historical truth without zeroing or capping');
    assert.equal(snapshot4.remaining, 0, 'Remaining must be floored at 0 and never be negative');

    // 5. Zero-limit plan: limit 0, consumed 0 -> remaining 0
    const snapshot5 = calculateUsageSnapshot(0, 0);
    assert.equal(snapshot5.consumed, 0);
    assert.equal(snapshot5.remaining, 0);

    // 6. Zero-limit plan with prior consumed units: limit 0, consumed 15 -> remaining 0
    const snapshot6 = calculateUsageSnapshot(0, 15);
    assert.equal(snapshot6.consumed, 15);
    assert.equal(snapshot6.remaining, 0);

    // 7. Large numbers near MAX_SAFE_INTEGER
    const maxSafe = Number.MAX_SAFE_INTEGER;
    const snapshot7 = calculateUsageSnapshot(maxSafe, 1000);
    assert.equal(snapshot7.consumed, 1000);
    assert.equal(snapshot7.remaining, maxSafe - 1000);

    console.log('✔ Test Group 1: Pure calculateUsageSnapshot unit tests passed');
  }

  // ==========================================
  // Test Group 2: Database Counter Queries with Pool
  // ==========================================
  initEnvironment();
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);

  try {
    // Ensure migrations are up to date
    await runMigrations(pool);

    const testAccountId = `acc_test_part19_${crypto.randomBytes(4).toString('hex')}`;
    const testUserId = `usr_test_part19_${crypto.randomBytes(4).toString('hex')}`;
    const foreignAccountId = `acc_foreign_part19_${crypto.randomBytes(4).toString('hex')}`;

    const dummyHash1 = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');
    const dummyHash2 = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');

    // Create accounts and user
    await pool.query(
      `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'Part 19 Test Account', $2, 'plan_default_account')`,
      [testAccountId, dummyHash1]
    );
    await pool.query(
      `INSERT INTO accounts (id, name, api_key_hash, plan_id) VALUES ($1, 'Part 19 Foreign Account', $2, 'plan_default_account')`,
      [foreignAccountId, dummyHash2]
    );
    await pool.query(
      `INSERT INTO users (account_id, id, plan_id) VALUES ($1, $2, 'plan_default_user')`,
      [testAccountId, testUserId]
    );

    const yearMonthOct = '2026-10';
    const yearMonthNov = '2026-11';

    // 1. Unseeded month returns 0 for account and user (get or default to 0)
    const initialAccountUsage = await getAccountMonthlyUsage(pool, testAccountId, yearMonthOct);
    assert.equal(initialAccountUsage, 0);
    assert.equal(typeof initialAccountUsage, 'number');

    const initialUserUsage = await getUserMonthlyUsage(pool, testAccountId, testUserId, yearMonthOct);
    assert.equal(initialUserUsage, 0);
    assert.equal(typeof initialUserUsage, 'number');

    // 2. Insert counter rows
    await pool.query(
      `INSERT INTO account_monthly_usage (account_id, year_month, total_units) VALUES ($1, $2, 175)`,
      [testAccountId, yearMonthOct]
    );
    await pool.query(
      `INSERT INTO user_monthly_usage (account_id, user_id, year_month, total_units) VALUES ($1, $2, $3, 42)`,
      [testAccountId, testUserId, yearMonthOct]
    );

    // 3. Query existing counter rows
    const storedAccountUsage = await getAccountMonthlyUsage(pool, testAccountId, yearMonthOct);
    assert.equal(storedAccountUsage, 175);
    assert.equal(typeof storedAccountUsage, 'number', 'BIGINT must be parsed and returned as number');

    const storedUserUsage = await getUserMonthlyUsage(pool, testAccountId, testUserId, yearMonthOct);
    assert.equal(storedUserUsage, 42);
    assert.equal(typeof storedUserUsage, 'number', 'BIGINT must be parsed and returned as number');

    // 4. Month isolation: November returns 0
    const novAccountUsage = await getAccountMonthlyUsage(pool, testAccountId, yearMonthNov);
    assert.equal(novAccountUsage, 0, 'Different month must return 0');

    const novUserUsage = await getUserMonthlyUsage(pool, testAccountId, testUserId, yearMonthNov);
    assert.equal(novUserUsage, 0, 'Different month must return 0');

    // 5. Tenant isolation: querying with foreign accountId returns 0
    const foreignUserQuery = await getUserMonthlyUsage(pool, foreignAccountId, testUserId, yearMonthOct);
    assert.equal(foreignUserQuery, 0, 'Querying with mismatched accountId must return 0');

    console.log('✔ Test Group 2: Database counter queries with pool passed');

    // ==========================================
    // Test Group 3: Support for PoolClient (DbExecutor in transactions)
    // ==========================================
    const client = await pool.connect();
    try {
      const clientAccountUsage = await getAccountMonthlyUsage(client, testAccountId, yearMonthOct);
      assert.equal(clientAccountUsage, 175);

      const clientUserUsage = await getUserMonthlyUsage(client, testAccountId, testUserId, yearMonthOct);
      assert.equal(clientUserUsage, 42);

      console.log('✔ Test Group 3: PoolClient support as DbExecutor verified');
    } finally {
      client.release();
    }

    // ==========================================
    // Test Group 4: Database Error Propagation (No Silent 0 on Failure)
    // ==========================================
    const failingExecutor: DbExecutor = {
      query: async () => {
        throw new Error('Simulated database connection failure');
      },
    } as unknown as DbExecutor;

    await assert.rejects(
      async () => {
        await getAccountMonthlyUsage(failingExecutor, testAccountId, yearMonthOct);
      },
      (err: Error) => {
        assert.equal(err.message, 'Simulated database connection failure');
        return true;
      },
      'getAccountMonthlyUsage must rethrow DB error and not convert it to 0'
    );

    await assert.rejects(
      async () => {
        await getUserMonthlyUsage(failingExecutor, testAccountId, testUserId, yearMonthOct);
      },
      (err: Error) => {
        assert.equal(err.message, 'Simulated database connection failure');
        return true;
      },
      'getUserMonthlyUsage must rethrow DB error and not convert it to 0'
    );

    console.log('✔ Test Group 4: Database failure propagation without masking to 0 verified');

  } finally {
    await pool.end();
  }

  console.log('All Consumed and Remaining Tests (Part 19) Passed Successfully!');
}

runConsumedAndRemainingTests();

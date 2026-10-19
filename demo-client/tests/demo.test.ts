// demo-client/tests/demo.test.ts
// Automated end-to-end integration test verifying standalone demo client scenarios and quota balances

import assert from 'node:assert/strict';
import path from 'node:path';
import { runDemoScenario } from '../src/index.js';
import { initEnvironment, loadConfig } from '../../src/config.js';
import { createPool, checkDatabaseHealth } from '../../src/db.js';
import { runMigrations } from '../../src/migrator.js';
import { buildApp } from '../../src/app.js';

async function runDemoClientTestSuite(): Promise<void> {
  console.log('--- Starting Standalone Demo Client Integration Test ---');

  initEnvironment(path.resolve(import.meta.dirname, '../../.env'));
  const config = loadConfig();

  const pool = createPool(config.DATABASE_URL, {
    max: 10,
    connectionTimeoutMillis: 10000,
    statementTimeoutMillis: 15000,
  });

  const migrationsDir = path.resolve(import.meta.dirname, '../../migrations');
  await runMigrations(pool, migrationsDir);

  const testPort = 3099;
  const app = buildApp({
    checkHealth: () => checkDatabaseHealth(pool),
    pool,
  });

  await app.listen({ port: testPort, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${testPort}`;

  try {
    const result = await runDemoScenario(baseUrl);

    // 1. Verify Step 3: Ahmed consumption (2 units) accepted
    assert.equal(result.step3Decision.accepted, true, 'Step 3 must be accepted');
    assert.equal(result.step3Decision.user.consumed, 2);
    assert.equal(result.step3Decision.account.consumed, 2);
    assert.equal(result.step3Decision.account.remaining, 8);

    // 2. Verify Step 4: Sara consumption (6 units) rejected due to user cap (5 units)
    assert.equal(result.step4Decision.accepted, false, 'Step 4 must be rejected');
    if (!result.step4Decision.accepted) {
      assert.equal(result.step4Decision.reason.scope, 'user');
      assert.equal(result.step4Decision.reason.rule, 'max_per_request');
    }
    assert.equal(result.step4Decision.user.consumed, 0, 'Sara consumed must remain 0 after rejection');
    assert.equal(result.step4Decision.account.consumed, 2, 'Account consumed must remain 2 after rejection');

    // 3. Verify Step 5: Ahmed consumption (9 units) rejected due to account monthly limit (8 remaining)
    assert.equal(result.step5Decision.accepted, false, 'Step 5 must be rejected');
    if (!result.step5Decision.accepted) {
      assert.equal(result.step5Decision.reason.scope, 'account');
      assert.equal(result.step5Decision.reason.rule, 'monthly_allowance');
    }
    assert.equal(result.step5Decision.user.consumed, 2, 'Ahmed consumed must remain 2 after rejection');
    assert.equal(result.step5Decision.account.consumed, 2, 'Account consumed must remain 2 after rejection');

    // 4. Verify Step 6: Sara consumption (6 units) accepted after plan elevation to per-request 10
    assert.equal(result.step6Decision.accepted, true, 'Step 6 must be accepted');
    assert.equal(result.step6Decision.user.consumed, 6);
    assert.equal(result.step6Decision.user.remaining, 24);
    assert.equal(result.step6Decision.account.consumed, 8);
    assert.equal(result.step6Decision.account.remaining, 2);

    // 5. Verify Step 7: Exact final cumulative consumption
    assert.equal(result.finalAccountConsumed, 8, 'Final account consumed must be exactly 8');
    assert.equal(result.finalAhmedConsumed, 2, 'Final Ahmed consumed must be exactly 2');
    assert.equal(result.finalSaraConsumed, 6, 'Final Sara consumed must be exactly 6');

    console.log('\n✔ All Standalone Demo Client Invariants and Quota Balances Verified Successfully!');
  } finally {
    await app.close();
    await pool.end();
  }
}

runDemoClientTestSuite().catch((err) => {
  console.error('Demo client test suite failed:', err);
  process.exit(1);
});

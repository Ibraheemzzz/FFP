// tests/db.test.ts
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { initEnvironment, loadConfig } from '../src/config.js';
import { createPool, checkDatabaseHealth } from '../src/db.js';

// Dedicated unused port to verify connection failure handling.
// This port must not have any listening service in the test environment.
const UNREACHABLE_PORT = 5439;

/**
 * Integration tests for PostgreSQL Connection Pool & Health Check.
 * Running a PostgreSQL instance and providing valid environment configuration
 * (via .env or environment variables) are prerequisites for these tests.
 */
async function runDatabaseTests(): Promise<void> {
  // Load and validate environment configuration within the execution block
  initEnvironment();
  const config = loadConfig();
  const dbUrl = config.DATABASE_URL;

  // 1. Test live PostgreSQL database connectivity and health check
  const realPool = createPool(dbUrl);
  try {
    const isHealthy = await checkDatabaseHealth(realPool);
    assert.equal(isHealthy, true, 'Real database health check should return true');
    console.log('✔ Real database health check passed (SELECT 1)');

    // 2. Test basic query execution on acquired pool
    const queryResult = await realPool.query('SELECT 1 + 1 AS result');
    assert.equal(queryResult.rows[0].result, 2, 'Query result should equal 2');
    console.log('✔ Query execution test passed (SELECT 1 + 1 = 2)');
  } finally {
    await realPool.end();
  }

  // 3. Test statement_timeout enforcement and connection discard via release(true)
  // Configure pool with a 400ms statement_timeout and a 1500ms client query_timeout
  const timeoutPool = createPool(dbUrl, {
    statementTimeoutMillis: 400,
    queryTimeoutMillis: 1500,
  });

  try {
    let timeoutErrorCode: string | undefined;
    let client: PoolClient | undefined;
    let hasFailed = true;

    try {
      client = await timeoutPool.connect();
      // Execute a 1-second sleep query to trigger PostgreSQL statement_timeout
      await client.query('SELECT pg_sleep(1)');
      hasFailed = false;
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'code' in err) {
        timeoutErrorCode = String((err as { code: unknown }).code);
      }
    } finally {
      if (client) {
        // Discard the connection via release(true) on failure rather than recycling it
        client.release(hasFailed);
      }
    }

    // Assert that the failure was specifically due to PostgreSQL statement_timeout (code 57014)
    assert.equal(
      timeoutErrorCode,
      '57014',
      'Query exceeding statement_timeout must fail specifically with PostgreSQL error code 57014'
    );
    console.log('✔ Statement timeout failed specifically with PostgreSQL error code 57014');

    // Verify that the pool remains functional and can allocate a fresh connection for subsequent checks
    const recoveredHealthy = await checkDatabaseHealth(timeoutPool);
    assert.equal(recoveredHealthy, true, 'Subsequent health check on pool should succeed with fresh connection');
    console.log('✔ Subsequent health check succeeded using fresh connection from pool');
  } finally {
    await timeoutPool.end();
  }

  // 4. Test graceful handling when the target database host/port is unreachable
  const unreachableDbUrl = `postgres://postgres:postgres_password@127.0.0.1:${UNREACHABLE_PORT}/nonexistent_db`;
  const deadPool = createPool(unreachableDbUrl, {
    connectionTimeoutMillis: 1000,
  });

  try {
    const isDeadHealthy = await checkDatabaseHealth(deadPool);
    assert.equal(isDeadHealthy, false, 'Unreachable database health check should return false');
    console.log('✔ Unreachable database check gracefully returned false');
  } finally {
    await deadPool.end();
  }
}

try {
  await runDatabaseTests();
  console.log('\nAll database pool tests passed successfully.');
} catch (err) {
  console.error('\nDatabase test failed:', err);
  process.exit(1);
}

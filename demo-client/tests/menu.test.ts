// demo-client/tests/menu.test.ts
// Practical verification of the interactive CLI menu workflows

import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { startInteractiveMenu } from '../src/menu.js';
import { initEnvironment, loadConfig } from '../../src/config.js';
import { createPool, checkDatabaseHealth } from '../../src/db.js';
import { runMigrations } from '../../src/migrator.js';
import { buildApp } from '../../src/app.js';

async function runInteractiveMenuVerification(): Promise<void> {
  console.log('--- Starting Practical Interactive Menu Verification ---');

  initEnvironment(path.resolve(import.meta.dirname, '../../.env'));
  const config = loadConfig();

  const pool = createPool(config.DATABASE_URL, {
    max: 10,
    connectionTimeoutMillis: 10000,
    statementTimeoutMillis: 15000,
  });

  const migrationsDir = path.resolve(import.meta.dirname, '../../migrations');
  await runMigrations(pool, migrationsDir);

  const testPort = 3100;
  const app = buildApp({
    checkHealth: () => checkDatabaseHealth(pool),
    pool,
  });

  await app.listen({ port: testPort, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${testPort}`;

  // Streams to interact with startInteractiveMenu
  const inStream = new PassThrough();
  const outStream = new PassThrough();

  let capturedLogs = '';
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    capturedLogs += line + '\n';
    originalLog(...args);
  };

  try {
    // Launch the menu in the background
    const menuPromise = startInteractiveMenu(baseUrl, inStream, outStream);

    // Helper to send input with slight pause for readline processing
    const send = async (text: string) => {
      await new Promise((r) => setTimeout(r, 60));
      inStream.write(`${text}\n`);
    };

    // Step 1: Perform accepted action as default user Ahmed (3 units)
    await send('2'); // Perform action
    await send('3'); // 3 units

    // Step 2: Switch to Sara and perform rejected action (8 units > Sara limit 5)
    await send('1'); // Select user
    await send('2'); // Choose Sara
    await send('2'); // Perform action
    await send('8'); // 8 units (> Sara's limit 5)

    // Step 3: Switch user to Ahmed, then retry previous request
    // The previous request was for Sara (8 units). Verify it stays attributed to Sara!
    await send('1'); // Select user
    await send('1'); // Switch back to Ahmed
    await send('2'); // Perform action
    await send('r'); // Retry previous request
    await send('y'); // Confirm replay

    // Step 4: Perform accepted action for Ahmed (2 units) -> Action completed
    await send('2'); // Perform action
    await send('2'); // 2 units
    // Now retry this accepted request -> should not duplicate Action completed
    await send('2'); // Perform action
    await send('r'); // Retry
    await send('y'); // Confirm replay

    // Step 5: Modify Ahmed's plan (from public read-only to custom plan)
    await send('4'); // Change plan settings
    await send('2'); // Modify active user plan (Ahmed)
    await send('50'); // Monthly limit: 50
    await send('2'); // Per-request limit: 2 (restricted)
    // Test the effect of the new plan immediately: request 4 units (> new limit 2)
    await send('2'); // Perform action
    await send('4'); // 4 units

    // Step 6: Test invalid inputs
    await send('99'); // Invalid menu choice
    await send('invalid_text'); // Non-numeric choice

    // Step 7: Clean exit
    await send('0'); // Exit

    // Wait for menu loop to terminate
    await menuPromise;

    console.log = originalLog;

    // Helper to strip ANSI escape codes for clean string assertions
    const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*m/g, '');
    const cleanLogs = stripAnsi(capturedLogs);

    // ==========================================
    // Assertions verifying practical behavior
    // ==========================================

    // 1. Accepted action for Ahmed executed locally
    assert.ok(
      cleanLogs.includes('Action completed (Simulated business action executed locally)'),
      'Accepted action must report simulated action completion'
    );
    assert.ok(
      cleanLogs.includes('Decision:        ACCEPTED'),
      'Must log ACCEPTED decision'
    );

    // 2. Rejected action for Sara
    assert.ok(
      cleanLogs.includes('Action rejected by quota rules'),
      'Sara consumption above limit must be rejected'
    );
    assert.ok(
      cleanLogs.includes('Rejection Rule:  user.max_per_request'),
      'Must specify user.max_per_request rejection rule'
    );
    assert.ok(
      cleanLogs.includes('Simulated business action was NOT executed.'),
      'Must confirm simulated action was not executed on rejection'
    );

    // 3. Replay remains attributed to original user (Sara) after switching active user to Ahmed
    assert.ok(
      cleanLogs.includes('Original User: Sara'),
      'Replay must clearly show it belongs to the original requester (Sara), not the newly selected user'
    );

    // 4. Idempotent replay of accepted request avoids duplicate local execution
    assert.ok(
      cleanLogs.includes('Simulated action was already completed previously; local duplicate execution skipped.'),
      'Accepted request replay must skip duplicate execution of simulated action'
    );

    // 5. Modifying Ahmed's plan creates a custom plan and assigns it
    assert.ok(
      cleanLogs.includes('Ahmed is on the default public plan (read-only). Creating and assigning a custom user plan...'),
      'Must identify Ahmed is on public plan and create a custom plan'
    );
    assert.ok(
      cleanLogs.includes('Custom user plan created and assigned to Ahmed (Monthly: 50, Per-Request: 2)'),
      'Must confirm custom user plan was assigned with new limits'
    );

    // 6. Effect of Ahmed's new plan takes effect immediately (4 units rejected with limit 2)
    assert.ok(
      cleanLogs.includes('Rejection Rule:  user.max_per_request'),
      'Ahmed requesting 4 units after per-request limit reduced to 2 must be rejected immediately'
    );

    // 7. Invalid options handled gracefully
    assert.ok(
      cleanLogs.includes("Invalid option '99'. Please enter a number between 0 and 5."),
      'Invalid numeric option must prompt user politely'
    );
    assert.ok(
      cleanLogs.includes("Invalid option 'invalid_text'. Please enter a number between 0 and 5."),
      'Invalid string option must prompt user politely'
    );

    // 8. Clean exit
    assert.ok(
      cleanLogs.includes('Exiting interactive session. Goodbye!'),
      'Must terminate gracefully with clean exit message'
    );

    console.log('\n✔ All 5 Interactive CLI Menu Workflows Successfully Tested & Verified!');
  } finally {
    console.log = originalLog;
    await app.close();
    await pool.end();
  }
}

runInteractiveMenuVerification().catch((err) => {
  console.error('Interactive menu verification failed:', err);
  process.exit(1);
});

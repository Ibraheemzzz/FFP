// tests/migrations.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { initEnvironment, loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrator.js';

/**
 * Helper to construct a URL pointing to a specific database name
 */
function getDatabaseUrl(baseUrl: string, dbName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/**
 * Creates and recreates an isolated test database
 */
async function setupIsolatedDatabase(adminPool: ReturnType<typeof createPool>, dbName: string): Promise<void> {
  await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await adminPool.query(`CREATE DATABASE ${dbName}`);
}

async function runAllMigrationTests(): Promise<void> {
  // 1. Load and validate environment configuration inside main execution flow
  initEnvironment();
  const config = loadConfig();

  const adminPool = createPool(config.DATABASE_URL);
  const TEST_DB_NAME = 'usage_metering_migration_test';
  const CONCURRENT_DB_NAME = 'usage_metering_concurrent_test';

  let testPool: pg.Pool | undefined;
  let concurrentPool1: pg.Pool | undefined;
  let concurrentPool2: pg.Pool | undefined;

  try {
    // -------------------------------------------------------------
    // Test 1: Initial migration execution on an isolated database
    // -------------------------------------------------------------
    await setupIsolatedDatabase(adminPool, TEST_DB_NAME);
    testPool = createPool(getDatabaseUrl(config.DATABASE_URL, TEST_DB_NAME));

    const initResult = await runMigrations(testPool);
    assert.ok(
      initResult.applied.includes('001_initial_schema.sql'),
      'Initial migration 001_initial_schema.sql should be applied'
    );
    assert.ok(
      initResult.applied.includes('002_seed_default_plans.sql'),
      'Seed migration 002_seed_default_plans.sql should be applied'
    );

    // Verify that tables were created in the database
    const tablesRes = await testPool.query<{ table_name: string }>(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    const tableNames = new Set(tablesRes.rows.map((r) => r.table_name));

    const requiredTables = [
      'schema_migrations',
      'plans',
      'accounts',
      'users',
      'account_monthly_usage',
      'user_monthly_usage',
      'consumption_records',
    ];

    for (const table of requiredTables) {
      assert.ok(tableNames.has(table), `Table ${table} must exist in the database`);
    }
    console.log('✔ Initial migration executed and created all required schema tables');

    // -------------------------------------------------------------
    // Test 2: Idempotency with real data retention
    // -------------------------------------------------------------
    await testPool.query(`
      INSERT INTO plans (id, name, type, monthly_limit, per_request_limit)
      VALUES ('plan-prod-1', 'Standard Plan', 'ACCOUNT', 10000, 500);

      INSERT INTO accounts (id, name, api_key_hash, plan_id)
      VALUES (
        'acc-prod-1',
        'Production Client',
        'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        'plan-prod-1'
      );
    `);

    const secondRun = await runMigrations(testPool);
    assert.equal(secondRun.applied.length, 0, 'No new migrations should be applied on second run');

    const accountCheck = await testPool.query<{ name: string }>(
      'SELECT name FROM accounts WHERE id = $1',
      ['acc-prod-1']
    );
    assert.equal(accountCheck.rows[0]?.name, 'Production Client', 'Existing data must be preserved');
    console.log('✔ Re-running migrations is idempotent and preserves existing data');

    // -------------------------------------------------------------
    // Test 3: Atomic rollback on failure using division by zero
    // -------------------------------------------------------------
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ffp-mig-test-'));
    try {
      const real001 = await fs.readFile(
        path.resolve(process.cwd(), 'migrations', '001_initial_schema.sql'),
        'utf-8'
      );
      await fs.writeFile(path.join(tempDir, '001_initial_schema.sql'), real001, 'utf-8');

      // Create a faulty 002 migration with table creation followed by division by zero
      const faultySql = `
        CREATE TABLE temp_should_be_rolled_back (id INT PRIMARY KEY);
        SELECT 1 / 0;
      `;
      await fs.writeFile(path.join(tempDir, '002_faulty.sql'), faultySql, 'utf-8');

      // Attempting to run migrations should fail specifically with division by zero
      await assert.rejects(
        async () => {
          await runMigrations(testPool!, tempDir);
        },
        /division by zero/i,
        'Faulty migration must throw division by zero error'
      );

      // Verify the table created prior to division by zero was rolled back
      const checkTableRes = await testPool.query<{ count: string }>(`
        SELECT count(*) FROM information_schema.tables 
        WHERE table_name = 'temp_should_be_rolled_back'
      `);
      assert.equal(checkTableRes.rows[0].count, '0', 'Partial table must be rolled back');

      // Verify that 002_faulty.sql was NOT recorded in schema_migrations
      const checkMigRes = await testPool.query<{ count: string }>(`
        SELECT count(*) FROM schema_migrations WHERE name = '002_faulty.sql'
      `);
      assert.equal(checkMigRes.rows[0].count, '0', 'Faulty migration must not be recorded');
      console.log('✔ Failed migration rolled back atomically without partial schema changes');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    // -------------------------------------------------------------
    // Test 4: Cleanup failure after successful migration (Plain Object)
    // الغرض: التأكد من أنه إذا نجح تنفيذ المهاجرة ولكن فشل فك القفل:
    // 1. المعاملة تصل إلى COMMIT بنجاح.
    // 2. يُرمى خطأ التنظيف الصريح.
    // 3. يُستدعى release(true) للتخلص من الاتصال مرة واحدة فقط.
    // ملاحظة: هذا الاختبار يفحص تفرع الكود بكائن اتصال وهمي صريح، ولا ينشئ جداول حقيقية.
    // -------------------------------------------------------------
    const cleanupSuccessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ffp-mig-fake-succ-'));
    try {
      await fs.writeFile(
        path.join(cleanupSuccessDir, '001_dummy.sql'),
        'CREATE TABLE dummy_table (id INT);',
        'utf-8'
      );

      let reachedCommit = false;
      let releaseCalls = 0;
      let releaseArg: boolean | Error | undefined;

      // كائن اتصال وهمي بسيط ومباشر دون استخدام كلاسات
      const fakeClient = {
        async query(textOrConfig: string | { text: string }) {
          const queryText = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;

          if (queryText.includes('COMMIT')) {
            reachedCommit = true;
          }

          if (queryText.includes('pg_advisory_unlock')) {
            // محاكاة إرجاع false عند فك القفل
            return { rows: [{ unlocked: false }] };
          }

          return { rows: [] };
        },

        release(discard?: boolean | Error) {
          releaseCalls++;
          releaseArg = discard;
        },
      };

      const fakePool = {
        connect: async () => fakeClient,
      } as unknown as pg.Pool;

      // 1. نتأكد من رمي خطأ التنظيف الصريح عند فشل فك القفل
      await assert.rejects(
        async () => {
          await runMigrations(fakePool, cleanupSuccessDir);
        },
        /Migration execution completed, but advisory lock cleanup failed/i,
        'Must throw clear cleanup error when unlock fails after successful execution'
      );

      // 2. نتأكد من أن المعاملة وصلت إلى COMMIT بنجاح قبل محاولة التنظيف
      assert.equal(reachedCommit, true, 'Migration transaction must reach COMMIT before cleanup attempt');

      // 3. نتأكد من استدعاء release(true) مرة واحدة فقط للتخلص من الاتصال المعلق
      assert.equal(releaseCalls, 1, 'Client release must be called exactly once');
      assert.equal(releaseArg, true, 'Client must be discarded via release(true) on unlock failure');
      console.log('✔ Cleanup failure after successful migration commits files, discards connection, and throws error (verified via fake connection)');
    } finally {
      await fs.rm(cleanupSuccessDir, { recursive: true, force: true });
    }

    // -------------------------------------------------------------
    // Test 5: Cleanup failure with an original execution error (Plain Object)
    // الغرض: التأكد من أنه إذا فشل تنفيذ الملف وفشل فك القفل أيضاً:
    // 1. يُحفظ خطأ التنفيذ الأصلي ويُرمى دون أن يُستبدل بخطأ التنظيف.
    // 2. يُستدعى release(true) للتخلص من الاتصال مرة واحدة فقط.
    // ملاحظة: هذا الاختبار يفحص تفرع معالجة الأخطاء بكائن اتصال وهمي دون الاعتماد على PostgreSQL.
    // -------------------------------------------------------------
    const cleanupErrDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ffp-mig-fake-err-'));
    try {
      await fs.writeFile(
        path.join(cleanupErrDir, '001_dummy.sql'),
        'CREATE TABLE dummy_table (id INT);',
        'utf-8'
      );

      let releaseCalls = 0;
      let releaseArg: boolean | Error | undefined;

      // كائن اتصال وهمي بسيط دون كلاسات
      const fakeClient = {
        async query(textOrConfig: string | { text: string }) {
          const queryText = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;

          // محاكاة فشل استعلام تنفيذ ملف المهاجرة برمي خطأ أصلي
          if (queryText.includes('CREATE TABLE dummy_table')) {
            throw new Error('Simulated database execution failure in migration file');
          }

          // محاكاة فشل فك القفل أيضاً في كتلة التنظيف
          if (queryText.includes('pg_advisory_unlock')) {
            return { rows: [{ unlocked: false }] };
          }

          return { rows: [] };
        },

        release(discard?: boolean | Error) {
          releaseCalls++;
          releaseArg = discard;
        },
      };

      const fakePool = {
        connect: async () => fakeClient,
      } as unknown as pg.Pool;

      // 1. نتأكد من بقاء خطأ التنفيذ الأصلي وعدم استبداله بخطأ التنظيف
      await assert.rejects(
        async () => {
          await runMigrations(fakePool, cleanupErrDir);
        },
        /Simulated database execution failure in migration file/i,
        'Must preserve and throw original execution error rather than replacing it with cleanup error'
      );

      // 2. نتأكد من استدعاء release(true) مرة واحدة فقط للتخلص من الاتصال
      assert.equal(releaseCalls, 1, 'Client release must be called exactly once');
      assert.equal(releaseArg, true, 'Client must be discarded via release(true)');
      console.log('✔ Cleanup failure during error cleanup preserves original execution error and discards connection (verified via fake connection)');
    } finally {
      await fs.rm(cleanupErrDir, { recursive: true, force: true });
    }

    // Close testPool before moving to concurrent test
    await testPool.end();
    testPool = undefined;

    // -------------------------------------------------------------
    // Test 6: Concurrent migration runners synchronized safely
    // -------------------------------------------------------------
    await setupIsolatedDatabase(adminPool, CONCURRENT_DB_NAME);
    concurrentPool1 = createPool(getDatabaseUrl(config.DATABASE_URL, CONCURRENT_DB_NAME));
    concurrentPool2 = createPool(getDatabaseUrl(config.DATABASE_URL, CONCURRENT_DB_NAME));

    const [res1, res2] = await Promise.all([
      runMigrations(concurrentPool1),
      runMigrations(concurrentPool2),
    ]);

    const totalApplied = res1.applied.length + res2.applied.length;
    assert.equal(totalApplied, 2, 'All migrations must be applied exactly once across concurrent runs');

    const checkEntries = await concurrentPool1.query<{ count: string }>(
      'SELECT count(*) FROM schema_migrations'
    );
    assert.equal(checkEntries.rows[0].count, '2', 'schema_migrations must have exactly 2 records');
    console.log('✔ Concurrent migration runners synchronized safely via advisory locks');
  } finally {
    // Ensure all test pools are closed before attempting to drop test databases
    if (testPool) {
      try {
        await testPool.end();
      } catch {
        // ignore
      }
    }
    if (concurrentPool1) {
      try {
        await concurrentPool1.end();
      } catch {
        // ignore
      }
    }
    if (concurrentPool2) {
      try {
        await concurrentPool2.end();
      } catch {
        // ignore
      }
    }

    // Always attempt database cleanup, even if an assertion or test step failed
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
      await adminPool.query(`DROP DATABASE IF EXISTS ${CONCURRENT_DB_NAME}`);
    } catch {
      console.error('Failed to clean up test databases');
    }

    await adminPool.end();
  }
}

try {
  await runAllMigrationTests();
  console.log('\nAll migration tests passed successfully.');
} catch (err) {
  console.error('\nMigration tests failed:', err);
  process.exit(1);
}

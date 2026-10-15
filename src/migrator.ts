// src/migrator.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

// Unique 64-bit integer constant for PostgreSQL advisory locking during migrations
export const MIGRATION_LOCK_ID = 74839201;

export interface MigrationResult {
  applied: string[];
}

/**
 * Runs pending SQL migrations from the migrations directory.
 * Uses a dedicated client connection with PostgreSQL advisory lock to ensure
 * race-free, atomic, and idempotent execution across multiple instances.
 */
export async function runMigrations(
  pool: pg.Pool,
  migrationsDir: string = path.resolve(process.cwd(), 'migrations')
): Promise<MigrationResult> {
  const client = await pool.connect();
  let executionError: unknown = null;
  const appliedNow: string[] = [];

  try {
    // 1. Acquire session-level advisory lock on the leased client
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

    // 2. Ensure schema_migrations table exists under the acquired lock
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 3. Query already applied migration names
    const appliedRes = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations'
    );
    const appliedSet = new Set(appliedRes.rows.map((r) => r.name));

    // 4. Read and sort SQL files from the migrations directory
    const dirEntries = await fs.readdir(migrationsDir, { withFileTypes: true });
    const sqlFiles = dirEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    // 5. Execute pending migrations within individual atomic transactions
    for (const fileName of sqlFiles) {
      if (appliedSet.has(fileName)) {
        continue;
      }

      const filePath = path.join(migrationsDir, fileName);
      const sqlContent = await fs.readFile(filePath, 'utf-8');

      // Execute migration content and record file name within the same transaction
      await client.query('BEGIN');
      try {
        await client.query(sqlContent);
        await client.query(
          'INSERT INTO schema_migrations (name) VALUES ($1)',
          [fileName]
        );
        await client.query('COMMIT');
        appliedNow.push(fileName);
        console.log(`[Migrations] Applied: ${fileName}`);
      } catch (migrationError) {
        try {
          await client.query('ROLLBACK');
        } catch {
          console.error('Failed to roll back migration transaction');
        }
        throw migrationError;
      }
    }
  } catch (error) {
    executionError = error;
  } finally {
    // 6. Release advisory lock and verify clean unlock
    let unlockFailed = false;

    try {
      const unlockRes = await client.query<{ unlocked: boolean }>(
        'SELECT pg_advisory_unlock($1) AS unlocked',
        [MIGRATION_LOCK_ID]
      );
      if (unlockRes.rows[0]?.unlocked !== true) {
        unlockFailed = true;
      }
    } catch {
      unlockFailed = true;
    } finally {
      // Discard connection if execution failed or unlock failed
      const shouldDiscard = executionError !== null || unlockFailed;
      client.release(shouldDiscard);
    }

    // If an error occurred during migration execution, preserve and throw it
    if (executionError !== null) {
      if (unlockFailed) {
        console.error('Failed to release advisory lock during error cleanup');
      }
      throw executionError;
    }

    // If migrations succeeded but unlock failed, inform the caller clearly
    if (unlockFailed) {
      throw new Error(
        'Migration execution completed, but advisory lock cleanup failed. Connection was discarded. Previously committed migrations remain applied.'
      );
    }
  }

  return { applied: appliedNow };
}

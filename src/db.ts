import pg from 'pg';
import { AccountNotFoundError } from './errors.js';

const { Pool } = pg;

export type DbExecutor = pg.Pool | pg.PoolClient;

export interface DatabasePoolOptions {
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  statementTimeoutMillis?: number;
  queryTimeoutMillis?: number;
}

/**
 * Creates a PostgreSQL connection pool using pg.
 * Architectural note: The pool does not open all connections upfront, but creates new connections
 * on demand and reuses them to avoid TCP handshake overhead on each request, up to max limit.
 */
export function createPool(
  databaseUrl: string,
  options: DatabasePoolOptions = {}
): pg.Pool {
  const statementTimeout = options.statementTimeoutMillis ?? 3000;
  // Client query timeout is slightly longer than statement timeout to allow PostgreSQL engine to cancel first
  const queryTimeout = options.queryTimeoutMillis ?? (statementTimeout + 2000);

  const pool = new Pool({
    connectionString: databaseUrl,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 10000,
    statement_timeout: statementTimeout,
    query_timeout: queryTimeout,
  });

  // Handle unexpected errors on idle clients in the background with constant operational message
  pool.on('error', () => {
    console.error('Unexpected error on idle database client');
  });

  return pool;
}

/**
 * Database readiness and health check:
 * Leases an explicit client from the pool and runs SELECT 1, guaranteeing single release inside finally.
 *
 * Connection lifecycle policy (Recycling vs Discarding):
 * - On success: client is recycled cleanly back to the pool via client.release(false).
 * - On failure or timeout: client is destroyed via client.release(true) to avoid dirty client reuse.
 *
 * Timeout semantics:
 * 1. statement_timeout: Server-side execution timeout within PostgreSQL engine; aborts query on expiry.
 * 2. query_timeout: Client-side timeout for receiving query result; does not guarantee backend cancellation.
 */
export async function checkDatabaseHealth(pool: pg.Pool): Promise<boolean> {
  let client: pg.PoolClient | undefined;
  let hasFailed = true;

  try {
    client = await pool.connect();
    const result = await client.query('SELECT 1');
    const isHealthy = (result.rowCount ?? 0) > 0;
    if (isHealthy) {
      hasFailed = false;
    }
    return isHealthy;
  } catch {
    return false;
  } finally {
    if (client) {
      client.release(hasFailed);
    }
  }
}

/**
 * Executes an operation inside an atomic transaction under exclusive account row lock at READ COMMITTED isolation.
 *
 * Guarantees & boundaries:
 * - Lock serializes operations that participate in this account lock protocol (SELECT ... FOR UPDATE on accounts).
 * - Non-blocking for regular SELECT queries under MVCC.
 * - Lock acquisition order dictates processing sequence regardless of network arrival.
 * - Starts with explicit READ COMMITTED isolation level.
 * - Operational reads affecting decision execute strictly after acquiring the account lock.
 * - On success: Returns only after successful COMMIT; connection recycled via client.release(false).
 * - On failure: Attempts ROLLBACK; connection destroyed via client.release(true) if commit or rollback fails.
 */
export async function withAccountLock<T>(
  pool: pg.Pool,
  accountId: string,
  operation: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  let shouldDiscard = false;

  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');

    const lockResult = await client.query(
      'SELECT id FROM accounts WHERE id = $1 FOR UPDATE',
      [accountId]
    );

    if ((lockResult.rowCount ?? 0) === 0) {
      throw new AccountNotFoundError('Account not found');
    }

    const result = await operation(client);

    try {
      await client.query('COMMIT');
    } catch (commitErr) {
      shouldDiscard = true;
      throw commitErr;
    }

    return result;
  } catch (err) {
    if (!shouldDiscard) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        shouldDiscard = true;
        console.error('Failed to rollback transaction; discarding connection');
      }
    }
    throw err;
  } finally {
    client.release(shouldDiscard);
  }
}

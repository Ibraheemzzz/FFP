// src/accounts.ts
import crypto from 'node:crypto';
import type pg from 'pg';
import { withAccountLock } from './db.js';
import { AccountNotFoundError } from './errors.js';
import { getAccessiblePlan } from './plans.js';

export { AccountNotFoundError };

export interface CreateAccountInput {
  name: string;
  planId?: string;
}

export interface AccountCreatedResult {
  id: string;
  name: string;
  planId: string;
  apiKey: string;
  createdAt: string;
}

export class AccountValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountValidationError';
  }
}

/**
 * Default public plan assigned to newly registered accounts when no planId is specified
 */
export const DEFAULT_ACCOUNT_PLAN_ID = 'plan_default_account';

/**
 * Calculates SHA-256 hash for raw API key
 */
export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Generates a cryptographically secure random API key and its SHA-256 hash.
 * Security note: Only the hash is persisted to the database; the raw key is never stored.
 */
export function generateApiKey(): { rawKey: string; hash: string } {
  const randomHex = crypto.randomBytes(32).toString('hex');
  const rawKey = `ffp_live_${randomHex}`;
  const hash = hashApiKey(rawKey);
  return { rawKey, hash };
}

/**
 * Generates unique account ID with standard prefix
 */
export function generateAccountId(): string {
  const randomId = crypto.randomBytes(12).toString('hex');
  return `acc_${randomId}`;
}

/**
 * Validates account creation request body at runtime
 */
export function validateCreateAccountInput(input: unknown): CreateAccountInput {
  if (typeof input !== 'object' || input === null) {
    throw new AccountValidationError('Request body must be a JSON object');
  }

  const rawInput = input as Record<string, unknown>;

  // Validate account name: string, non-empty after trim, max 100 characters
  if (typeof rawInput.name !== 'string') {
    throw new AccountValidationError('Account name must be a string');
  }

  const trimmedName = rawInput.name.trim();
  if (trimmedName.length === 0) {
    throw new AccountValidationError('Account name must not be empty');
  }

  if (trimmedName.length > 100) {
    throw new AccountValidationError('Account name must not exceed 100 characters');
  }

  // Validate planId if provided
  let trimmedPlanId: string | undefined = undefined;
  if (rawInput.planId !== undefined) {
    if (typeof rawInput.planId !== 'string') {
      throw new AccountValidationError('Plan ID must be a string');
    }

    trimmedPlanId = rawInput.planId.trim();
    if (trimmedPlanId.length === 0) {
      throw new AccountValidationError('Plan ID must not be empty if provided');
    }

    if (trimmedPlanId.length > 64) {
      throw new AccountValidationError('Plan ID must not exceed 64 characters');
    }
  }

  return {
    name: trimmedName,
    planId: trimmedPlanId,
  };
}

/**
 * Registers a new account, persists it to database, and returns the raw key once.
 * Architectural note:
 * Retrying this operation creates a new distinct account; deduplication/idempotency
 * is intentionally reserved for consumption requests.
 */
export async function createAccount(
  pool: pg.Pool,
  validatedInput: CreateAccountInput
): Promise<AccountCreatedResult> {
  const targetPlanId = validatedInput.planId ?? DEFAULT_ACCOUNT_PLAN_ID;

  // 1. Validate plan existence, scope, and public accessibility
  const planRes = await pool.query<{ id: string; type: string; owner_account_id: string | null }>(
    'SELECT id, type, owner_account_id FROM plans WHERE id = $1',
    [targetPlanId]
  );

  if (planRes.rows.length === 0) {
    throw new AccountValidationError(`Plan '${targetPlanId}' does not exist`);
  }

  const plan = planRes.rows[0];

  // Assigned plan must be of type ACCOUNT
  if (plan.type !== 'ACCOUNT') {
    throw new AccountValidationError(`Plan '${targetPlanId}' is a ${plan.type} plan, not an ACCOUNT plan`);
  }

  // New accounts cannot adopt custom plans owned by another account
  if (plan.owner_account_id !== null) {
    throw new AccountValidationError(`Cannot assign custom plan '${targetPlanId}' owned by another account`);
  }

  // 2. Generate ID, key, and hash
  const accountId = generateAccountId();
  const { rawKey, hash } = generateApiKey();

  // 3. Persist account to database
  const insertRes = await pool.query<{
    id: string;
    name: string;
    plan_id: string;
    created_at: Date;
  }>(
    `INSERT INTO accounts (id, name, api_key_hash, plan_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, plan_id, created_at`,
    [accountId, validatedInput.name, hash, targetPlanId]
  );

  const row = insertRes.rows[0];

  return {
    id: row.id,
    name: row.name,
    planId: row.plan_id,
    apiKey: rawKey,
    createdAt: row.created_at.toISOString(),
  };
}

export interface UpdateAccountPlanInput {
  planId: string;
}

export interface AccountProfile {
  id: string;
  name: string;
  planId: string;
  createdAt: string;
}

const ALLOWED_UPDATE_ACCOUNT_PLAN_FIELDS = new Set(['planId']);

/**
 * Validates account plan update input:
 * - Requires non-empty object containing planId string (max 64 characters)
 * - Rejects unknown fields
 * - Explicitly rejects null
 */
export function validateUpdateAccountPlanInput(body: unknown): UpdateAccountPlanInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AccountValidationError('Request body must be a valid JSON object');
  }

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);

  if (keys.length === 0) {
    throw new AccountValidationError('At least one field must be provided for update');
  }

  for (const key of keys) {
    if (!ALLOWED_UPDATE_ACCOUNT_PLAN_FIELDS.has(key)) {
      throw new AccountValidationError(`Unknown field: ${key}`);
    }
  }

  if (!('planId' in record) || record.planId === undefined) {
    throw new AccountValidationError('planId is required');
  }

  if (record.planId === null) {
    throw new AccountValidationError('planId must not be null');
  }

  if (typeof record.planId !== 'string') {
    throw new AccountValidationError('planId must be a string');
  }

  const trimmed = record.planId.trim();
  if (trimmed.length === 0) {
    throw new AccountValidationError('planId must not be empty');
  }

  if (trimmed.length > 64) {
    throw new AccountValidationError('planId must not exceed 64 characters');
  }

  return { planId: trimmed };
}

/**
 * Updates plan assigned to authenticated account:
 * - Verifies target plan accessibility via getAccessiblePlan on transaction client
 * - Emits unified error message for missing or inaccessible foreign plans
 * - Enforces ACCOUNT plan type requirement
 * - Executes atomic UPDATE scoped strictly by authenticated account ID
 * - Verifies affected row count to handle missing account gracefully
 */
export async function updateAccountPlan(
  pool: pg.Pool,
  accountId: string,
  newPlanId: string
): Promise<AccountProfile> {
  return withAccountLock(pool, accountId, async (client) => {
    // 1. Verify plan accessibility on the transaction client
    const plan = await getAccessiblePlan(client, newPlanId, accountId);
    if (!plan) {
      throw new AccountValidationError('Plan not found or not accessible');
    }

    // 2. Verify plan scope is ACCOUNT
    if (plan.type !== 'ACCOUNT') {
      throw new AccountValidationError(
        `Plan '${newPlanId}' is a ${plan.type} plan, not an ACCOUNT plan`
      );
    }

    // 3. Execute atomic UPDATE on the leased transaction client
    const result = await client.query<{
      id: string;
      name: string;
      plan_id: string;
      created_at: Date;
    }>(
      `UPDATE accounts
       SET plan_id = $1
       WHERE id = $2
       RETURNING id, name, plan_id, created_at`,
      [newPlanId, accountId]
    );

    // 4. Verify row count
    if (result.rows.length === 0) {
      throw new AccountNotFoundError('Account not found');
    }

    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      planId: row.plan_id,
      createdAt: row.created_at.toISOString(),
    };
  });
}

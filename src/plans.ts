// src/plans.ts
import crypto from 'node:crypto';
import type pg from 'pg';
import { type DbExecutor, withAccountLock } from './db.js';

/**
 * Plan applicability scope: either account level or user level
 */
export type PlanType = 'ACCOUNT' | 'USER';

export interface Plan {
  id: string;
  name: string;
  type: PlanType;
  monthlyLimit: number;
  /**
   * Consumption cap per discrete request (units per single request):
   * Evaluated per individual consumption transaction; not a concurrency limit or network throughput metric.
   */
  perRequestLimit: number;
  ownerAccountId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PlanRow {
  id: string;
  name: string;
  type: PlanType;
  monthly_limit: string;
  per_request_limit: string;
  owner_account_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PlanDefinitionInput {
  name: string;
  type: PlanType;
  monthlyLimit: number;
  perRequestLimit: number;
}

export interface PlanUpdateInput {
  name?: string;
  monthlyLimit?: number;
  perRequestLimit?: number;
}

/**
 * Thrown when a plan resource does not exist or is inaccessible to current tenant
 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Thrown when attempting to mutate protected resources (such as default public plans)
 */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Thrown on plan validation errors
 */
export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

const ALLOWED_PLAN_DEFINITION_FIELDS = new Set([
  'name',
  'type',
  'monthlyLimit',
  'perRequestLimit',
]);

/**
 * Plan Definition Validation:
 * - Requires valid non-empty JSON object
 * - Rejects unknown or case-mismatched fields
 * - Requires: name, type, monthlyLimit, perRequestLimit
 * - name: non-empty string after trim, max 100 characters
 * - type: strictly 'ACCOUNT' or 'USER'
 * - monthlyLimit and perRequestLimit: non-negative safe integers (0 allowed)
 */
export function validatePlanDefinition(body: unknown): PlanDefinitionInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new PlanValidationError('Request body must be a valid JSON object');
  }

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);

  for (const key of keys) {
    if (!ALLOWED_PLAN_DEFINITION_FIELDS.has(key)) {
      throw new PlanValidationError(`Unknown field: ${key}`);
    }
  }

  // 1. Validate name
  if (!('name' in record) || record.name === undefined) {
    throw new PlanValidationError('name is required');
  }
  if (typeof record.name !== 'string') {
    throw new PlanValidationError('name must be a string');
  }
  const trimmedName = record.name.trim();
  if (trimmedName.length === 0) {
    throw new PlanValidationError('name must not be empty');
  }
  if (trimmedName.length > 100) {
    throw new PlanValidationError('name must not exceed 100 characters');
  }

  // 2. Validate type
  if (!('type' in record) || record.type === undefined) {
    throw new PlanValidationError('type is required');
  }
  if (typeof record.type !== 'string') {
    throw new PlanValidationError('type must be a string');
  }
  if (record.type !== 'ACCOUNT' && record.type !== 'USER') {
    throw new PlanValidationError("type must be either 'ACCOUNT' or 'USER'");
  }
  const planType: PlanType = record.type;

  // 3. Validate monthlyLimit
  if (!('monthlyLimit' in record) || record.monthlyLimit === undefined) {
    throw new PlanValidationError('monthlyLimit is required');
  }
  if (
    typeof record.monthlyLimit !== 'number' ||
    !Number.isSafeInteger(record.monthlyLimit)
  ) {
    throw new PlanValidationError('monthlyLimit must be a safe integer');
  }
  if (record.monthlyLimit < 0) {
    throw new PlanValidationError('monthlyLimit must not be negative');
  }

  // 4. Validate perRequestLimit
  if (!('perRequestLimit' in record) || record.perRequestLimit === undefined) {
    throw new PlanValidationError('perRequestLimit is required');
  }
  if (
    typeof record.perRequestLimit !== 'number' ||
    !Number.isSafeInteger(record.perRequestLimit)
  ) {
    throw new PlanValidationError('perRequestLimit must be a safe integer');
  }
  if (record.perRequestLimit < 0) {
    throw new PlanValidationError('perRequestLimit must not be negative');
  }

  return {
    name: trimmedName,
    type: planType,
    monthlyLimit: record.monthlyLimit,
    perRequestLimit: record.perRequestLimit,
  };
}

/**
 * Asserts resource is non-null or throws NotFoundError
 */
export function assertResourceFound<T>(resource: T | null, message: string): T {
  if (resource === null) {
    throw new NotFoundError(message);
  }
  return resource;
}

/**
 * Retrieves a plan accessible to the account: public plan or owned by the same account
 */
export async function getAccessiblePlan(
  db: DbExecutor,
  planId: string,
  accountId: string
): Promise<Plan | null> {
  const result = await db.query<PlanRow>(
    `SELECT id, name, type, monthly_limit, per_request_limit, owner_account_id, created_at, updated_at
     FROM plans
     WHERE id = $1 AND (owner_account_id = $2 OR owner_account_id IS NULL)`,
    [planId, accountId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    monthlyLimit: Number(row.monthly_limit),
    perRequestLimit: Number(row.per_request_limit),
    ownerAccountId: row.owner_account_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Validates plan type query parameter (?type=):
 * - Optional: returns undefined if omitted
 * - Rejects non-string, empty, or values other than 'ACCOUNT' or 'USER'
 */
export function validatePlanTypeFilter(typeParam: unknown): PlanType | undefined {
  if (typeParam === undefined) {
    return undefined;
  }

  if (typeof typeParam !== 'string') {
    throw new PlanValidationError(
      "Invalid plan type filter. Allowed values: 'ACCOUNT', 'USER'"
    );
  }

  if (typeParam !== 'ACCOUNT' && typeParam !== 'USER') {
    throw new PlanValidationError(
      "Invalid plan type filter. Allowed values: 'ACCOUNT', 'USER'"
    );
  }

  return typeParam;
}

/**
 * Lists plans accessible to account with multi-tenant isolation and deterministic sort:
 * - Returns public plans (owner_account_id IS NULL) + private plans owned by account
 * - Supports optional filtering by plan type
 * - Deterministic sort ascending by created_at then id
 */
export async function listAccessiblePlans(
  pool: pg.Pool,
  accountId: string,
  typeFilter?: PlanType
): Promise<Plan[]> {
  const result = await pool.query<PlanRow>(
    `SELECT id, name, type, monthly_limit, per_request_limit, owner_account_id, created_at, updated_at
     FROM plans
     WHERE (owner_account_id = $1 OR owner_account_id IS NULL)
       AND ($2::varchar IS NULL OR type = $2)
     ORDER BY created_at ASC, id ASC`,
    [accountId, typeFilter ?? null]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    monthlyLimit: Number(row.monthly_limit),
    perRequestLimit: Number(row.per_request_limit),
    ownerAccountId: row.owner_account_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

/**
 * Generates random cryptographic plan ID in format plan_<24 hex chars> (29 chars total)
 */
export function generatePlanId(): string {
  return `plan_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * Validates partial plan update payload (PATCH /plans/:planId):
 * - Requires non-empty JSON object with at least one field
 * - Rejects modifying 'type'
 * - Rejects unknown fields
 * - Rejects null values
 * - Accepts 0 for monthlyLimit and perRequestLimit
 */
export function validatePlanUpdateInput(input: unknown): PlanUpdateInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new PlanValidationError('Request body must be a valid JSON object');
  }

  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);

  if (keys.length === 0) {
    throw new PlanValidationError('At least one field must be provided for update');
  }

  if ('type' in record) {
    throw new PlanValidationError('Plan type cannot be changed');
  }

  for (const key of keys) {
    if (key !== 'name' && key !== 'monthlyLimit' && key !== 'perRequestLimit') {
      throw new PlanValidationError(`Unknown field: ${key}`);
    }
  }

  const result: PlanUpdateInput = {};

  if ('name' in record) {
    if (record.name === null) {
      throw new PlanValidationError('name must not be null');
    }
    if (typeof record.name !== 'string') {
      throw new PlanValidationError('name must be a string');
    }
    const trimmed = record.name.trim();
    if (trimmed.length === 0) {
      throw new PlanValidationError('name must not be empty');
    }
    if (trimmed.length > 100) {
      throw new PlanValidationError('name must not exceed 100 characters');
    }
    result.name = trimmed;
  }

  if ('monthlyLimit' in record) {
    if (record.monthlyLimit === null) {
      throw new PlanValidationError('monthlyLimit must not be null');
    }
    if (
      typeof record.monthlyLimit !== 'number' ||
      !Number.isSafeInteger(record.monthlyLimit)
    ) {
      throw new PlanValidationError('monthlyLimit must be a safe integer');
    }
    if (record.monthlyLimit < 0) {
      throw new PlanValidationError('monthlyLimit must not be negative');
    }
    result.monthlyLimit = record.monthlyLimit;
  }

  if ('perRequestLimit' in record) {
    if (record.perRequestLimit === null) {
      throw new PlanValidationError('perRequestLimit must not be null');
    }
    if (
      typeof record.perRequestLimit !== 'number' ||
      !Number.isSafeInteger(record.perRequestLimit)
    ) {
      throw new PlanValidationError('perRequestLimit must be a safe integer');
    }
    if (record.perRequestLimit < 0) {
      throw new PlanValidationError('perRequestLimit must not be negative');
    }
    result.perRequestLimit = record.perRequestLimit;
  }

  return result;
}

/**
 * Creates custom plan owned by authenticated account:
 * - Scoped to owner account (owner_account_id = accountId)
 * - Generates unique ID in plan_... format
 */
export async function createCustomPlan(
  pool: pg.Pool,
  accountId: string,
  input: PlanDefinitionInput
): Promise<Plan> {
  const planId = generatePlanId();
  const result = await pool.query<PlanRow>(
    `INSERT INTO plans (id, name, type, monthly_limit, per_request_limit, owner_account_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, type, monthly_limit, per_request_limit, owner_account_id, created_at, updated_at`,
    [
      planId,
      input.name,
      input.type,
      input.monthlyLimit,
      input.perRequestLimit,
      accountId,
    ]
  );

  const row = result.rows[0];
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    monthlyLimit: Number(row.monthly_limit),
    perRequestLimit: Number(row.per_request_limit),
    ownerAccountId: row.owner_account_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Updates a custom plan owned by authenticated account (PATCH):
 * 1. Checks plan existence and accessibility via getAccessiblePlan
 * 2. Rejects modifying public default plans with ForbiddenError (403)
 * 3. Executes atomic UPDATE with explicit ownership condition:
 *    WHERE id = $4 AND owner_account_id = $5
 *    Uses COALESCE to preserve omitted fields without pre-reading
 * 4. Checks affected row count; throws NotFoundError (404) if zero rows affected
 */
export async function updateCustomPlan(
  pool: pg.Pool,
  planId: string,
  accountId: string,
  input: PlanUpdateInput
): Promise<Plan> {
  return withAccountLock(pool, accountId, async (client) => {
    const existingPlan = await getAccessiblePlan(client, planId, accountId);
    if (!existingPlan) {
      throw new NotFoundError('Plan not found');
    }

    if (existingPlan.ownerAccountId === null) {
      throw new ForbiddenError('Default public plans cannot be modified');
    }

    const result = await client.query<PlanRow>(
      `UPDATE plans
       SET name = COALESCE($1::varchar, name),
           monthly_limit = COALESCE($2::bigint, monthly_limit),
           per_request_limit = COALESCE($3::bigint, per_request_limit),
           updated_at = NOW()
       WHERE id = $4 AND owner_account_id = $5
       RETURNING id, name, type, monthly_limit, per_request_limit, owner_account_id, created_at, updated_at`,
      [
        input.name ?? null,
        input.monthlyLimit !== undefined ? input.monthlyLimit : null,
        input.perRequestLimit !== undefined ? input.perRequestLimit : null,
        planId,
        accountId,
      ]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Plan not found');
    }

    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      monthlyLimit: Number(row.monthly_limit),
      perRequestLimit: Number(row.per_request_limit),
      ownerAccountId: row.owner_account_id,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  });
}

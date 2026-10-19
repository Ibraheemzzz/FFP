// src/consumptions.ts
// Consumption request validation, rule evaluation, and transactional metering engine

import type pg from 'pg';
import type {
  ConsumptionDecision,
  AcceptedDecision,
  RejectedDecision,
  ConsumptionRequest,
  RejectionReason,
  UsageSnapshot,
} from './types.js';
import { type DbExecutor, withAccountLock } from './db.js';
import { getAccessiblePlan } from './plans.js';
import { getUserById, UserNotFoundError } from './users.js';

/**
 * Thrown on consumption request input validation failures
 */
export class ConsumptionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsumptionValidationError';
  }
}

/**
 * Thrown when reusing a requestId with mismatched request payload
 * Maps to HTTP 409 Conflict in route layer
 */
export class RequestIdConflictError extends Error {
  constructor(message = 'requestId has already been used with different request data') {
    super(message);
    this.name = 'RequestIdConflictError';
  }
}

/**
 * Explicit whitelist of allowed fields in consumption request body
 */
const ALLOWED_CONSUMPTION_FIELDS = new Set(['userId', 'units', 'requestId']);

/**
 * Validates consumption request body at runtime:
 * 1. Body must be a non-empty, non-array JSON object.
 * 2. Rejects unknown or case-mismatched fields.
 * 3. Requires: userId, units, requestId.
 * 4. units: typeof units === 'number' && Number.isSafeInteger(units) && units > 0
 * 5. userId: non-empty string after trim, max 64 characters.
 * 6. requestId: non-empty string after trim, max 128 characters.
 */
export function validateConsumptionInput(body: unknown): ConsumptionRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ConsumptionValidationError('Request body must be a JSON object');
  }

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);

  for (const key of keys) {
    if (!ALLOWED_CONSUMPTION_FIELDS.has(key)) {
      throw new ConsumptionValidationError(`Unknown field: ${key}`);
    }
  }

  if (!('userId' in record) || record.userId === undefined || record.userId === null) {
    throw new ConsumptionValidationError('userId is required');
  }

  if (!('units' in record) || record.units === undefined || record.units === null) {
    throw new ConsumptionValidationError('units is required');
  }

  if (!('requestId' in record) || record.requestId === undefined || record.requestId === null) {
    throw new ConsumptionValidationError('requestId is required');
  }

  // Validate userId
  if (typeof record.userId !== 'string') {
    throw new ConsumptionValidationError('userId must be a string');
  }
  const trimmedUserId = record.userId.trim();
  if (trimmedUserId.length === 0) {
    throw new ConsumptionValidationError('userId must not be empty');
  }
  if (trimmedUserId.length > 64) {
    throw new ConsumptionValidationError('userId must not exceed 64 characters');
  }

  // Validate units: positive safe integer
  const units = record.units;
  if (typeof units !== 'number' || !Number.isSafeInteger(units) || units <= 0) {
    throw new ConsumptionValidationError('units must be a positive safe integer greater than zero');
  }

  // Validate requestId
  if (typeof record.requestId !== 'string') {
    throw new ConsumptionValidationError('requestId must be a string');
  }
  const trimmedRequestId = record.requestId.trim();
  if (trimmedRequestId.length === 0) {
    throw new ConsumptionValidationError('requestId must not be empty');
  }
  if (trimmedRequestId.length > 128) {
    throw new ConsumptionValidationError('requestId must not exceed 128 characters');
  }

  return {
    userId: trimmedUserId,
    units,
    requestId: trimmedRequestId,
  };
}

/**
 * Extracts UTC calendar year and month in YYYY-MM format:
 * 1. Validates Date object is valid.
 * 2. Enforces year between 1000 and 9999 matching database constraint:
 *    CHECK (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
 * 3. Formats month padded to 2 digits (01-12).
 * 4. Defaults to current Date when parameter is omitted.
 */
export function getUtcYearMonth(date: Date = new Date()): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new RangeError('Invalid date provided');
  }

  const year = date.getUTCFullYear();
  if (year < 1000 || year > 9999) {
    throw new RangeError('Year must be a 4-digit positive integer between 1000 and 9999');
  }

  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Evaluation context for the four quota rules
 */
export interface QuotaEvaluationContext {
  requestedUnits: number;
  accountMonthlyLimit: number;
  accountPerRequestLimit: number;
  userMonthlyLimit: number;
  userPerRequestLimit: number;
  accountConsumedUnits: number;
  userConsumedUnits: number;
}

/**
 * Quota rule evaluation result
 */
export type QuotaEvaluationResult =
  | { accepted: true }
  | { accepted: false; reason: RejectionReason };

/**
 * Evaluates the four quota rules deterministically:
 * 1. Account per-request limit: requestedUnits > accountPerRequestLimit
 * 2. User per-request limit: requestedUnits > userPerRequestLimit
 * 3. Account monthly allowance: requestedUnits > accountMonthlyLimit - accountConsumedUnits
 * 4. User monthly allowance: requestedUnits > userMonthlyLimit - userConsumedUnits
 */
export function evaluateQuotaRules(context: QuotaEvaluationContext): QuotaEvaluationResult {
  // 1. Account per-request check
  if (context.requestedUnits > context.accountPerRequestLimit) {
    return {
      accepted: false,
      reason: { scope: 'account', rule: 'max_per_request' },
    };
  }

  // 2. User per-request check
  if (context.requestedUnits > context.userPerRequestLimit) {
    return {
      accepted: false,
      reason: { scope: 'user', rule: 'max_per_request' },
    };
  }

  // 3. Account monthly allowance check using subtraction
  if (context.requestedUnits > context.accountMonthlyLimit - context.accountConsumedUnits) {
    return {
      accepted: false,
      reason: { scope: 'account', rule: 'monthly_allowance' },
    };
  }

  // 4. User monthly allowance check using subtraction
  if (context.requestedUnits > context.userMonthlyLimit - context.userConsumedUnits) {
    return {
      accepted: false,
      reason: { scope: 'user', rule: 'monthly_allowance' },
    };
  }

  return { accepted: true };
}

/**
 * Calculates usage snapshot (consumed and dynamic remaining):
 * - Remaining is dynamically calculated: Math.max(0, monthlyLimit - consumedUnits)
 * - Remaining is never negative; if consumed exceeds limit (e.g. after downgrade), remaining is 0
 */
export function calculateUsageSnapshot(
  monthlyLimit: number,
  consumedUnits: number
): UsageSnapshot {
  return {
    consumed: consumedUnits,
    remaining: Math.max(0, monthlyLimit - consumedUnits),
  };
}

/**
 * Reads account monthly usage for specified month
 */
export async function getAccountMonthlyUsage(
  db: DbExecutor,
  accountId: string,
  yearMonth: string
): Promise<number> {
  const query = `
    SELECT total_units
    FROM account_monthly_usage
    WHERE account_id = $1 AND year_month = $2;
  `;
  const result = await db.query<{ total_units: string }>(query, [accountId, yearMonth]);

  if (result.rows.length === 0) {
    return 0;
  }

  return Number(result.rows[0].total_units);
}

/**
 * Reads user monthly usage for specified month under tenant isolation
 */
export async function getUserMonthlyUsage(
  db: DbExecutor,
  accountId: string,
  userId: string,
  yearMonth: string
): Promise<number> {
  const query = `
    SELECT total_units
    FROM user_monthly_usage
    WHERE account_id = $1 AND user_id = $2 AND year_month = $3;
  `;
  const result = await db.query<{ total_units: string }>(query, [accountId, userId, yearMonth]);

  if (result.rows.length === 0) {
    return 0;
  }

  return Number(result.rows[0].total_units);
}

/**
 * Execution options for consumption requests
 */
export interface ExecuteConsumptionOptions {
  /**
   * Optional clock injection for deterministic testing; invoked after acquiring account lock
   */
  clock?: () => Date;
}

/**
 * Historical decision context persisted in decision_context column
 */
export interface DecisionContext {
  accountPlan: {
    id: string;
    monthlyLimit: number;
    perRequestLimit: number;
  };
  userPlan: {
    id: string;
    monthlyLimit: number;
    perRequestLimit: number;
  };
  usageBefore: {
    accountConsumed: number;
    userConsumed: number;
  };
}

/**
 * Internal transaction processor: executes read, evaluation, and write operations
 * under the active client connection and acquired account lock.
 */
async function processConsumption(
  client: pg.PoolClient,
  accountId: string,
  request: ConsumptionRequest,
  options?: ExecuteConsumptionOptions
): Promise<ConsumptionDecision> {
  // 1. Idempotency check immediately after acquiring lock
  const existingRecordRes = await client.query<{
    user_id: string;
    requested_units: string;
    response_body: ConsumptionDecision;
  }>(
    `SELECT user_id, requested_units, response_body
     FROM consumption_records
     WHERE account_id = $1 AND request_id = $2;`,
    [accountId, request.requestId]
  );

  if (existingRecordRes.rows.length > 0) {
    const existing = existingRecordRes.rows[0];

    // a) Conflict check: identical requestId with mismatched payload
    if (
      existing.user_id !== request.userId ||
      Number(existing.requested_units) !== request.units
    ) {
      throw new RequestIdConflictError(
        'requestId has already been used with different request data'
      );
    }

    // b) Idempotent replay: return original stored decision snapshot immediately
    return existing.response_body;
  }

  // 2. Invoke clock once post-lock to establish processing timestamp and accounting month
  const clock = options?.clock ?? (() => new Date());
  const processedAt = clock();
  const yearMonth = getUtcYearMonth(processedAt);

  // 3. Verify user exists and belongs to authenticated account
  const user = await getUserById(client, request.userId, accountId);
  if (!user) {
    throw new UserNotFoundError('User not found');
  }

  // 4. Read current account plan assignment from database under lock
  const accountRes = await client.query<{ plan_id: string }>(
    'SELECT plan_id FROM accounts WHERE id = $1',
    [accountId]
  );
  if (accountRes.rows.length === 0) {
    throw new Error('Account not found');
  }
  const accountPlanId = accountRes.rows[0].plan_id;

  // 5. Retrieve account plan and verify accessibility and ACCOUNT type
  const accountPlan = await getAccessiblePlan(client, accountPlanId, accountId);
  if (!accountPlan) {
    throw new Error(`Account plan '${accountPlanId}' not found or not accessible`);
  }
  if (accountPlan.type !== 'ACCOUNT') {
    throw new Error(`Account plan '${accountPlan.id}' must be of type 'ACCOUNT'`);
  }

  // 6. Retrieve user plan and verify accessibility and USER type
  const userPlan = await getAccessiblePlan(client, user.planId, accountId);
  if (!userPlan) {
    throw new Error(`User plan '${user.planId}' not found or not accessible`);
  }
  if (userPlan.type !== 'USER') {
    throw new Error(`User plan '${userPlan.id}' must be of type 'USER'`);
  }

  // 7. Read cumulative monthly usage for account and user
  const accountConsumedUnits = await getAccountMonthlyUsage(client, accountId, yearMonth);
  const userConsumedUnits = await getUserMonthlyUsage(client, accountId, request.userId, yearMonth);

  // 8. Evaluate quota rules
  const evaluationResult = evaluateQuotaRules({
    requestedUnits: request.units,
    accountMonthlyLimit: accountPlan.monthlyLimit,
    accountPerRequestLimit: accountPlan.perRequestLimit,
    userMonthlyLimit: userPlan.monthlyLimit,
    userPerRequestLimit: userPlan.perRequestLimit,
    accountConsumedUnits,
    userConsumedUnits,
  });

  // 9. Prepare historical decision context
  const decisionContext: DecisionContext = {
    accountPlan: {
      id: accountPlan.id,
      monthlyLimit: accountPlan.monthlyLimit,
      perRequestLimit: accountPlan.perRequestLimit,
    },
    userPlan: {
      id: userPlan.id,
      monthlyLimit: userPlan.monthlyLimit,
      perRequestLimit: userPlan.perRequestLimit,
    },
    usageBefore: {
      accountConsumed: accountConsumedUnits,
      userConsumed: userConsumedUnits,
    },
  };

  // 10. Branch on evaluation outcome:
  if (evaluationResult.accepted) {
    // --- ACCEPTED branch ---
    const newAccountConsumed = accountConsumedUnits + request.units;
    const newUserConsumed = userConsumedUnits + request.units;

    const accountSnapshot = calculateUsageSnapshot(accountPlan.monthlyLimit, newAccountConsumed);
    const userSnapshot = calculateUsageSnapshot(userPlan.monthlyLimit, newUserConsumed);

    const decision: AcceptedDecision = {
      accepted: true,
      requestId: request.requestId,
      account: accountSnapshot,
      user: userSnapshot,
    };

    // a) Atomically update account monthly counter via UPSERT
    await client.query(
      `INSERT INTO account_monthly_usage (account_id, year_month, total_units, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (account_id, year_month)
       DO UPDATE SET total_units = account_monthly_usage.total_units + EXCLUDED.total_units,
                     updated_at = NOW();`,
      [accountId, yearMonth, request.units]
    );

    // b) Atomically update user monthly counter via UPSERT
    await client.query(
      `INSERT INTO user_monthly_usage (account_id, user_id, year_month, total_units, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, year_month)
       DO UPDATE SET total_units = user_monthly_usage.total_units + EXCLUDED.total_units,
                     updated_at = NOW();`,
      [accountId, request.userId, yearMonth, request.units]
    );

    // c) Persist accepted consumption record with historical decision context
    await client.query(
      `INSERT INTO consumption_records (
         account_id, user_id, request_id, requested_units,
         status, rejection_scope, rejection_rule,
         response_body, decision_context, processed_at
       ) VALUES ($1, $2, $3, $4, 'ACCEPTED', NULL, NULL, $5, $6, $7);`,
      [
        accountId,
        request.userId,
        request.requestId,
        request.units,
        JSON.stringify(decision),
        JSON.stringify(decisionContext),
        processedAt,
      ]
    );

    return decision;
  } else {
    // --- REJECTED branch ---
    const accountSnapshot = calculateUsageSnapshot(accountPlan.monthlyLimit, accountConsumedUnits);
    const userSnapshot = calculateUsageSnapshot(userPlan.monthlyLimit, userConsumedUnits);

    const decision: RejectedDecision = {
      accepted: false,
      requestId: request.requestId,
      reason: evaluationResult.reason,
      account: accountSnapshot,
      user: userSnapshot,
    };

    // Persist rejected consumption record with rejection reason and decision context
    await client.query(
      `INSERT INTO consumption_records (
         account_id, user_id, request_id, requested_units,
         status, rejection_scope, rejection_rule,
         response_body, decision_context, processed_at
       ) VALUES ($1, $2, $3, $4, 'REJECTED', $5, $6, $7, $8, $9);`,
      [
        accountId,
        request.userId,
        request.requestId,
        request.units,
        evaluationResult.reason.scope,
        evaluationResult.reason.rule,
        JSON.stringify(decision),
        JSON.stringify(decisionContext),
        processedAt,
      ]
    );

    return decision;
  }
}

/**
 * Public consumption execution entrypoint:
 * Manages atomic transaction and pessimistic account locking via withAccountLock.
 */
export async function executeConsumption(
  pool: pg.Pool,
  accountId: string,
  request: ConsumptionRequest,
  options?: ExecuteConsumptionOptions
): Promise<ConsumptionDecision> {
  return withAccountLock(pool, accountId, async (client) => {
    return processConsumption(client, accountId, request, options);
  });
}

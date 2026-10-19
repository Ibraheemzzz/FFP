// src/requests.ts
// Query, filtering, and pagination logic for consumption request history (Part 25: Request History & Pagination)

import type { DbExecutor } from './db.js';
import type {
  ConsumptionDecision,
  RejectionScope,
  RejectionRule,
  RequestHistoryItem,
  RequestHistoryResponse,
  RequestHistoryFilter,
} from './types.js';
import { getUtcMonthDateRange } from './usage.js';

/**
 * Thrown when request history query parameters fail validation
 */
export class RequestQueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestQueryValidationError';
  }
}

/**
 * Explicit whitelist of allowed query parameters for request history
 */
const ALLOWED_REQUESTS_QUERY_PARAMS = new Set(['limit', 'offset', 'userId', 'status', 'month']);

/**
 * Strict regex for non-negative integers (digits only, no signs or decimals)
 */
const NON_NEGATIVE_INTEGER_REGEX = /^\d+$/;

/**
 * Regex for UTC calendar month format YYYY-MM
 */
const YEAR_MONTH_REGEX = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/;

/**
 * Strict query parameter validator:
 * 1. Rejects unknown or duplicate parameters (arrays).
 * 2. Validates limit and offset as non-negative safe integers.
 * 3. Validates userId (non-empty string, max 64 chars).
 * 4. Validates status (strictly 'ACCEPTED' or 'REJECTED').
 * 5. Validates month (YYYY-MM format, year 1000-9999).
 */
export function validateRequestHistoryQuery(query: unknown): RequestHistoryFilter {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    throw new RequestQueryValidationError('Query parameters must be a valid object');
  }

  const record = query as Record<string, unknown>;
  const keys = Object.keys(record);

  for (const key of keys) {
    if (!ALLOWED_REQUESTS_QUERY_PARAMS.has(key)) {
      throw new RequestQueryValidationError(`Unknown query parameter: ${key}`);
    }
    if (Array.isArray(record[key])) {
      throw new RequestQueryValidationError(`Duplicate query parameter: ${key}`);
    }
  }

  // 1. Validate limit
  let limit = 20;
  if ('limit' in record && record.limit !== undefined) {
    const rawLimit = record.limit;
    if (typeof rawLimit !== 'string' || !NON_NEGATIVE_INTEGER_REGEX.test(rawLimit)) {
      throw new RequestQueryValidationError('limit must be a safe integer between 1 and 100');
    }
    const parsedLimit = Number(rawLimit);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw new RequestQueryValidationError('limit must be a safe integer between 1 and 100');
    }
    limit = parsedLimit;
  }

  // 2. Validate offset
  let offset = 0;
  if ('offset' in record && record.offset !== undefined) {
    const rawOffset = record.offset;
    if (typeof rawOffset !== 'string' || !NON_NEGATIVE_INTEGER_REGEX.test(rawOffset)) {
      throw new RequestQueryValidationError('offset must be a non-negative safe integer');
    }
    const parsedOffset = Number(rawOffset);
    if (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0) {
      throw new RequestQueryValidationError('offset must be a non-negative safe integer');
    }
    offset = parsedOffset;
  }

  // 3. Validate userId (optional)
  let userId: string | undefined;
  if ('userId' in record && record.userId !== undefined) {
    if (typeof record.userId !== 'string') {
      throw new RequestQueryValidationError('userId must be a string');
    }
    const trimmedUserId = record.userId.trim();
    if (trimmedUserId.length === 0 || trimmedUserId.length > 64) {
      throw new RequestQueryValidationError('userId must be a non-empty string not exceeding 64 characters');
    }
    userId = trimmedUserId;
  }

  // 4. Validate status (optional)
  let status: 'ACCEPTED' | 'REJECTED' | undefined;
  if ('status' in record && record.status !== undefined) {
    if (typeof record.status !== 'string' || (record.status !== 'ACCEPTED' && record.status !== 'REJECTED')) {
      throw new RequestQueryValidationError("status must be either 'ACCEPTED' or 'REJECTED'");
    }
    status = record.status;
  }

  // 5. Validate month (optional)
  let month: string | undefined;
  if ('month' in record && record.month !== undefined) {
    if (typeof record.month !== 'string' || !YEAR_MONTH_REGEX.test(record.month)) {
      throw new RequestQueryValidationError('month must be in YYYY-MM format with 4-digit year (1000-9999)');
    }
    month = record.month;
  }

  return {
    limit,
    offset,
    userId,
    status,
    month,
  };
}

interface ConsumptionRecordRow {
  id: string;
  request_id: string;
  user_id: string;
  requested_units: string | number;
  status: string;
  rejection_scope: string | null;
  rejection_rule: string | null;
  response_body: ConsumptionDecision;
  processed_at: Date | string;
}

/**
 * Executes request history query with pagination:
 * - Direct SELECT query on consumption_records
 * - Strictly enforces tenant isolation account_id = $1
 * - Dynamically appends validated optional filters using parameterized placeholders
 * - Fetches limit + 1 rows to determine hasMore cleanly without COUNT(*) overhead
 * - Deterministic ordering via ORDER BY processed_at DESC, id DESC
 * - Returns id as string to preserve BIGSERIAL 64-bit precision
 * - Emits stored response_body snapshot directly without recalculation
 */
export async function getRequestHistory(
  executor: DbExecutor,
  accountId: string,
  filter: RequestHistoryFilter
): Promise<RequestHistoryResponse> {
  const conditions: string[] = ['account_id = $1'];
  const params: unknown[] = [accountId];
  let paramIndex = 2;

  if (filter.userId !== undefined) {
    conditions.push(`user_id = $${paramIndex++}`);
    params.push(filter.userId);
  }

  if (filter.status !== undefined) {
    conditions.push(`status = $${paramIndex++}`);
    params.push(filter.status);
  }

  if (filter.month !== undefined) {
    const { start, end } = getUtcMonthDateRange(filter.month);
    conditions.push(`processed_at >= $${paramIndex++}`);
    params.push(start.toISOString());
    conditions.push(`processed_at < $${paramIndex++}`);
    params.push(end.toISOString());
  }

  // Fetch limit + 1 rows to determine hasMore
  const fetchLimit = filter.limit + 1;
  const limitParamPlaceholder = `$${paramIndex++}`;
  params.push(fetchLimit);

  const offsetParamPlaceholder = `$${paramIndex++}`;
  params.push(filter.offset);

  const query = `
    SELECT
      id,
      request_id,
      user_id,
      requested_units,
      status,
      rejection_scope,
      rejection_rule,
      response_body,
      processed_at
    FROM consumption_records
    WHERE ${conditions.join(' AND ')}
    ORDER BY processed_at DESC, id DESC
    LIMIT ${limitParamPlaceholder} OFFSET ${offsetParamPlaceholder};
  `;

  const result = await executor.query<ConsumptionRecordRow>(query, params);

  const hasMore = result.rows.length > filter.limit;
  const rows = hasMore ? result.rows.slice(0, filter.limit) : result.rows;

  const items: RequestHistoryItem[] = rows.map((row) => ({
    id: String(row.id),
    requestId: row.request_id,
    userId: row.user_id,
    requestedUnits: Number(row.requested_units),
    status: row.status as 'ACCEPTED' | 'REJECTED',
    rejectionReason:
      row.status === 'REJECTED' && row.rejection_scope && row.rejection_rule
        ? {
            scope: row.rejection_scope as RejectionScope,
            rule: row.rejection_rule as RejectionRule,
          }
        : null,
    responseBody: row.response_body,
    processedAt:
      row.processed_at instanceof Date
        ? row.processed_at.toISOString()
        : new Date(row.processed_at).toISOString(),
  }));

  return {
    items,
    pagination: {
      limit: filter.limit,
      offset: filter.offset,
      hasMore,
    },
  };
}

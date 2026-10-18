// src/requests.ts
// منطق استعلام وتصفية سجل طلبات الاستهلاك وتقسيم الصفحات (Part 25: Request History & Pagination)

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
 * خطأ التحقق من صحة معلمات استعلام سجل الطلبات
 */
export class RequestQueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestQueryValidationError';
  }
}

/**
 * قائمة المعلمات المسموح بها صراحة في استعلام سجل الطلبات
 */
const ALLOWED_REQUESTS_QUERY_PARAMS = new Set(['limit', 'offset', 'userId', 'status', 'month']);

/**
 * صيغة التعبير النمطي للتحقق من الأعداد العشرية غير السالبة (أرقام فقط دون إشارات أو كسور)
 */
const NON_NEGATIVE_INTEGER_REGEX = /^\d+$/;

/**
 * صيغة التعبير النمطي للتحقق من تنسيق الشهر التقويمي YYYY-MM
 */
const YEAR_MONTH_REGEX = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/;

/**
 * دالة التحقق الصارم من معلمات استعلام السجل (Query Validation):
 * 1. ترفض أي معاملات غير معرّفة أو مكررة (مصفوفات).
 * 2. تفحص limit و offset كنصوص أرقام غير سالبة قبل التحويل، وتتحقق من كونهما أعداداً صحيحة آمنة ضمن الحدود.
 * 3. تفحص userId (نص غير فارغ بحد أقصى 64 محرفاً).
 * 4. تفحص status (حصراً 'ACCEPTED' أو 'REJECTED').
 * 5. تفحص month (صيغة YYYY-MM سنة من 1000 إلى 9999).
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

  // 1. التحقق من limit
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

  // 2. التحقق من offset
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

  // 3. التحقق من userId (اختياري)
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

  // 4. التحقق من status (اختياري)
  let status: 'ACCEPTED' | 'REJECTED' | undefined;
  if ('status' in record && record.status !== undefined) {
    if (typeof record.status !== 'string' || (record.status !== 'ACCEPTED' && record.status !== 'REJECTED')) {
      throw new RequestQueryValidationError("status must be either 'ACCEPTED' or 'REJECTED'");
    }
    status = record.status;
  }

  // 5. التحقق من month (اختياري)
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

/**
 * صف نتيجة استعلام جدول consumption_records من قاعدة البيانات
 */
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
 * تنفيذ استعلام سجل الطلبات وتقسيم الصفحات:
 * - يستعلم جدول consumption_records مباشرة بـ SELECT واحد.
 * - يطبّق عزل المستأجر account_id = $1 دائماً.
 * - يضيف المرشحات الاختيارية ديناميكياً باستخدام المعاملات المرقّمة $1, $2...
 * - يطلب limit + 1 صفاً لتحديد قيمة hasMore بدقة.
 * - يرتب النتائج بـ ORDER BY processed_at DESC, id DESC لضمان حتمية الترتيب.
 * - يعيد id كنص لتفادي فقد الدقة في BIGSERIAL.
 * - يعيد response_body المحفوظ كما هو دون إعادة احتساب الأرصدة.
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

  // جلب limit + 1 صفاً لتحديد وجود صفحات تالية
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

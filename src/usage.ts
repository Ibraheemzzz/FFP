// src/usage.ts
// منطق قراءة وعرض الاستخدام الحالي والتاريخي للحسابات والمستخدمين (Parts 23 & 24)

import type { DbExecutor } from './db.js';
import type {
  AccountUsageResponse,
  UserUsageResponse,
  UsagePlanSummary,
  HistoricalPlanSummary,
  HistoricalAccountUsageResponse,
  HistoricalUserUsageResponse,
} from './types.js';
import { calculateUsageSnapshot, getUtcYearMonth } from './consumptions.js';
import { AccountNotFoundError } from './accounts.js';
import { UserNotFoundError } from './users.js';

/**
 * خطأ التحقق من معاملات الاستعلام في مسارات الاستخدام
 */
export class UsageQueryValidationError extends Error {
  constructor(message = 'Query validation error') {
    super(message);
    this.name = 'UsageQueryValidationError';
  }
}

/**
 * دالة التحقق من معامِل الشهر في استعلامات الاستخدام (Part 24)
 *
 * القواعد الصارمة المطبقة:
 * 1. يسمح فقط بالمعامِل "month". أي معامِل إضافي أو مجهول يُرفض فوراً بـ 400.
 * 2. إذا لم يُمرر "month"، تعيد الدالة null للدلالة على استعلام الشهر الحالي.
 * 3. ترفض المصفوفات والقيم المكررة وغير النصية بـ 400.
 * 4. تحصر السنة بين 1000 و 9999 والشهر بين 01 و 12 بنمط: /^[1-9]\d{3}-(0[1-9]|1[0-2])$/
 * 5. تقارن بالشهر الحالي المأخوذ من نفس لقطة الساعة الملتقطة مرة واحدة.
 * 6. إذا كان الشهر مستقبلياً (month > currentUtcMonth): ترفض بـ 400.
 *
 * @param query كائن معاملات الاستعلام من طلب HTTP
 * @param currentUtcMonth الشهر الحالي بتوقيت UTC بصيغة YYYY-MM
 * @returns الشهر المطلوب بصيغة YYYY-MM أو null إذا لم يُحدد
 */
export function validateUsageMonthQuery(query: unknown, currentUtcMonth: string): string | null {
  if (query === null || query === undefined || typeof query !== 'object') {
    return null;
  }

  const queryRecord = query as Record<string, unknown>;
  const keys = Object.keys(queryRecord);

  if (keys.length === 0) {
    return null;
  }

  if (keys.length > 1 || keys[0] !== 'month') {
    throw new UsageQueryValidationError('Only the "month" query parameter is supported.');
  }

  const rawMonth = queryRecord.month;
  if (typeof rawMonth !== 'string') {
    throw new UsageQueryValidationError(
      'The "month" query parameter must be a single string in YYYY-MM format.'
    );
  }

  const trimmedMonth = rawMonth.trim();
  // التحقق الصارم من أن السنة 4 أرقام بين 1000 و 9999 والشهر بين 01 و 12
  const monthRegex = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/;
  if (!monthRegex.test(trimmedMonth)) {
    throw new UsageQueryValidationError(
      'Invalid month format. Expected YYYY-MM with a 4-digit year between 1000 and 9999 (e.g. 2026-09).'
    );
  }

  if (trimmedMonth > currentUtcMonth) {
    throw new UsageQueryValidationError('Cannot query usage for a future month.');
  }

  return trimmedMonth;
}

/**
 * دالة مساعدة سابقة للإبقاء على التوافق إن وُجدت استدعاءات خارجية لها
 */
export function assertNoUnsupportedQueryParams(query: unknown): void {
  if (typeof query === 'object' && query !== null) {
    const keys = Object.keys(query as Record<string, unknown>);
    if (keys.length > 0) {
      throw new UsageQueryValidationError('Only the "month" query parameter is supported.');
    }
  }
}

/**
 * خيارات قراءة الاستخدام (مثل حقن الساعة للاختبارات الزمنية وضمان اتساق الشهر)
 */
export interface GetUsageOptions {
  clock?: () => Date;
}

/**
 * حساب النطاق الزمني للشهر بتوقيت UTC بصيغة [بداية الشهر, بداية الشهر التالي)
 * يُستخدم للبحث الدقيق والمفهرس في سجلات الاستهلاك التاريخية
 */
export function getUtcMonthDateRange(yearMonth: string): { start: Date; end: Date } {
  const [yearStr, monthStr] = yearMonth.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return { start, end };
}

/**
 * دالة استخراج بيانات الخطة التاريخية من كائن سياق القرار بأمان
 */
function extractHistoricalPlan(planObj: unknown): HistoricalPlanSummary | null {
  if (!planObj || typeof planObj !== 'object') {
    return null;
  }
  const p = planObj as Record<string, unknown>;
  if (typeof p.id !== 'string' || p.id.trim() === '') {
    return null;
  }
  if (
    typeof p.monthlyLimit !== 'number' ||
    !Number.isSafeInteger(p.monthlyLimit) ||
    p.monthlyLimit < 0 ||
    typeof p.perRequestLimit !== 'number' ||
    !Number.isSafeInteger(p.perRequestLimit) ||
    p.perRequestLimit < 0
  ) {
    return null;
  }
  return {
    id: p.id,
    monthlyLimit: p.monthlyLimit,
    perRequestLimit: p.perRequestLimit,
  };
}

/**
 * نوع صف نتيجة استعلام استخدام الحساب الحالي من قاعدة البيانات
 */
interface AccountUsageRow {
  account_id: string;
  plan_id: string;
  plan_name: string;
  plan_type: string;
  plan_monthly_limit: string | number;
  plan_per_request_limit: string | number;
  plan_owner_account_id: string | null;
  consumed_units: string | number;
}

/**
 * نوع صف نتيجة استعلام استخدام الحساب لشهر سابق من قاعدة البيانات
 */
interface AccountHistoricalUsageRow {
  account_id: string;
  total_units: string | number;
  decision_context: unknown;
  last_request_at: Date | string | null;
}

/**
 * نوع صف نتيجة استعلام استخدام المستخدم وحصته المشتركة للشهر الحالي
 */
interface UserUsageRow {
  user_id: string;
  account_id: string;
  user_plan_id: string;
  user_plan_name: string;
  user_plan_type: string;
  user_plan_monthly_limit: string | number;
  user_plan_per_request_limit: string | number;
  user_plan_owner_account_id: string | null;
  account_plan_id: string;
  account_plan_name: string;
  account_plan_type: string;
  account_plan_monthly_limit: string | number;
  account_plan_per_request_limit: string | number;
  account_plan_owner_account_id: string | null;
  user_consumed_units: string | number;
  account_consumed_units: string | number;
}

/**
 * نوع صف نتيجة استعلام استخدام المستخدم لشهر سابق من قاعدة البيانات
 */
interface UserHistoricalUsageRow {
  user_id: string;
  account_id: string;
  user_total_units: string | number;
  account_total_units: string | number;
  decision_context: unknown;
  last_request_at: Date | string | null;
}

/**
 * استرجاع الاستخدام الحالي للحساب الموثق للشهر الحالي بتوقيت UTC (Part 23)
 */
export async function getAccountCurrentUsage(
  executor: DbExecutor,
  accountId: string,
  options?: GetUsageOptions
): Promise<AccountUsageResponse> {
  const clock = options?.clock ?? (() => new Date());
  const yearMonth = getUtcYearMonth(clock());

  const result = await executor.query<AccountUsageRow>(
    `SELECT
       a.id AS account_id,
       p.id AS plan_id,
       p.name AS plan_name,
       p.type AS plan_type,
       p.monthly_limit AS plan_monthly_limit,
       p.per_request_limit AS plan_per_request_limit,
       p.owner_account_id AS plan_owner_account_id,
       COALESCE(u.total_units, 0) AS consumed_units
     FROM accounts a
     JOIN plans p ON a.plan_id = p.id
     LEFT JOIN account_monthly_usage u 
       ON u.account_id = a.id AND u.year_month = $2
     WHERE a.id = $1;`,
    [accountId, yearMonth]
  );

  if (result.rows.length === 0) {
    throw new AccountNotFoundError('Account not found');
  }

  const row = result.rows[0];

  if (row.plan_type !== 'ACCOUNT') {
    throw new Error(`Account assigned invalid plan type '${row.plan_type}'. Expected 'ACCOUNT'.`);
  }

  if (row.plan_owner_account_id !== null && row.plan_owner_account_id !== accountId) {
    throw new Error('Account assigned inaccessible private plan belonging to another account.');
  }

  const monthlyLimit = Number(row.plan_monthly_limit);
  const perRequestLimit = Number(row.plan_per_request_limit);
  const consumed = Number(row.consumed_units);

  const planSummary: UsagePlanSummary = {
    id: row.plan_id,
    name: row.plan_name,
    type: 'ACCOUNT',
    monthlyLimit,
    perRequestLimit,
  };

  const usageSnapshot = calculateUsageSnapshot(monthlyLimit, consumed);

  return {
    accountId: row.account_id,
    yearMonth,
    plan: planSummary,
    usage: usageSnapshot,
  };
}

/**
 * استرجاع استخدام الحساب لشهر سابق (Part 24: Historical Account Usage)
 *
 * المبادئ الحاكمة:
 * 1. استهلاك الحساب المحقق يُقرأ من total_units في عداد الشهر.
 * 2. إذا لم يكن هناك عداد للشهر، يُعاد 0.
 * 3. الخطة والحدود تُستخرجان من decision_context لآخر طلب مسجل خلال ذلك الشهر (مقبولاً أو مرفوضاً).
 * 4. إذا لم توجد طلبات في ذلك الشهر، أو كان سياق آخر طلب فارغاً {}، تعود الخطة null.
 * 5. يُحفظ وقت آخر طلب lastRequestAt إذا وُجد الطلب حتى وإن كان سياقه فارغاً.
 * 6. لا يُعرض remaining تاريخياً إطلاقاً.
 */
export async function getAccountHistoricalUsage(
  executor: DbExecutor,
  accountId: string,
  yearMonth: string
): Promise<HistoricalAccountUsageResponse> {
  const { start, end } = getUtcMonthDateRange(yearMonth);

  const query = `
    WITH account_check AS (
      SELECT id FROM accounts WHERE id = $1
    ),
    monthly_counter AS (
      SELECT total_units
      FROM account_monthly_usage
      WHERE account_id = $1 AND year_month = $2
    ),
    latest_request AS (
      SELECT decision_context, processed_at
      FROM consumption_records
      WHERE account_id = $1
        AND processed_at >= $3 AND processed_at < $4
      ORDER BY processed_at DESC, id DESC
      LIMIT 1
    )
    SELECT 
      a.id AS account_id,
      COALESCE(mc.total_units, 0) AS total_units,
      lr.decision_context,
      lr.processed_at AS last_request_at
    FROM account_check a
    LEFT JOIN monthly_counter mc ON true
    LEFT JOIN latest_request lr ON true;
  `;

  const result = await executor.query<AccountHistoricalUsageRow>(query, [
    accountId,
    yearMonth,
    start.toISOString(),
    end.toISOString(),
  ]);

  if (result.rows.length === 0) {
    throw new AccountNotFoundError('Account not found');
  }

  const row = result.rows[0];
  const consumed = Number(row.total_units);

  let planAtLastRequest: HistoricalPlanSummary | null = null;
  if (row.decision_context && typeof row.decision_context === 'object') {
    const dc = row.decision_context as Record<string, unknown>;
    planAtLastRequest = extractHistoricalPlan(dc.accountPlan);
  }

  const lastRequestAt = row.last_request_at
    ? new Date(row.last_request_at).toISOString()
    : null;

  return {
    accountId: row.account_id,
    yearMonth,
    isCurrentMonth: false,
    consumed,
    planAtLastRequest,
    lastRequestAt,
  };
}

/**
 * استرجاع الاستخدام الحالي للمستخدم وحصته المشتركة للشهر الحالي (Part 23)
 */
export async function getUserCurrentUsage(
  executor: DbExecutor,
  accountId: string,
  userId: string,
  options?: GetUsageOptions
): Promise<UserUsageResponse> {
  const clock = options?.clock ?? (() => new Date());
  const yearMonth = getUtcYearMonth(clock());

  const result = await executor.query<UserUsageRow>(
    `SELECT
       u.id AS user_id,
       u.account_id AS account_id,
       up.id AS user_plan_id,
       up.name AS user_plan_name,
       up.type AS user_plan_type,
       up.monthly_limit AS user_plan_monthly_limit,
       up.per_request_limit AS user_plan_per_request_limit,
       up.owner_account_id AS user_plan_owner_account_id,
       ap.id AS account_plan_id,
       ap.name AS account_plan_name,
       ap.type AS account_plan_type,
       ap.monthly_limit AS account_plan_monthly_limit,
       ap.per_request_limit AS account_plan_per_request_limit,
       ap.owner_account_id AS account_plan_owner_account_id,
       COALESCE(umu.total_units, 0) AS user_consumed_units,
       COALESCE(amu.total_units, 0) AS account_consumed_units
     FROM users u
     JOIN accounts a 
       ON u.account_id = a.id
     JOIN plans up 
       ON u.plan_id = up.id
     JOIN plans ap 
       ON a.plan_id = ap.id
     LEFT JOIN user_monthly_usage umu 
       ON umu.account_id = u.account_id 
       AND umu.user_id = u.id 
       AND umu.year_month = $3
     LEFT JOIN account_monthly_usage amu 
       ON amu.account_id = a.id 
       AND amu.year_month = $3
     WHERE u.id = $1 AND u.account_id = $2;`,
    [userId, accountId, yearMonth]
  );

  if (result.rows.length === 0) {
    throw new UserNotFoundError('User not found');
  }

  const row = result.rows[0];

  if (row.user_plan_type !== 'USER') {
    throw new Error(`User assigned invalid plan type '${row.user_plan_type}'. Expected 'USER'.`);
  }
  if (row.account_plan_type !== 'ACCOUNT') {
    throw new Error(`Account assigned invalid plan type '${row.account_plan_type}'. Expected 'ACCOUNT'.`);
  }

  if (row.user_plan_owner_account_id !== null && row.user_plan_owner_account_id !== accountId) {
    throw new Error('User assigned inaccessible private plan belonging to another account.');
  }
  if (row.account_plan_owner_account_id !== null && row.account_plan_owner_account_id !== accountId) {
    throw new Error('Account assigned inaccessible private plan belonging to another account.');
  }

  const userMonthlyLimit = Number(row.user_plan_monthly_limit);
  const userPerRequestLimit = Number(row.user_plan_per_request_limit);
  const userConsumed = Number(row.user_consumed_units);

  const accountMonthlyLimit = Number(row.account_plan_monthly_limit);
  const accountPerRequestLimit = Number(row.account_plan_per_request_limit);
  const accountConsumed = Number(row.account_consumed_units);

  const userPlanSummary: UsagePlanSummary = {
    id: row.user_plan_id,
    name: row.user_plan_name,
    type: 'USER',
    monthlyLimit: userMonthlyLimit,
    perRequestLimit: userPerRequestLimit,
  };

  const accountPlanSummary: UsagePlanSummary = {
    id: row.account_plan_id,
    name: row.account_plan_name,
    type: 'ACCOUNT',
    monthlyLimit: accountMonthlyLimit,
    perRequestLimit: accountPerRequestLimit,
  };

  const userUsageSnapshot = calculateUsageSnapshot(userMonthlyLimit, userConsumed);
  const accountUsageSnapshot = calculateUsageSnapshot(accountMonthlyLimit, accountConsumed);

  return {
    userId: row.user_id,
    accountId: row.account_id,
    yearMonth,
    userPlan: userPlanSummary,
    userUsage: userUsageSnapshot,
    accountPlan: accountPlanSummary,
    accountUsage: accountUsageSnapshot,
  };
}

/**
 * استرجاع استخدام المستخدم لشهر سابق (Part 24: Historical User Usage)
 *
 * المبادئ الحاكمة:
 * 1. استهلاك المستخدم والحساب يُقرآن من total_units لعدّاد كل منهما لذلك الشهر.
 * 2. خطة المستخدم وخطة الحساب تُستخرجان من decision_context لآخر طلب مسجل لهذا المستخدم خلال الشهر.
 * 3. إذا لم توجد طلبات لذلك المستخدم في ذلك الشهر، أو كان سياق آخر طلب فارغاً {}، تعود الخطتان null.
 * 4. يُحفظ وقت آخر طلب lastRequestAt إذا وُجد الطلب حتى وإن كان سياقه فارغاً.
 * 5. يُحافظ على العزل التام للمستأجرين ويرمى UserNotFoundError إذا لم يوجد المستخدم ضمن الحساب الموثق.
 * 6. لا يُعرض remaining تاريخياً إطلاقاً.
 */
export async function getUserHistoricalUsage(
  executor: DbExecutor,
  accountId: string,
  userId: string,
  yearMonth: string
): Promise<HistoricalUserUsageResponse> {
  const { start, end } = getUtcMonthDateRange(yearMonth);

  const query = `
    WITH user_check AS (
      SELECT u.id AS user_id, u.account_id
      FROM users u
      WHERE u.id = $1 AND u.account_id = $2
    ),
    user_counter AS (
      SELECT total_units
      FROM user_monthly_usage
      WHERE account_id = $2 AND user_id = $1 AND year_month = $3
    ),
    account_counter AS (
      SELECT total_units
      FROM account_monthly_usage
      WHERE account_id = $2 AND year_month = $3
    ),
    latest_request AS (
      SELECT decision_context, processed_at
      FROM consumption_records
      WHERE account_id = $2 AND user_id = $1
        AND processed_at >= $4 AND processed_at < $5
      ORDER BY processed_at DESC, id DESC
      LIMIT 1
    )
    SELECT 
      uc.user_id,
      uc.account_id,
      COALESCE(umc.total_units, 0) AS user_total_units,
      COALESCE(amc.total_units, 0) AS account_total_units,
      lr.decision_context,
      lr.processed_at AS last_request_at
    FROM user_check uc
    LEFT JOIN user_counter umc ON true
    LEFT JOIN account_counter amc ON true
    LEFT JOIN latest_request lr ON true;
  `;

  const result = await executor.query<UserHistoricalUsageRow>(query, [
    userId,
    accountId,
    yearMonth,
    start.toISOString(),
    end.toISOString(),
  ]);

  if (result.rows.length === 0) {
    throw new UserNotFoundError('User not found');
  }

  const row = result.rows[0];
  const userConsumed = Number(row.user_total_units);
  const accountConsumed = Number(row.account_total_units);

  let userPlanAtLastRequest: HistoricalPlanSummary | null = null;
  let accountPlanAtLastRequest: HistoricalPlanSummary | null = null;

  if (row.decision_context && typeof row.decision_context === 'object') {
    const dc = row.decision_context as Record<string, unknown>;
    userPlanAtLastRequest = extractHistoricalPlan(dc.userPlan);
    accountPlanAtLastRequest = extractHistoricalPlan(dc.accountPlan);
  }

  const lastRequestAt = row.last_request_at
    ? new Date(row.last_request_at).toISOString()
    : null;

  return {
    userId: row.user_id,
    accountId: row.account_id,
    yearMonth,
    isCurrentMonth: false,
    userConsumed,
    accountConsumed,
    userPlanAtLastRequest,
    accountPlanAtLastRequest,
    lastRequestAt,
  };
}

// src/usage.ts
// منطق قراءة وعرض الاستخدام الحالي للحسابات والمستخدمين (Get Current Usage API)

import type { DbExecutor } from './db.js';
import type {
  AccountUsageResponse,
  UserUsageResponse,
  UsagePlanSummary,
} from './types.js';
import { calculateUsageSnapshot, getUtcYearMonth } from './consumptions.js';
import { AccountNotFoundError } from './accounts.js';
import { UserNotFoundError } from './users.js';

/**
 * خطأ التحقق من معاملات الاستعلام غير المدعومة في مسارات الاستخدام الحالي
 */
export class UsageQueryValidationError extends Error {
  constructor(message = 'Query parameters are not supported for current usage in this version. This endpoint strictly returns current month usage.') {
    super(message);
    this.name = 'UsageQueryValidationError';
  }
}

/**
 * دالة التحقق من عدم تمرير معاملات استعلام غير مدعومة في الجزء 23
 * تمنع إيهام العميل بأنه اختار شهراً قديماً مثل ?month=2026-09،
 * حيث إن قراءة الأشهر السابقة والسياسة المعتمدة لحدودها التاريخية محصورة في الجزء 24.
 */
export function assertNoUnsupportedQueryParams(query: unknown): void {
  if (typeof query === 'object' && query !== null) {
    const keys = Object.keys(query as Record<string, unknown>);
    if (keys.length > 0) {
      throw new UsageQueryValidationError(
        'Query parameters are not supported for current usage in this version. This endpoint strictly returns current month usage.'
      );
    }
  }
}

/**
 * خيارات قراءة الاستخدام (مثل حقن الساعة للاختبارات الزمنية)
 */
export interface GetUsageOptions {
  clock?: () => Date;
}

/**
 * نوع صف نتيجة استعلام استخدام الحساب من قاعدة البيانات
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
 * نوع صف نتيجة استعلام استخدام المستخدم وحصته المشتركة من قاعدة البيانات
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
 * استرجاع الاستخدام الحالي للحساب الموثق للشهر الحالي بتوقيت UTC
 *
 * المبادئ المطبقة:
 * 1. استعلام SELECT مفرد وذري يربط الحساب بخطته الحالية وعداد الاستخدام الشهري بـ LEFT JOIN.
 * 2. يرى الاستعلام لقطة MVCC متسقة ولحظية للحساب.
 * 3. التحقق الصارم من نوع الخطة (ACCOUNT) وإتاحتها للحساب.
 * 4. إعادة استخدام calculateUsageSnapshot لضمان عدم سلبية المتبقي.
 * 5. القراءة معلومات لحظية وليست حجزاً أو ضمان قبول.
 *
 * @param executor منفذ الاستعلامات (Pool أو PoolClient)
 * @param accountId معرف الحساب الموثق
 * @param options خيارات القراءة (حقن الساعة)
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

  // التحقق من نوع الخطة وإتاحتها
  if (row.plan_type !== 'ACCOUNT') {
    throw new Error(`Account assigned invalid plan type '${row.plan_type}'. Expected 'ACCOUNT'.`);
  }

  if (row.plan_owner_account_id !== null && row.plan_owner_account_id !== accountId) {
    throw new Error('Account assigned inaccessible private plan belonging to another account.');
  }

  // تحويل حقول BIGINT بأمان من نصوص إلى أرقام
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
 * استرجاع الاستخدام الحالي للمستخدم وحصته المشتركة مع حسابه للشهر الحالي بتوقيت UTC
 *
 * المبادئ المطبقة:
 * 1. استعلام SELECT مفرد وذري يربط المستخدم بحسابه والخطتين والعدادين في لقطة MVCC متسقة واحدة.
 * 2. قيد WHERE u.id = $1 AND u.account_id = $2 يضمن التفرّد والعزل الصارم بين المستأجرين؛
 *    إذا لم يكن المستخدم موجوداً أو يتبع حساباً آخر، يُرمى UserNotFoundError الذي يُترجم لـ 404.
 * 3. ربط عداد المستخدم يشمل u.account_id و u.id و year_month لمنع أي خلط.
 * 4. التحقق الصارم من نوع خطة المستخدم (USER) وخطة الحساب (ACCOUNT) وإتاحتهما.
 * 5. إعادة استخدام calculateUsageSnapshot لحساب المتبقي وسقف الصفر الأدنى.
 * 6. القراءة معلومات لحظية وليست حجزاً أو ضمان قبول.
 *
 * @param executor منفذ الاستعلامات (Pool أو PoolClient)
 * @param accountId معرف الحساب الموثق
 * @param userId معرف المستخدم المطلوب
 * @param options خيارات القراءة (حقن الساعة)
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
       -- خطة المستخدم
       up.id AS user_plan_id,
       up.name AS user_plan_name,
       up.type AS user_plan_type,
       up.monthly_limit AS user_plan_monthly_limit,
       up.per_request_limit AS user_plan_per_request_limit,
       up.owner_account_id AS user_plan_owner_account_id,
       -- خطة الحساب
       ap.id AS account_plan_id,
       ap.name AS account_plan_name,
       ap.type AS account_plan_type,
       ap.monthly_limit AS account_plan_monthly_limit,
       ap.per_request_limit AS account_plan_per_request_limit,
       ap.owner_account_id AS account_plan_owner_account_id,
       -- عداد المستخدم للشهر الحالي
       COALESCE(umu.total_units, 0) AS user_consumed_units,
       -- عداد الحساب للشهر الحالي
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

  // التحقق من نوع الخطتين
  if (row.user_plan_type !== 'USER') {
    throw new Error(`User assigned invalid plan type '${row.user_plan_type}'. Expected 'USER'.`);
  }
  if (row.account_plan_type !== 'ACCOUNT') {
    throw new Error(`Account assigned invalid plan type '${row.account_plan_type}'. Expected 'ACCOUNT'.`);
  }

  // التحقق من إتاحة الخطتين للحساب
  if (row.user_plan_owner_account_id !== null && row.user_plan_owner_account_id !== accountId) {
    throw new Error('User assigned inaccessible private plan belonging to another account.');
  }
  if (row.account_plan_owner_account_id !== null && row.account_plan_owner_account_id !== accountId) {
    throw new Error('Account assigned inaccessible private plan belonging to another account.');
  }

  // تحويل حقول BIGINT بأمان من نصوص إلى أرقام
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

// src/consumptions.ts
// منطق التحقق ومعالجة طلبات الاستهلاك (Consumption Handling & Validation)

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
 * خطأ مخصص لفشل التحقق من مدخلات الاستهلاك
 */
export class ConsumptionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsumptionValidationError';
  }
}

/**
 * قائمة الحقول المسموح بها صراحة في طلب الاستهلاك لمنع أي حقول إضافية أو خاطئة
 */
const ALLOWED_CONSUMPTION_FIELDS = new Set(['userId', 'units', 'requestId']);

/**
 * دالة التحقق الصارم من مدخلات طلب الاستهلاك عند التشغيل (Runtime Validation)
 * 
 * القواعد المطبقة:
 * 1. جسم الطلب كائن JSON صالح وغير فارغ وليس مصفوفة.
 * 2. رفض أي حقول غير معرّفة أو مكتوبة بحالة أحرف مختلفة (Strict Field Checking).
 * 3. وجود الحقول الإلزامية الثلاثة: userId, units, requestId.
 * 4. التحقق من المقدار (units):
 *    - typeof units === 'number' && Number.isSafeInteger(units) && units > 0
 *    - يضمن أن القيمة عدد صحيح آمن وموجب تماماً دون تحويل ضمني للنصوص، ويمنع 0 و-1 و1.5 وNaN وInfinity.
 * 5. التحقق من معرف المستخدم (userId):
 *    - نص غير فارغ بعد إزالة المسافات الطرفية (trim).
 *    - لا يتجاوز 64 محرفاً.
 * 6. التحقق من معرف الطلب (requestId):
 *    - نص غير فارغ بعد إزالة المسافات الطرفية (trim).
 *    - لا يتجاوز 128 محرفاً.
 *    - إزالة المسافات الطرفية تطبّق أيضاً على requestId لأن قيمته المجرّدة تحدد هوية الطلب
 *      عند تطبيق منع التكرار (Deduplication / Idempotency) في الجزء 22.
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

  // التحقق من userId
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

  // التحقق من units: عدد صحيح آمن موجب
  const units = record.units;
  if (typeof units !== 'number' || !Number.isSafeInteger(units) || units <= 0) {
    throw new ConsumptionValidationError('units must be a positive safe integer greater than zero');
  }

  // التحقق من requestId
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
 * استخراج السنة والشهر بتوقيت UTC بصيغة YYYY-MM
 * 
 * القواعد المطبقة:
 * 1. التحقق من صلاحية كائن التاريخ (ليس Invalid Date أو NaN).
 * 2. التحقق من نطاق السنة: حصر السنة بين 1000 و 9999 كخيار تطبيقي ملائم للخدمة يضمن
 *    تمثيل السنة بأربعة أرقام موجبة تتطابق مع متطلبات التخزين وقيد قاعدة البيانات:
 *    CHECK (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
 * 3. استخراج الشهر بتوقيت UTC (0-11) وإكماله إلى رقمين بصفر في البداية (01-12).
 * 4. استخدام الوقت الحالي افتراضياً عند عدم تمرير وسيط تاريخ.
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
 * سياق مدخلات تقييم القواعد الأربع للحصص
 * 
 * اشتراطات المدخلات:
 * - requestedUnits: عدد صحيح آمن موجب تماماً (> 0).
 * - الحدود والمستهلك: أعداد صحيحة آمنة غير سالبة (>= 0).
 * ملاحظة: هذه دالة نطاق داخلية تستقبل بيانات تم التحقق من صحتها مسبقاً،
 * وليست بديلاً عن دالة التحقق من المدخلات validateConsumptionInput.
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
 * نتيجة تقييم القواعد: إما قبول الطلب أو رفضه مع تحديد السبب الصريح
 */
export type QuotaEvaluationResult =
  | { accepted: true }
  | { accepted: false; reason: RejectionReason };

/**
 * دالة تقييم قواعد الحصص الأربع لطلب الاستهلاك
 * 
 * القواعد المطبقة وترتيب الفحص الحتمي:
 * 1. حد الحساب لكل طلب: requestedUnits > accountPerRequestLimit
 * 2. حد المستخدم لكل طلب: requestedUnits > userPerRequestLimit
 * 3. حصة الحساب الشهرية: requestedUnits > accountMonthlyLimit - accountConsumedUnits
 * 4. حصة المستخدم الشهرية: requestedUnits > userMonthlyLimit - userConsumedUnits
 * 
 * استخدام المقارنة بالطرح (Limit - Consumed) يمنع فيضان الأعداد خارج النطاق الآمن،
 * ويتعامل تلقائياً وبدقة مع حالات تخفيض الخطة (حيث يكون الفرق سالباً ويُرفض أي طلب موجب).
 */
export function evaluateQuotaRules(context: QuotaEvaluationContext): QuotaEvaluationResult {
  // 1. فحص حد الحساب لكل طلب
  if (context.requestedUnits > context.accountPerRequestLimit) {
    return {
      accepted: false,
      reason: { scope: 'account', rule: 'max_per_request' },
    };
  }

  // 2. فحص حد المستخدم لكل طلب
  if (context.requestedUnits > context.userPerRequestLimit) {
    return {
      accepted: false,
      reason: { scope: 'user', rule: 'max_per_request' },
    };
  }

  // 3. فحص الحصة الشهرية للحساب بالمقارنة بالطرح
  if (context.requestedUnits > context.accountMonthlyLimit - context.accountConsumedUnits) {
    return {
      accepted: false,
      reason: { scope: 'account', rule: 'monthly_allowance' },
    };
  }

  // 4. فحص الحصة الشهرية للمستخدم بالمقارنة بالطرح
  if (context.requestedUnits > context.userMonthlyLimit - context.userConsumedUnits) {
    return {
      accepted: false,
      reason: { scope: 'user', rule: 'monthly_allowance' },
    };
  }

  return { accepted: true };
}

/**
 * حساب لقطة الاستخدام (المستهلك والمتبقي)
 * 
 * القواعد المطبقة:
 * - المدخلات: أعداد صحيحة آمنة غير سالبة (>= 0) تم التحقق منها مسبقاً.
 * - المتبقي: يُحسب ديناميكياً بالمعادلة Math.max(0, monthlyLimit - consumedUnits).
 * - لا يكون المتبقي سالباً أبداً؛ إذا كان المستهلك أكبر من الحد (بعد تخفيض الخطة)،
 *   فإن المتبقي هو 0، ويظل المستهلك يعكس الحقيقة التاريخية دون تصفير.
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
 * قراءة الاستهلاك الشهري للحساب للشهر المحدد
 * 
 * ملاحظات معمارية:
 * 1. عمود total_units من نوع BIGINT ويُرجع كنص عبر pg؛ يتم تحويله إلى number
 *    بأمان بناءً على قيد النطاق الآمن في الجدول (total_units <= 9007199254740991).
 * 2. إرجاع 0 يعني غياب صف العداد فقط (شهر جديد لم يُسجل فيه استهلاك).
 * 3. في حال حدوث أي خطأ في قاعدة البيانات، ينتقل الخطأ للمستدعي ولا يُحوّل إلى صفر.
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
 * قراءة الاستهلاك الشهري للمستخدم للشهر المحدد مع فرض عزل الحسابات
 * 
 * ملاحظات معمارية:
 * 1. الاستعلام مقيّد بـ account_id و user_id و year_month لضمان عزل المستأجرين.
 * 2. إرجاع 0 لا يثبت وجود المستخدم أو ملكيته، لأن غياب العداد أو عدم تطابق
 *    الحساب كلاهما يُعيد صفوفاً فارغة؛ يجب على المسارات التحقق من وجود المستخدم
 *    وملكيته أولاً قبل الاعتماد على نتيجة العداد.
 * 3. في حال حدوث خطأ في قاعدة البيانات، ينتقل الخطأ للمستدعي ولا يُحوّل إلى صفر.
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
 * خيارات تنفيذ طلب الاستهلاك
 */
export interface ExecuteConsumptionOptions {
  /**
   * دالة اختيارية لحقن توقيت المعالجة بدلاً من ساعة النظام (مفيدة للاختبارات وتثبيت الوقت)
   * يتم استدعاؤها حصراً بعد الحصول على قفل الحساب
   */
  clock?: () => Date;
}

/**
 * سياق التدقيق وحفظ القرارات التاريخية في قاعدة البيانات
 * يُحفظ في عمود decision_context لضمان بقاء تفسير القرار مستقلاً عن أي تعديل لاحق للخطط
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
 * دالة تنفيذ المعاملة الداخلية (Private): تنفّذ خطوات القراءة والتقييم والكتابات الثلاث
 * تحت مظلة الاتصال والقفل المفتوح، دون بدء معاملة أو إنهائها أو تحرير الاتصال.
 *
 * @param client اتصال قاعدة البيانات المحجوز بالمعاملة والقفل
 * @param accountId معرّف الحساب الموثق
 * @param request طلب استهلاك مدقق ومطابق للنوع ConsumptionRequest، تم التحقق منه مسبقاً بواسطة validateConsumptionInput
 * @param options خيارات التنفيذ (مثل حقن الساعة للاختبارات)
 */
async function processConsumption(
  client: pg.PoolClient,
  accountId: string,
  request: ConsumptionRequest,
  options?: ExecuteConsumptionOptions
): Promise<ConsumptionDecision> {
  // 1. استدعاء الساعة مرة واحدة فقط بعد حيازة القفل لتحديد لحظة المعالجة وشهر المحاسبة
  const clock = options?.clock ?? (() => new Date());
  const processedAt = clock();
  const yearMonth = getUtcYearMonth(processedAt);

  // 2. التحقق من وجود المستخدم وتبعيته للحساب الموثق
  const user = await getUserById(client, request.userId, accountId);
  if (!user) {
    throw new UserNotFoundError('User not found');
  }

  // 3. قراءة إسناد خطة الحساب الحالية من قاعدة البيانات مباشرة تحت القفل
  const accountRes = await client.query<{ plan_id: string }>(
    'SELECT plan_id FROM accounts WHERE id = $1',
    [accountId]
  );
  if (accountRes.rows.length === 0) {
    throw new Error('Account not found');
  }
  const accountPlanId = accountRes.rows[0].plan_id;

  // 4. جلب خطة الحساب والتحقق من إتاحتها وصحة نوعها
  const accountPlan = await getAccessiblePlan(client, accountPlanId, accountId);
  if (!accountPlan) {
    throw new Error(`Account plan '${accountPlanId}' not found or not accessible`);
  }
  if (accountPlan.type !== 'ACCOUNT') {
    throw new Error(`Account plan '${accountPlan.id}' must be of type 'ACCOUNT'`);
  }

  // 5. جلب خطة المستخدم والتحقق من إتاحتها وصحة نوعها
  const userPlan = await getAccessiblePlan(client, user.planId, accountId);
  if (!userPlan) {
    throw new Error(`User plan '${user.planId}' not found or not accessible`);
  }
  if (userPlan.type !== 'USER') {
    throw new Error(`User plan '${userPlan.id}' must be of type 'USER'`);
  }

  // 6. قراءة الاستهلاك الشهري التراكمي القائم للحساب والمستخدم للشهر المحدد
  const accountConsumedUnits = await getAccountMonthlyUsage(client, accountId, yearMonth);
  const userConsumedUnits = await getUserMonthlyUsage(client, accountId, request.userId, yearMonth);

  // 7. تقييم قواعد الحصص الأربع
  const evaluationResult = evaluateQuotaRules({
    requestedUnits: request.units,
    accountMonthlyLimit: accountPlan.monthlyLimit,
    accountPerRequestLimit: accountPlan.perRequestLimit,
    userMonthlyLimit: userPlan.monthlyLimit,
    userPerRequestLimit: userPlan.perRequestLimit,
    accountConsumedUnits,
    userConsumedUnits,
  });

  // 8. تجهيز سياق القرار التاريخي الكامل لحفظه صراحة في قاعدة البيانات
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

  // 9. تفريع المسار بناءً على نتيجة التقييم:
  if (evaluationResult.accepted) {
    // --- مسار القبول (ACCEPTED) ---
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

    // أ) تحديث عداد الحساب الشهري ذرّياً عبر UPSERT
    await client.query(
      `INSERT INTO account_monthly_usage (account_id, year_month, total_units, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (account_id, year_month)
       DO UPDATE SET total_units = account_monthly_usage.total_units + EXCLUDED.total_units,
                     updated_at = NOW();`,
      [accountId, yearMonth, request.units]
    );

    // ب) تحديث عداد المستخدم الشهري ذرّياً عبر UPSERT
    await client.query(
      `INSERT INTO user_monthly_usage (account_id, user_id, year_month, total_units, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, year_month)
       DO UPDATE SET total_units = user_monthly_usage.total_units + EXCLUDED.total_units,
                     updated_at = NOW();`,
      [accountId, request.userId, yearMonth, request.units]
    );

    // ج) حفظ سجل الاستهلاك المقبول مع السياق التاريخي
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
    // --- مسار الرفض بسبب القواعد (REJECTED) ---
    // الرفض نتيجة تجارية طبيعية: العدادات لا تزيد، لكن القرار وسياقه يُحفظان بنجاح
    const accountSnapshot = calculateUsageSnapshot(accountPlan.monthlyLimit, accountConsumedUnits);
    const userSnapshot = calculateUsageSnapshot(userPlan.monthlyLimit, userConsumedUnits);

    const decision: RejectedDecision = {
      accepted: false,
      requestId: request.requestId,
      reason: evaluationResult.reason,
      account: accountSnapshot,
      user: userSnapshot,
    };

    // حفظ سجل الاستهلاك المرفوض مع سبب الرفض والسياق التاريخي
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
 * دالة الاستهلاك العامة: مسؤولة عن حجز المعاملة وقفل الحساب وإدارتهما
 * 
 * @param pool مجمع اتصالات قاعدة البيانات
 * @param accountId معرّف الحساب الموثق
 * @param request طلب استهلاك مدقق مسبقاً بواسطة validateConsumptionInput
 * @param options خيارات التنفيذ (مثل حقن الساعة للاختبارات)
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


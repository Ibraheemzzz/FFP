// src/plans.ts
import crypto from 'node:crypto';
import type pg from 'pg';

/**
 * نطاق تطبيق الخطة: إما على مستوى الحساب أو على مستوى المستخدم
 */
export type PlanType = 'ACCOUNT' | 'USER';

export interface Plan {
  id: string;
  name: string;
  type: PlanType;
  monthlyLimit: number;
  /**
   * حد الاستهلاك للطلب الفردي الواحد (units per single request):
   * يُفحص لكل عملية استهلاك منفردة، وليس سقفاً لمجموع الطلبات المتزامنة أو قياساً لطاقة الخادم.
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
  /**
   * حد الاستهلاك للطلب الفردي الواحد (units per single request):
   * يُفحص لكل عملية استهلاك منفصلة. بعض السياسات والأرقام الافتراضية هي اختيارات تصميمية
   * معتمدة للمنتج ([مرن — برّر]) وليست متطلبات حرفية مفروضة في الدليل.
   */
  perRequestLimit: number;
}

export interface PlanUpdateInput {
  name?: string;
  monthlyLimit?: number;
  perRequestLimit?: number;
}

/**
 * فئة الخطأ المخصصة لعدم وجود المورد أو عدم إتاحته للمستأجر الحالي
 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * فئة الخطأ المخصصة لمحاولة تعديل الموارد المحمية أو الممنوعة كلياً (مثل الخطط العامة)
 */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * فئة الخطأ المخصصة للتحقق من صحة مدخلات وتعريفات الخطط
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
 * التحقق من صحة تعريف الخطة (Plan Definition Validation):
 * - يتطلب جسماً صالحاً ككائن JSON غير فارغ
 * - يرفض الحقول غير المعروفة أو المكتوبة بحالة أحرف مختلفة دون تحويل تلقائي
 * - يتطلب الحقول الأربعة: name و type و monthlyLimit و perRequestLimit
 * - name: نص غير فارغ بعد trim وبحد أقصى 100 محرف
 * - type: إما 'ACCOUNT' أو 'USER' حصراً
 * - monthlyLimit و perRequestLimit: أعداد صحيحة آمنة غير سالبة (يسمح بالصفر وبأن يتجاوز أحدهما الآخر)
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

  // 1. التحقق من حقل name
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

  // 2. التحقق من حقل type
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

  // 3. التحقق من حقل monthlyLimit
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

  // 4. التحقق من حقل perRequestLimit
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
 * التحقق من وجود نتيجة الاستعلام فقط؛
 * منع الوصول لموارد الحسابات الأخرى يتحقق داخل جملة الاستعلام نفسها في قاعدة البيانات
 */
export function assertResourceFound<T>(resource: T | null, message: string): T {
  if (resource === null) {
    throw new NotFoundError(message);
  }
  return resource;
}

/**
 * استعلام خطة متاحة للحساب: خطة عامة أو خطة خاصة مملوكة لنفس الحساب
 * المنع يتم في الاستعلام لضمان عدم تسريب أي صف يخص حساباً آخر
 */
export async function getAccessiblePlan(
  pool: pg.Pool,
  planId: string,
  accountId: string
): Promise<Plan | null> {
  const result = await pool.query<PlanRow>(
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
 * التحقق الصارم من معامل التصفية بحسب النوع (Query Parameter: ?type=):
 * - اختياري: يعيد undefined إذا لم يُرسل
 * - يرفض القيم الفارغة، أو المصفوفات، أو القيم غير النصية، أو القيم غير المطابقة لـ ACCOUNT أو USER
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

  // رفض القيم الفارغة بعد trim، والتحقق الصارم بحساسية لحالة الأحرف
  if (typeParam !== 'ACCOUNT' && typeParam !== 'USER') {
    throw new PlanValidationError(
      "Invalid plan type filter. Allowed values: 'ACCOUNT', 'USER'"
    );
  }

  return typeParam;
}

/**
 * استعلام قائمة الخطط المتاحة للحساب مع تطبيق عزل الحسابات والترتيب الثابت:
 * - يعيد الخطط العامة (owner_account_id IS NULL) + الخطط الخاصة بالحساب الموثق
 * - يدعم التصفية الاختيارية بنوع الخطة typeFilter
 * - الترتيب دائماً تصاعدياً بـ created_at ثم id
 * - يعيد مصفوفة فارغة [] عند عدم وجود خطط مطابقة دون إلقاء خطأ
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
 * توليد معرّف عشوائي مشفر للخطة بصيغة plan_<24 hex chars>.
 * يولد معرّفاً بطول 29 حرفاً يقع بأمان تحت حد VARCHAR(64).
 * الفضاء العشوائي (2^96 من المعرفات الممكنة) يقلل احتمال التصادم جداً،
 * بينما قيد المفتاح الأساسي في PostgreSQL هو الضامن لمنع حفظ أي تكرار.
 */
export function generatePlanId(): string {
  return `plan_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * التحقق الصارم من مدخلات التحديث الجزئي للخطة (PATCH /plans/:planId):
 * - يجب أن يكون كائناً غير فارغ يحتوي على حقل واحد على الأقل.
 * - يرفض صراحة محاولة تعديل نوع الخطة 'type'.
 * - يرفض أي حقول مجهولة أو زائدة عبر Object.keys.
 * - يرفض صراحة القيمة null لأي حقل مرسل.
 * - يقبل 0 في monthlyLimit و perRequestLimit كأعداد صحيحة آمنة غير سالبة.
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

  // رفض محاولة تعديل نوع الخطة صراحة
  if ('type' in record) {
    throw new PlanValidationError('Plan type cannot be changed');
  }

  // فحص صارم للحقول المجهولة
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
 * إنشاء خطة خاصة بحساب موثق:
 * - ربط الخطة بحساب المالك الحصري (owner_account_id = accountId)
 * - توليد معرّف فريد بصيغة plan_...
 * - قيد المفتاح الأساسي في PostgreSQL يمنع تكرار المعرف
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
 * تعديل خطة خاصة بحساب موثق (PATCH):
 * 1. التحقق من وجود الخطة وإتاحتها للمستأجر عبر getAccessiblePlan
 * 2. رفض تعديل الخطط العامة بـ ForbiddenError (403)
 * 3. تنفيذ التحديث الذري في قاعدة البيانات مع اشتراط الملكية المباشر:
 *    WHERE id = $4 AND owner_account_id = $5
 *    واستخدام COALESCE للحفاظ على الحقول غير المرسلة دون قراءة مسبقة
 * 4. فحص عدد الصفوف المتأثرة؛ إذا كان صفراً يُلقى NotFoundError (404) دون افتراض وجود صف
 */
export async function updateCustomPlan(
  pool: pg.Pool,
  planId: string,
  accountId: string,
  input: PlanUpdateInput
): Promise<Plan> {
  // فحص مبدئي للوجود والصلاحية مع عزل الحسابات
  const existingPlan = await getAccessiblePlan(pool, planId, accountId);
  if (!existingPlan) {
    throw new NotFoundError('Plan not found');
  }

  // حماية الخطط العامة من التعديل
  if (existingPlan.ownerAccountId === null) {
    throw new ForbiddenError('Default public plans cannot be modified');
  }

  // التحديث الذري مع العزل التام في SQL والمحافظة على الحقول غير المرسلة
  const result = await pool.query<PlanRow>(
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

  // إذا لم يعد الاستعلام أي صف، يُرمى خطأ عدم الوجود دون افتراض وجود rows[0]
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
}


// src/plans.ts
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

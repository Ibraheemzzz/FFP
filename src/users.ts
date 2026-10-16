// src/users.ts
import crypto from 'node:crypto';
import type pg from 'pg';
import { type DbExecutor, withAccountLock } from './db.js';
import { getAccessiblePlan } from './plans.js';

export interface User {
  id: string;
  accountId: string;
  planId: string;
  externalId: string | null;
  createdAt: string;
}

export interface CreateUserInput {
  externalId?: string;
  planId?: string;
}

export interface UpdateUserPlanInput {
  planId: string;
}

interface UserRow {
  id: string;
  account_id: string;
  plan_id: string;
  external_id: string | null;
  created_at: Date;
}

export class UserValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserValidationError';
  }
}

export class UserConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserConflictError';
  }
}

export class UserNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserNotFoundError';
  }
}

/**
 * الخطة الافتراضية العامة للمستخدمين عند عدم تحديد خطة في طلب الإنشاء
 */
export const DEFAULT_USER_PLAN_ID = 'plan_default_user';

const ALLOWED_CREATE_USER_FIELDS = new Set(['externalId', 'planId']);
const ALLOWED_UPDATE_USER_PLAN_FIELDS = new Set(['planId']);

/**
 * التحقق من صحة مدخلات إنشاء مستخدم جديد:
 * - يسمح بـ undefined أو {} لاعتماد الخطة الافتراضية
 * - يرفض null أو المصفوفات أو الأنواع البدائية
 * - يرفض أي حقول غير معروفة أو مكتوبة بحالة أحرف مختلفة (حساس لحالة الأحرف)
 * - يتحقق من أن externalId اختياري، نصي غير فارغ بحد أقصى 100 محرف
 * - يتحقق من أن planId اختياري، نصي غير فارغ بحد أقصى 64 محرفاً
 */
export function validateCreateUserInput(body: unknown): CreateUserInput {
  if (body === undefined) {
    return {};
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new UserValidationError('Request body must be a valid JSON object');
  }

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);

  for (const key of keys) {
    if (!ALLOWED_CREATE_USER_FIELDS.has(key)) {
      throw new UserValidationError(`Unknown field: ${key}`);
    }
  }

  let externalId: string | undefined;

  if ('externalId' in record && record.externalId !== undefined) {
    if (typeof record.externalId !== 'string') {
      throw new UserValidationError('externalId must be a string');
    }
    const trimmed = record.externalId.trim();
    if (trimmed.length === 0) {
      throw new UserValidationError('externalId must not be empty');
    }
    if (trimmed.length > 100) {
      throw new UserValidationError('externalId must not exceed 100 characters');
    }
    externalId = trimmed;
  }

  let planId: string | undefined;
  if ('planId' in record && record.planId !== undefined) {
    if (typeof record.planId !== 'string') {
      throw new UserValidationError('planId must be a string');
    }
    const trimmed = record.planId.trim();
    if (trimmed.length === 0) {
      throw new UserValidationError('planId must not be empty');
    }
    if (trimmed.length > 64) {
      throw new UserValidationError('planId must not exceed 64 characters');
    }
    planId = trimmed;
  }

  return { externalId, planId };
}

/**
 * التحقق من صحة مدخلات تغيير خطة المستخدم:
 * - يتطلب كائناً غير فارغ يحتوي planId كنص غير فارغ بحد أقصى 64 محرفاً
 * - يرفض أي حقول إضافية غير planId أو مكتوبة بحالة أحرف مختلفة
 */
export function validateUpdateUserPlanInput(body: unknown): UpdateUserPlanInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new UserValidationError('Request body must be a valid JSON object');
  }

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);

  for (const key of keys) {
    if (!ALLOWED_UPDATE_USER_PLAN_FIELDS.has(key)) {
      throw new UserValidationError(`Unknown field: ${key}`);
    }
  }

  if (!('planId' in record) || record.planId === undefined) {
    throw new UserValidationError('planId is required');
  }

  if (typeof record.planId !== 'string') {
    throw new UserValidationError('planId must be a string');
  }

  const trimmed = record.planId.trim();
  if (trimmed.length === 0) {
    throw new UserValidationError('planId must not be empty');
  }
  if (trimmed.length > 64) {
    throw new UserValidationError('planId must not exceed 64 characters');
  }

  return { planId: trimmed };
}

/**
 * التحقق المشترك من صلاحية خطة المستخدم:
 * - التحقق من وجود الخطة وإتاحتها للحساب الموثق (خطة عامة أو خاصة بنفس الحساب)
 * - إعادة رسالة موحدة 400 للخطة المفقودة أو الخاصة بحساب آخر
 * - التحقق من أن نوع الخطة هو USER حصراً
 */
export async function validateAccessibleUserPlan(
  db: DbExecutor,
  planId: string,
  accountId: string
): Promise<void> {
  const plan = await getAccessiblePlan(db, planId, accountId);

  if (!plan) {
    throw new UserValidationError('Plan not found or not accessible');
  }

  if (plan.type !== 'USER') {
    throw new UserValidationError('Plan type must be USER');
  }
}

/**
 * إنشاء مستخدم جديد تحت الحساب الموثق:
 * - التحقق من إتاحة الخطة ونوعها
 * - توليد معرّف عشوائي مشفر
 * - حصر تحويل خطأ 23505 إلى UserConflictError بقيد uq_users_account_external حصراً
 */
export async function createUser(
  pool: pg.Pool,
  accountId: string,
  input: CreateUserInput
): Promise<User> {
  const planId = input.planId ?? DEFAULT_USER_PLAN_ID;
  await validateAccessibleUserPlan(pool, planId, accountId);

  const randomHex = crypto.randomBytes(12).toString('hex');
  const userId = `usr_${randomHex}`;

  try {
    const result = await pool.query<UserRow>(
      `INSERT INTO users (id, account_id, plan_id, external_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, account_id, plan_id, external_id, created_at`,
      [userId, accountId, planId, input.externalId ?? null]
    );

    const row = result.rows[0];
    return {
      id: row.id,
      accountId: row.account_id,
      planId: row.plan_id,
      externalId: row.external_id,
      createdAt: row.created_at.toISOString(),
    };
  } catch (err: unknown) {
    const pgError = err as { code?: string; constraint?: string };
    if (
      pgError &&
      pgError.code === '23505' &&
      pgError.constraint === 'uq_users_account_external'
    ) {
      throw new UserConflictError(
        'User with this externalId already exists for this account'
      );
    }
    throw err;
  }
}

/**
 * استرجاع مستخدم محدد بالمعرّف مع فرض شرط العزل بالحساب الموثق:
 * يعيد null إذا لم يكن المستخدم موجوداً أو كان يتبع لحساب آخر
 */
export async function getUserById(
  db: DbExecutor,
  userId: string,
  accountId: string
): Promise<User | null> {
  const result = await db.query<UserRow>(
    `SELECT id, account_id, plan_id, external_id, created_at
     FROM users
     WHERE id = $1 AND account_id = $2`,
    [userId, accountId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    accountId: row.account_id,
    planId: row.plan_id,
    externalId: row.external_id,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * تغيير خطة مستخدم:
 * - تنفيذ العملية داخل معاملة ذرية مع قفل الحساب عبر withAccountLock
 * - التحقق أولاً بعد نيل القفل من وجود المستخدم وانتمائه للحساب الموثق
 * - التحقق من إتاحة الخطة الجديدة وصحة نوعها USER على اتصال المعاملة
 * - تنفيذ UPDATE مقيداً بالمعرّف والحساب معاً على نفس اتصال المعاملة
 * - تعديل plan_id فقط دون تعديل أي استهلاك سابق
 */
export async function updateUserPlan(
  pool: pg.Pool,
  userId: string,
  accountId: string,
  newPlanId: string
): Promise<User> {
  return withAccountLock(pool, accountId, async (client) => {
    // 1. التحقق أولاً من وجود المستخدم ضمن الحساب الموثق بعد نيل القفل
    const existingUser = await getUserById(client, userId, accountId);
    if (!existingUser) {
      throw new UserNotFoundError('User not found');
    }

    // 2. التحقق من صلاحية ونوع الخطة الجديدة على اتصال المعاملة
    await validateAccessibleUserPlan(client, newPlanId, accountId);

    // 3. التحديث المباشر المقيد بمعرّف المستخدم والحساب
    const result = await client.query<UserRow>(
      `UPDATE users
       SET plan_id = $1
       WHERE id = $2 AND account_id = $3
       RETURNING id, account_id, plan_id, external_id, created_at`,
      [newPlanId, userId, accountId]
    );

    if (result.rowCount === 0) {
      throw new UserNotFoundError('User not found');
    }

    const row = result.rows[0];
    return {
      id: row.id,
      accountId: row.account_id,
      planId: row.plan_id,
      externalId: row.external_id,
      createdAt: row.created_at.toISOString(),
    };
  });
}

// src/accounts.ts
import crypto from 'node:crypto';
import type pg from 'pg';
import { withAccountLock } from './db.js';
import { AccountNotFoundError } from './errors.js';
import { getAccessiblePlan } from './plans.js';

export { AccountNotFoundError };

export interface CreateAccountInput {
  name: string;
  planId?: string;
}

export interface AccountCreatedResult {
  id: string;
  name: string;
  planId: string;
  apiKey: string;
  createdAt: string;
}

export class AccountValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountValidationError';
  }
}

/**
 * الخطة العامة الافتراضية للحسابات المسجلة حديثاً في حال عدم تحديد خطة
 */
export const DEFAULT_ACCOUNT_PLAN_ID = 'plan_default_account';

/**
 * حساب بصمة SHA-256 للمفتاح الكامل
 */
export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

/**
 * توليد مفتاح API تشفيري آمن عالي العشوائية وحساب بصمته
 * ملاحظة أمنية: يُحفظ في قاعدة البيانات بصمة SHA-256 للمفتاح فقط، ولا يُخزن المفتاح الخام أبداً
 */
export function generateApiKey(): { rawKey: string; hash: string } {
  const randomHex = crypto.randomBytes(32).toString('hex');
  const rawKey = `ffp_live_${randomHex}`;
  const hash = hashApiKey(rawKey);
  return { rawKey, hash };
}

/**
 * توليد معرّف فريد للحساب ببادئة قياسية
 */
export function generateAccountId(): string {
  const randomId = crypto.randomBytes(12).toString('hex');
  return `acc_${randomId}`;
}

/**
 * التحقق الصارم من صحة مدخلات إنشاء الحساب أثناء التشغيل
 */
export function validateCreateAccountInput(input: unknown): CreateAccountInput {
  if (typeof input !== 'object' || input === null) {
    throw new AccountValidationError('Request body must be a JSON object');
  }

  const rawInput = input as Record<string, unknown>;

  // التحقق من اسم الحساب: نص، غير فارغ بعد trim، وألا يتجاوز 100 محرف
  if (typeof rawInput.name !== 'string') {
    throw new AccountValidationError('Account name must be a string');
  }

  const trimmedName = rawInput.name.trim();
  if (trimmedName.length === 0) {
    throw new AccountValidationError('Account name must not be empty');
  }

  if (trimmedName.length > 100) {
    throw new AccountValidationError('Account name must not exceed 100 characters');
  }

  // التحقق من معرف الخطة (في حال تم تمريره)
  let trimmedPlanId: string | undefined = undefined;
  if (rawInput.planId !== undefined) {
    if (typeof rawInput.planId !== 'string') {
      throw new AccountValidationError('Plan ID must be a string');
    }

    trimmedPlanId = rawInput.planId.trim();
    if (trimmedPlanId.length === 0) {
      throw new AccountValidationError('Plan ID must not be empty if provided');
    }

    if (trimmedPlanId.length > 64) {
      throw new AccountValidationError('Plan ID must not exceed 64 characters');
    }
  }

  return {
    name: trimmedName,
    planId: trimmedPlanId,
  };
}

/**
 * إنشاء حساب جديد وحفظه في قاعدة البيانات وإصدار المفتاح لمرة واحدة فقط
 * 
 * ملاحظة معمارية:
 * إعادة إرسال نفس الطلب ستنشئ حساباً جديداً بمفتاح جديد؛ نظام منع التكرار (Idempotency)
 * غير مطلوب لإنشاء الحسابات في هذه المرحلة، ومخصص لطلبات الاستهلاك اللاحقة.
 */
export async function createAccount(
  pool: pg.Pool,
  validatedInput: CreateAccountInput
): Promise<AccountCreatedResult> {
  const targetPlanId = validatedInput.planId ?? DEFAULT_ACCOUNT_PLAN_ID;

  // 1. التحقق من وجود الخطة ونوعها وملكيتها العامة
  const planRes = await pool.query<{ id: string; type: string; owner_account_id: string | null }>(
    'SELECT id, type, owner_account_id FROM plans WHERE id = $1',
    [targetPlanId]
  );

  if (planRes.rows.length === 0) {
    throw new AccountValidationError(`Plan '${targetPlanId}' does not exist`);
  }

  const plan = planRes.rows[0];

  // يجب أن تكون الخطة المسندة للحساب من نوع ACCOUNT حصراً
  if (plan.type !== 'ACCOUNT') {
    throw new AccountValidationError(`Plan '${targetPlanId}' is a ${plan.type} plan, not an ACCOUNT plan`);
  }

  // لا يجوز للحساب الجديد استخدام خطة مخصصة مملوكة لحساب آخر
  if (plan.owner_account_id !== null) {
    throw new AccountValidationError(`Cannot assign custom plan '${targetPlanId}' owned by another account`);
  }

  // 2. توليد المعرف والمفتاح والبصمة
  const accountId = generateAccountId();
  const { rawKey, hash } = generateApiKey();

  // 3. حفظ الحساب في قاعدة البيانات
  const insertRes = await pool.query<{
    id: string;
    name: string;
    plan_id: string;
    created_at: Date;
  }>(
    `INSERT INTO accounts (id, name, api_key_hash, plan_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, plan_id, created_at`,
    [accountId, validatedInput.name, hash, targetPlanId]
  );

  const row = insertRes.rows[0];

  return {
    id: row.id,
    name: row.name,
    planId: row.plan_id,
    apiKey: rawKey,
    createdAt: row.created_at.toISOString(),
  };
}

export interface UpdateAccountPlanInput {
  planId: string;
}

export interface AccountProfile {
  id: string;
  name: string;
  planId: string;
  createdAt: string;
}

const ALLOWED_UPDATE_ACCOUNT_PLAN_FIELDS = new Set(['planId']);

/**
 * التحقق الصارم من مدخلات تحديث خطة الحساب:
 * - يتطلب كائناً غير فارغ يحتوي planId كنص غير فارغ بحد أقصى 64 محرفاً
 * - يرفض أي حقول إضافية غير planId
 * - يرفض null صراحة
 */
export function validateUpdateAccountPlanInput(body: unknown): UpdateAccountPlanInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AccountValidationError('Request body must be a valid JSON object');
  }

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);

  if (keys.length === 0) {
    throw new AccountValidationError('At least one field must be provided for update');
  }

  for (const key of keys) {
    if (!ALLOWED_UPDATE_ACCOUNT_PLAN_FIELDS.has(key)) {
      throw new AccountValidationError(`Unknown field: ${key}`);
    }
  }

  if (!('planId' in record) || record.planId === undefined) {
    throw new AccountValidationError('planId is required');
  }

  if (record.planId === null) {
    throw new AccountValidationError('planId must not be null');
  }

  if (typeof record.planId !== 'string') {
    throw new AccountValidationError('planId must be a string');
  }

  const trimmed = record.planId.trim();
  if (trimmed.length === 0) {
    throw new AccountValidationError('planId must not be empty');
  }

  if (trimmed.length > 64) {
    throw new AccountValidationError('planId must not exceed 64 characters');
  }

  return { planId: trimmed };
}

/**
 * تحديث خطة الحساب الموثق:
 * - التحقق من إتاحة الخطة المستهدفة للحساب الموثق عبر getAccessiblePlan
 * - توحيد رسالة الخطأ للخطة غير الموجودة أو المملوكة لحساب آخر
 * - التحقق من أن نوع الخطة هو ACCOUNT حصراً
 * - تنفيذ UPDATE ذري مشروط بمعرّف الحساب الموثق حصراً
 * - فحص وجود الصف المتأثر لتجنب الانهيار عند قراءة صف غير موجود
 */
export async function updateAccountPlan(
  pool: pg.Pool,
  accountId: string,
  newPlanId: string
): Promise<AccountProfile> {
  return withAccountLock(pool, accountId, async (client) => {
    // 1. التحقق من إتاحة الخطة للحساب الموثق (خطة عامة أو خاصة بنفس الحساب) باستخدام اتصال المعاملة
    const plan = await getAccessiblePlan(client, newPlanId, accountId);
    if (!plan) {
      throw new AccountValidationError('Plan not found or not accessible');
    }

    // 2. التحقق من أن نوع الخطة هو ACCOUNT
    if (plan.type !== 'ACCOUNT') {
      throw new AccountValidationError(
        `Plan '${newPlanId}' is a ${plan.type} plan, not an ACCOUNT plan`
      );
    }

    // 3. التحديث الذري لحساب المالك على نفس اتصال المعاملة
    const result = await client.query<{
      id: string;
      name: string;
      plan_id: string;
      created_at: Date;
    }>(
      `UPDATE accounts
       SET plan_id = $1
       WHERE id = $2
       RETURNING id, name, plan_id, created_at`,
      [newPlanId, accountId]
    );

    // 4. فحص عدد الصفوف للتأكد من وجود الحساب وعدم الانهيار
    if (result.rows.length === 0) {
      throw new AccountNotFoundError('Account not found');
    }

    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      planId: row.plan_id,
      createdAt: row.created_at.toISOString(),
    };
  });
}


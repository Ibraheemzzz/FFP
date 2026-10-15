// src/accounts.ts
import crypto from 'node:crypto';
import type pg from 'pg';

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

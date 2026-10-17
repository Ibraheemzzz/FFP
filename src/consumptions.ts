// src/consumptions.ts
// منطق التحقق ومعالجة طلبات الاستهلاك (Consumption Handling & Validation)

import type { ConsumptionRequest } from './types.js';

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

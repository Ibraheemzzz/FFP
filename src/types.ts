// src/types.ts
// الأنواع الأساسية لنطاق قياس الاستخدام والحصص (Domain Types)

/**
 * البيانات التي يرسلها العميل لطلب استهلاك وحدات
 */
export interface ConsumptionRequest {
  userId: string;
  units: number;
  requestId: string;
}

/**
 * لقطة تمثل الاستهلاك والمتبقي لطرف معين (حساب أو مستخدم)
 */
export interface UsageSnapshot {
  consumed: number;
  remaining: number;
}

/**
 * صاحب الحد أو الحصة التي منعت الطلب
 */
export type RejectionScope = 'account' | 'user';

/**
 * نوع القاعدة التي تسببت في الرفض
 */
export type RejectionRule = 'monthly_allowance' | 'max_per_request';

/**
 * سبب الرفض المفصل
 */
export interface RejectionReason {
  scope: RejectionScope;
  rule: RejectionRule;
}

/**
 * تفاصيل القرار في حالة القبول
 */
export interface AcceptedDecision {
  accepted: true;
  requestId: string;
  account: UsageSnapshot;
  user: UsageSnapshot;
}

/**
 * تفاصيل القرار في حالة الرفض
 */
export interface RejectedDecision {
  accepted: false;
  requestId: string;
  reason: RejectionReason;
  account: UsageSnapshot;
  user: UsageSnapshot;
}

/**
 * نوع القرار النهائي (Discriminated Union):
 * إما قرار مقبول يحمل الأرصدة، أو قرار مرفوض يحمل سبب الرفض مع الأرصدة القائمة
 */
export type ConsumptionDecision = AcceptedDecision | RejectedDecision;

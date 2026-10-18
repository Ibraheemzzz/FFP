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

/**
 * ملخص خطة الاستخدام المعروضة في ردود الاستخدام الحالي
 */
export interface UsagePlanSummary {
  id: string;
  name: string;
  type: 'ACCOUNT' | 'USER';
  monthlyLimit: number;
  perRequestLimit: number;
}

/**
 * رد استخدام الحساب الحالي (GET /account/usage)
 */
export interface AccountUsageResponse {
  accountId: string;
  yearMonth: string;
  plan: UsagePlanSummary;
  usage: UsageSnapshot;
}

/**
 * رد استخدام المستخدم وحصته المشتركة مع حسابه (GET /users/:userId/usage)
 */
export interface UserUsageResponse {
  userId: string;
  accountId: string;
  yearMonth: string;
  userPlan: UsagePlanSummary;
  userUsage: UsageSnapshot;
  accountPlan: UsagePlanSummary;
  accountUsage: UsageSnapshot;
}

/**
 * ملخص خطة الاستخدام التاريخية المستخرجة من سياق آخر طلب مسجل
 */
export interface HistoricalPlanSummary {
  id: string;
  monthlyLimit: number;
  perRequestLimit: number;
}

/**
 * رد استخدام الحساب لشهر سابق (GET /account/usage?month=YYYY-MM)
 */
export interface HistoricalAccountUsageResponse {
  accountId: string;
  yearMonth: string;
  isCurrentMonth: false;
  consumed: number;
  planAtLastRequest: HistoricalPlanSummary | null;
  lastRequestAt: string | null;
}

/**
 * رد استخدام المستخدم لشهر سابق (GET /users/:userId/usage?month=YYYY-MM)
 */
export interface HistoricalUserUsageResponse {
  userId: string;
  accountId: string;
  yearMonth: string;
  isCurrentMonth: false;
  userConsumed: number;
  accountConsumed: number;
  userPlanAtLastRequest: HistoricalPlanSummary | null;
  accountPlanAtLastRequest: HistoricalPlanSummary | null;
  lastRequestAt: string | null;
}

/**
 * عنصر سجل طلب استهلاك مسجل
 */
export interface RequestHistoryItem {
  id: string;
  requestId: string;
  userId: string;
  requestedUnits: number;
  status: 'ACCEPTED' | 'REJECTED';
  rejectionReason: RejectionReason | null;
  responseBody: ConsumptionDecision;
  processedAt: string;
}

/**
 * بيانات تقسيم الصفحات في سجل الطلبات
 */
export interface RequestHistoryPagination {
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * رد استعلام سجل الطلبات (GET /requests)
 */
export interface RequestHistoryResponse {
  items: RequestHistoryItem[];
  pagination: RequestHistoryPagination;
}

/**
 * معلمات تصفية وتقسيم سجل الطلبات بعد التحقق منها
 */
export interface RequestHistoryFilter {
  limit: number;
  offset: number;
  userId?: string;
  status?: 'ACCEPTED' | 'REJECTED';
  month?: string;
}


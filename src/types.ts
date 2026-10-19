// src/types.ts
// Core domain types for the Usage Metering and Quotas Service

/**
 * Payload sent by clients to request quota consumption
 */
export interface ConsumptionRequest {
  userId: string;
  units: number;
  requestId: string;
}

/**
 * Snapshot representing consumed and remaining units for an entity (account or user)
 */
export interface UsageSnapshot {
  consumed: number;
  remaining: number;
}

/**
 * Quota boundary owner that prevented the request
 */
export type RejectionScope = 'account' | 'user';

/**
 * Type of quota rule that caused rejection
 */
export type RejectionRule = 'monthly_allowance' | 'max_per_request';

/**
 * Detailed rejection reason descriptor
 */
export interface RejectionReason {
  scope: RejectionScope;
  rule: RejectionRule;
}

/**
 * Decision details for accepted consumption requests
 */
export interface AcceptedDecision {
  accepted: true;
  requestId: string;
  account: UsageSnapshot;
  user: UsageSnapshot;
}

/**
 * Decision details for rejected consumption requests
 */
export interface RejectedDecision {
  accepted: false;
  requestId: string;
  reason: RejectionReason;
  account: UsageSnapshot;
  user: UsageSnapshot;
}

/**
 * Final consumption decision (Discriminated Union):
 * Either an accepted decision with updated balances, or a rejected decision with reason and intact balances.
 */
export type ConsumptionDecision = AcceptedDecision | RejectedDecision;

/**
 * Summary of usage plan returned in current usage responses
 */
export interface UsagePlanSummary {
  id: string;
  name: string;
  type: 'ACCOUNT' | 'USER';
  monthlyLimit: number;
  perRequestLimit: number;
}

/**
 * Response for current account usage (GET /account/usage)
 */
export interface AccountUsageResponse {
  accountId: string;
  yearMonth: string;
  plan: UsagePlanSummary;
  usage: UsageSnapshot;
}

/**
 * Response for user usage and shared account quota (GET /users/:userId/usage)
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
 * Historical plan summary extracted from decision context of last logged request
 */
export interface HistoricalPlanSummary {
  id: string;
  monthlyLimit: number;
  perRequestLimit: number;
}

/**
 * Response for historical account usage (GET /account/usage?month=YYYY-MM)
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
 * Response for historical user usage (GET /users/:userId/usage?month=YYYY-MM)
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
 * Recorded request history item
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
 * Pagination metadata in request history responses
 */
export interface RequestHistoryPagination {
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Response for request history queries (GET /requests)
 */
export interface RequestHistoryResponse {
  items: RequestHistoryItem[];
  pagination: RequestHistoryPagination;
}

/**
 * Validated filter and pagination parameters for request history queries
 */
export interface RequestHistoryFilter {
  limit: number;
  offset: number;
  userId?: string;
  status?: 'ACCEPTED' | 'REJECTED';
  month?: string;
}

// demo-client/src/client.ts
// Standalone HTTP client for interacting with the Usage Metering and Quotas Service via REST API

export interface HttpResponse<T> {
  status: number;
  ok: boolean;
  requestId: string | null;
  data: T;
}

export interface AccountCreated {
  id: string;
  name: string;
  planId: string;
  apiKey: string;
  createdAt: string;
}

export interface AccountProfile {
  id: string;
  name: string;
  planId: string;
  createdAt: string;
}

export interface Plan {
  id: string;
  name: string;
  type: 'ACCOUNT' | 'USER';
  monthlyLimit: number;
  perRequestLimit: number;
  ownerAccountId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  accountId: string;
  planId: string;
  createdAt: string;
}

export interface ConsumptionDecisionAccepted {
  accepted: true;
  requestId: string;
  account: {
    consumed: number;
    remaining: number;
  };
  user: {
    consumed: number;
    remaining: number;
  };
}

export interface ConsumptionDecisionRejected {
  accepted: false;
  requestId: string;
  reason: {
    scope: 'user' | 'account';
    rule: string;
  };
  account: {
    consumed: number;
    remaining: number;
  };
  user: {
    consumed: number;
    remaining: number;
  };
}

export type ConsumptionDecision =
  | ConsumptionDecisionAccepted
  | ConsumptionDecisionRejected;

export interface RequestHistoryItem {
  id: string;
  requestId: string;
  userId: string;
  requestedUnits: number;
  status: 'ACCEPTED' | 'REJECTED';
  rejectionReason: { scope: string; rule: string } | null;
  responseBody: ConsumptionDecision;
  processedAt: string;
}

export interface RequestHistoryResponse {
  items: RequestHistoryItem[];
  pagination: {
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

/**
 * Usage Metering Service HTTP Client (MeteringHttpClient):
 * Communicates with the service exclusively over standard HTTP using native fetch.
 */
export class MeteringHttpClient {
  private baseUrl: string;
  private apiKey: string | null = null;

  constructor(baseUrl: string = 'http://127.0.0.1:3000') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * Set API key for Bearer Authorization header
   */
  public setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  /**
   * Get currently active API key
   */
  public getApiKey(): string | null {
    return this.apiKey;
  }

  /**
   * Helper method to execute standard HTTP requests
   */
  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    queryParams?: Record<string, string | number | undefined>
  ): Promise<HttpResponse<T>> {
    let url = `${this.baseUrl}${endpoint}`;

    if (queryParams) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined) {
          searchParams.append(key, String(value));
        }
      }
      const queryString = searchParams.toString();
      if (queryString.length > 0) {
        url += `?${queryString}`;
      }
    }

    const headers: Record<string, string> = {};

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const requestId = res.headers.get('x-request-id');
    const text = await res.text();
    let data: T;

    try {
      data = (text.length > 0 ? JSON.parse(text) : {}) as T;
    } catch {
      data = text as unknown as T;
    }

    return {
      status: res.status,
      ok: res.ok,
      requestId,
      data,
    };
  }

  // ==========================================
  // Accounts API
  // ==========================================

  /**
   * Register a new account and receive an API key
   */
  public async createAccount(
    name: string,
    planId?: string
  ): Promise<HttpResponse<AccountCreated>> {
    return this.request<AccountCreated>('POST', '/accounts', {
      name,
      planId,
    });
  }

  /**
   * Retrieve profile of the authenticated account
   */
  public async getAccountProfile(): Promise<HttpResponse<AccountProfile>> {
    return this.request<AccountProfile>('GET', '/account/me');
  }

  /**
   * Update plan of the authenticated account
   */
  public async updateAccountPlan(
    planId: string
  ): Promise<HttpResponse<AccountProfile>> {
    return this.request<AccountProfile>('PATCH', '/account/plan', { planId });
  }

  // ==========================================
  // Plans API
  // ==========================================

  /**
   * Create a custom plan owned by the authenticated account
   */
  public async createCustomPlan(input: {
    name: string;
    type: 'ACCOUNT' | 'USER';
    monthlyLimit: number;
    perRequestLimit: number;
  }): Promise<HttpResponse<Plan>> {
    return this.request<Plan>('POST', '/plans', input);
  }

  /**
   * Update an existing custom plan owned by the account
   */
  public async updateCustomPlan(
    planId: string,
    input: {
      name?: string;
      monthlyLimit?: number;
      perRequestLimit?: number;
    }
  ): Promise<HttpResponse<Plan>> {
    return this.request<Plan>('PATCH', `/plans/${planId}`, input);
  }

  /**
   * Retrieve plan details by ID
   */
  public async getPlan(planId: string): Promise<HttpResponse<Plan>> {
    return this.request<Plan>('GET', `/plans/${planId}`);
  }

  /**
   * List accessible plans for the account
   */
  public async listPlans(
    type?: 'ACCOUNT' | 'USER'
  ): Promise<HttpResponse<Plan[]>> {
    return this.request<Plan[]>('GET', '/plans', undefined, { type });
  }

  // ==========================================
  // Users API
  // ==========================================

  /**
   * Create a user under the authenticated account and assign a plan
   */
  public async createUser(planId?: string): Promise<HttpResponse<User>> {
    return this.request<User>('POST', '/users', planId ? { planId } : {});
  }

  /**
   * Retrieve user details by ID
   */
  public async getUser(userId: string): Promise<HttpResponse<User>> {
    return this.request<User>('GET', `/users/${userId}`);
  }

  /**
   * Update plan assignment for a user
   */
  public async updateUserPlan(
    userId: string,
    planId: string
  ): Promise<HttpResponse<User>> {
    return this.request<User>('PATCH', `/users/${userId}/plan`, { planId });
  }

  // ==========================================
  // Consumptions API
  // ==========================================

  /**
   * Execute consumption deduction request and verify quotas
   */
  public async executeConsumption(input: {
    userId: string;
    units: number;
    requestId: string;
  }): Promise<HttpResponse<ConsumptionDecision>> {
    return this.request<ConsumptionDecision>('POST', '/consumptions', input);
  }

  // ==========================================
  // Usage & Quota API
  // ==========================================

  /**
   * Retrieve account usage balances (current or specific month)
   */
  public async getAccountUsage(
    month?: string
  ): Promise<HttpResponse<Record<string, unknown>>> {
    return this.request<Record<string, unknown>>(
      'GET',
      '/account/usage',
      undefined,
      month ? { month } : undefined
    );
  }

  /**
   * Retrieve user usage balances (current or specific month)
   */
  public async getUserUsage(
    userId: string,
    month?: string
  ): Promise<HttpResponse<Record<string, unknown>>> {
    return this.request<Record<string, unknown>>(
      'GET',
      `/users/${userId}/usage`,
      undefined,
      month ? { month } : undefined
    );
  }

  // ==========================================
  // Request History API
  // ==========================================

  /**
   * Retrieve paginated request history and audit decisions
   */
  public async getRequestHistory(filter?: {
    limit?: number;
    offset?: number;
    userId?: string;
    status?: 'ACCEPTED' | 'REJECTED';
    month?: string;
  }): Promise<HttpResponse<RequestHistoryResponse>> {
    return this.request<RequestHistoryResponse>(
      'GET',
      '/requests',
      undefined,
      filter
    );
  }
}

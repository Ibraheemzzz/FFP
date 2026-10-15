# API Contracts Documentation — Part 1

> **Document Status:** Initial draft defining HTTP message schemas, consumption contracts, and health checks.  
> **Notice:** This document focuses strictly on specifying message formats and understanding HTTP semantics. It does not yet cover the implementation of deduction logic, key authentication, or database connectivity.

---

## 1. Liveness Probe Endpoint: `GET /health`

### Objective
Verify that the service process is running and responding to network requests (Liveness). This endpoint **does not prove** database readiness or complete environment initialization; it solely proves the server's HTTP protocol responsiveness.

### Request Details
- **Method:** `GET`
- **Path:** `/health`
- **Headers:** No special headers required at this stage.

### Response Details
- **Status Code:** `200 OK`
- **Headers:** `Content-Type: application/json; charset=utf-8`
- **Body:**
```json
{
  "status": "ok"
}
```
*(Note: Adding a `timestamp` field is optional and not mandatory).*

---

## 2. Proposed Primary Consumption Endpoint: `POST /consumptions`

### 2.1 Request Payload

```json
{
  "userId": "usr_abc123",
  "units": 2,
  "requestId": "req_20261012_001"
}
```

#### Field Details
| Field | Type | Requirement | Description and Semantics |
|---|---|---|---|
| `userId` | `string` | **[Required]** | Identifier of the user belonging to the account from whom units should be deducted. |
| `units` | `integer` | **[Required]** | Number of units to consume (positive integer > 0). |
| `requestId` | `string` | **[Required]** | Operation identifier for idempotency (deduplication). **[Proposed Decision]** Unique within the account scope rather than globally; reusing it is valid and expected when retrying the same request. |

---

### 2.2 Proposed Response Payloads

#### A. Accepted Case (`accepted: true`)
When all applied rules permit consumption (account per-request limit, user per-request limit, account monthly allowance, user monthly allowance):

- **Status Code:** `200 OK`
- **Headers:** `Content-Type: application/json; charset=utf-8`
- **Body:**
```json
{
  "accepted": true,
  "requestId": "req_20261012_001",
  "account": {
    "consumed": 62,
    "remaining": 38
  },
  "user": {
    "consumed": 12,
    "remaining": 18
  }
}
```

#### B. Rejected Case Due to Insufficient Balance or Exceeded Limit (`accepted: false`)
When the request violates one of the rules (such as exceeding the monthly quota):

- **Proposed Status Code:** `200 OK`  
  *(Rationale: This is a design choice rather than an imposed constraint; the server successfully received the request, executed its business logic, and returned a valid decision indicating that the balance does not permit consumption. Rejection here is a business decision, not a server failure).*
- **Headers:** `Content-Type: application/json; charset=utf-8`
- **Body:**
```json
{
  "accepted": false,
  "requestId": "req_20261012_001",
  "reason": {
    "scope": "account",
    "rule": "monthly_allowance"
  },
  "account": {
    "consumed": 99,
    "remaining": 1
  },
  "user": {
    "consumed": 5,
    "remaining": 15
  }
}
```

---

### 2.3 Core Notes on Metrics and Response Statuses
1. **Accepted Metrics:** The metrics returned in the acceptance response (`consumed`, `remaining`) represent the balance state **after** recording the accepted consumption.
2. **Rejected Metrics:** Rejection due to quota rules does not modify any consumption whatsoever, and the numbers reflect the existing state without deductions.
3. **Handling Responses and Status Codes:**
   - `HTTP 200 + accepted: true`: Request processed and an acceptance decision was issued.
   - `HTTP 200 + accepted: false`: Request processed and a rejection decision was issued due to quota limits (the client must inspect the `accepted` field).
   - `400 / 401 / 409`: Completed HTTP responses from the service indicating an issue with the request (invalid input, missing authentication, conflict on identifier).

| Case | Precise Description | What Was Received by Client |
|---|---|---|
| `200 OK (accepted: true)` | Successful processing and accepted consumption | Completed HTTP response from the service |
| `200 OK (accepted: false)` | Successful processing and rejection due to quota | Completed HTTP response from the service |
| `400 / 401 / 409 / 500` | Input, authentication, or server errors | Completed HTTP response from the service |
| **Timeout / Connection Drop** | Client/proxy timeout or network disconnection | **Client did not receive a completed response from the service** |

---

## 3. Account Registration Endpoint: `POST /accounts` (Part 7)

### 3.1 Objective
Register a new primary customer account (`Account`) within the system, assign a valid public plan of type `ACCOUNT` to it, and generate a cryptographically secure, high-entropy API key returned to the client once upon creation.

### 3.2 Request Details (Request Payload)
- **Method:** `POST`
- **Path:** `/accounts`
- **Headers:** `Content-Type: application/json`
- **Body:**
```json
{
  "name": "Acme Corporation",
  "planId": "plan_default_account"
}
```

#### Field Details and Runtime Validation Rules:
| Field | Type | Requirement | Description and Constraints |
|---|---|---|---|
| `name` | `string` | **[Required]** | Account or organization name, non-empty after applying `trim()`, with a maximum length of 100 characters. |
| `planId` | `string` | **[Optional]** | Identifier of the plan to assign to the account (max 64 characters). If omitted, the system assigns the default plan `plan_default_account`. The plan must exist, must be of type `ACCOUNT` exclusively, and must be public (not owned by another account). |

---

### 3.3 Successful Response Details (Response Payload)
- **Status Code:** `201 Created`
- **Headers:** `Content-Type: application/json; charset=utf-8`
- **Body:**
```json
{
  "id": "acc_0123456789abcdef01234567",
  "name": "Acme Corporation",
  "planId": "plan_default_account",
  "apiKey": "ffp_live_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "createdAt": "2026-10-14T06:30:00.000Z"
}
```

---

### 3.4 API Key Confidentiality and Security Policy
1. **One-Time Issuance:** The raw API key is returned in plaintext (`ffp_live_...`) in the creation response (`HTTP 201 Created`) only once. It can never be retrieved or re-read from the server.
2. **Cryptographic Hash Storage:** The database strictly stores the `SHA-256` cryptographic digest of the complete key (`api_key_hash` as `CHAR(64)`).
3. **No Logging or Output:** Printing the raw API key in server logs, error messages, or terminal outputs is strictly prohibited.

---

### 3.5 Re-submission Behavior (Absence of Idempotency)
- **No Idempotency:** If the client re-submits the exact same request (even with the identical `name`), the server will create a **brand-new, distinct account** with an independent `id`, a new key hash, and an independent API key.
- Idempotency was deliberately omitted from this endpoint; idempotency guarantees are reserved exclusively for critical consumption and deduction operations (`POST /consumptions`).

---

### 3.6 Validation and Request Errors (`400 Bad Request`)
The server returns `400 Bad Request` in cases such as:
- The `name` field is missing, empty, contains only whitespace, or exceeds 100 characters.
- An empty `planId` is provided, or exceeds 64 characters.
- A non-existent plan, a `USER`-type plan, or a custom plan owned by another account (`owner_account_id IS NOT NULL`) is requested.

**Error Response Format:**
```json
{
  "error": "Account name must not be empty"
}
```

---

## 4. API Key Authentication & Account Profile: `GET /account/me` (Part 8)

### 4.1 Authentication Specification
Protected endpoints require API key authentication using the standard HTTP `Authorization` header:

- **Header Name:** `Authorization`
- **Scheme:** `Bearer` (case-insensitive scheme name comparison: `Bearer`, `bearer`, or `BEARER`). The token value itself is preserved exactly as-is without any case conversion.
- **Format:** `Authorization: Bearer <api_key>`
- **Token Format:** `ffp_live_<64 hex characters>` (73 characters total, matching `^ffp_live_[0-9a-fA-F]{64}$`).

#### Authentication Lifecycle and Fail-Fast Pipeline:
1. **Header Extraction:** Extracts the token strictly from `Authorization: Bearer <key>`. Non-Bearer schemes or empty tokens are rejected immediately.
2. **Format Validation (Fail-Fast):** Validates the token against `^ffp_live_[0-9a-fA-F]{64}$` before querying the database, conserving database resources.
3. **Cryptographic Lookup:** Computes the `SHA-256` hash of the raw token and queries `accounts.api_key_hash`.
4. **Pipeline Halting:** If authentication fails at any step, request processing immediately halts, returning `401 Unauthorized` before executing the route handler.
5. **Unified Error Response & Challenge Header:** Any client-side authentication failure (missing header, unsupported scheme, malformed token, or non-existent key) returns the exact same unified error along with the standard `WWW-Authenticate: Bearer` header:
   - **Status Code:** `401 Unauthorized`
   - **Headers:** `WWW-Authenticate: Bearer`
   - **Body:**
   ```json
   {
     "error": "Invalid or missing API key"
   }
   ```
6. **Internal Error Isolation:** Infrastructure issues (such as missing pool configuration or database connection/query failures) return a generic `500 Internal Server Error` (`{ "error": "Internal Server Error" }` or `{ "error": "Database pool is not configured" }`) without leaking internal connection or database details, and are never converted into 401. Request processing halts before reaching the route handler.

---

### 4.2 Endpoint Details: `GET /account/me`

#### Objective
Retrieve the profile of the currently authenticated account. Verifies caller identity without exposing any sensitive credentials.

#### Request Details
- **Method:** `GET`
- **Path:** `/account/me`
- **Headers:** `Authorization: Bearer <api_key>`

#### Response Details
- **Status Code:** `200 OK`
- **Headers:** `Content-Type: application/json; charset=utf-8`
- **Body:**
```json
{
  "id": "acc_0123456789abcdef01234567",
  "name": "Acme Corporation",
  "planId": "plan_default_account",
  "createdAt": "2026-10-14T06:30:00.000Z"
}
```

#### Confidentiality Guarantee:
The profile response strictly returns account identity and plan metadata. The raw API key (`apiKey`) and the hash (`api_key_hash`) are never returned or logged.

---

### 4.3 Public Endpoints Status
The following endpoints remain completely public and do not require an `Authorization` header:
- `GET /health` (Liveness probe)
- `GET /health/ready` (Readiness probe)
- `POST /accounts` (Account initial registration)

---

## 5. Plan Retrieval & Multi-Tenant Isolation: `GET /plans/:planId` (Part 9)

### 5.1 Objective & Isolation Principles
Provide secure retrieval of plan details accessible to the calling account, enforcing multi-tenant data isolation:

1. **Sole Source of Identity:** In protected routes, `request.account.id` derived from the cryptographically verified API key is the only identity source. Any `accountId` passed in query parameters, request bodies, or custom headers is strictly ignored.
2. **Query-Level Enforcement:** Tenant boundaries are enforced directly inside the database query rather than through application-level checks after reading data:
   ```sql
   SELECT id, name, type, monthly_limit, per_request_limit, owner_account_id, created_at, updated_at
   FROM plans
   WHERE id = $1 AND (owner_account_id = $2 OR owner_account_id IS NULL)
   ```
3. **Privilege Separation:**
   - **Read & Assign:** Accessible if the plan is public (`owner_account_id IS NULL`) or owned by the calling account (`owner_account_id = accountId`). Plan type (`ACCOUNT` vs `USER`) is validated upon assignment.
   - **Modification:** Strictly restricted to private custom plans owned by the calling account (`owner_account_id = accountId`).
4. **Unified 404 Response:** If a plan does not exist or belongs to another tenant, the endpoint returns `404 Not Found` with `{ "error": "Plan not found" }`. This prevents tenant resource enumeration (information disclosure).

---

### 5.2 Endpoint Details: `GET /plans/:planId`

#### Request Details
- **Method:** `GET`
- **Path:** `/plans/:planId`
- **Headers:** `Authorization: Bearer <api_key>`

#### Response Details (200 OK)
Returned when the requested plan is public or owned by the calling account:
- **Status Code:** `200 OK`
- **Headers:** `Content-Type: application/json; charset=utf-8`
- **Body:**
```json
{
  "id": "plan_custom_corp",
  "name": "Custom Corporate Plan",
  "type": "ACCOUNT",
  "monthlyLimit": 50000,
  "perRequestLimit": 500,
  "ownerAccountId": "acc_0123456789abcdef01234567",
  "createdAt": "2026-10-14T06:30:00.000Z",
  "updatedAt": "2026-10-14T06:30:00.000Z"
}
```

#### Response Details (404 Not Found)
Returned when the plan does not exist, or is a private plan owned by another account:
- **Status Code:** `404 Not Found`
- **Headers:** `Content-Type: application/json; charset=utf-8`
- **Body:**
```json
{
  "error": "Plan not found"
}
```

#### Error Handling:
- Missing/invalid authentication returns `401 Unauthorized` with `WWW-Authenticate: Bearer`.
- Unhandled database or infrastructure failures return a safe `500 Internal Server Error` (`{ "error": "Internal Server Error" }`) without leaking database or connection details.

---

## 6. User Management Endpoints (Part 10)

### 6.1 Architectural Principles and Tenant Isolation
1. **Authenticated Scope:** All user endpoints are protected by `Authorization: Bearer <api_key>`. The tenant identifier is strictly derived from `request.account.id`.
2. **Internal ID vs External ID:**
   - **Internal Identifier (`id`):** Cryptographically random hex string prefixed with `usr_` (e.g., `usr_9f8e7d6c5b4a321012345678`), primary key in `users`.
   - **External Identifier (`externalId`):** Optional identifier provided by the client application (max 100 characters). Uniqueness is strictly scoped per account (`uq_users_account_external`). Distinct accounts may safely use the identical `externalId`.
3. **Plan Assignment & Type Validation:**
   - User plans must be accessible (public or owned by the tenant). Inaccessible or non-existent plans return a unified `400 Bad Request` (`Plan not found or not accessible`).
   - The plan type must strictly be `USER`. Assigning an `ACCOUNT` plan returns `400 Bad Request` (`Plan type must be USER`).
4. **Isolated Mutations & Query Scoping:**
   - All retrieval and update queries require `WHERE id = $1 AND account_id = $2`.
   - Modifying a user's plan updates `users.plan_id` only, without modifying past consumption records. Full concurrency synchronization between plan changes and consumption will be enforced via locking protocols in subsequent parts.
5. **Strict Field Validation Policy (Unknown Field Rejection):**
   - Property names are strictly case-sensitive and verified against explicitly allowed field sets using runtime key inspection (`Object.keys`).
   - Any unknown, unrecognized, or case-mismatched properties (e.g., `externalID`, `PlanId`, or extraneous attributes) are rejected with `400 Bad Request` and a descriptive error (`Unknown field: <fieldName>`).
   - For `POST /users`, the only allowed properties are `externalId` and `planId`.
   - For `PATCH /users/:userId/plan`, the only allowed property is `planId` (which is required).

---

### 6.2 Create User: `POST /users`

#### Request Details
- **Method:** `POST`
- **Path:** `/users`
- **Headers:**
  - `Authorization: Bearer <api_key>`
  - `Content-Type: application/json`
- **Body:**
```json
{
  "externalId": "emp_101",
  "planId": "plan_default_user"
}
```
*Note: Both fields are optional. An empty JSON object `{}` or omitting fields defaults `planId` to `plan_default_user` and `externalId` to `null`. A non-object body (`null`, arrays, primitives) is rejected with `400 Bad Request`.*

#### Successful Response (`201 Created`)
- **Status Code:** `201 Created`
- **Headers:** `Content-Type: application/json; charset=utf-8`
- **Body:**
```json
{
  "id": "usr_9f8e7d6c5b4a321012345678",
  "accountId": "acc_0123456789abcdef01234567",
  "planId": "plan_default_user",
  "externalId": "emp_101",
  "createdAt": "2026-10-15T00:30:00.000Z"
}
```

#### Error Responses
- `400 Bad Request`: Invalid payload shape, invalid field types/lengths, plan not found/inaccessible, or plan type is not `USER`.
- `401 Unauthorized`: Missing or invalid API key (`WWW-Authenticate: Bearer`).
- `409 Conflict`: Returned when `externalId` is already in use by another user within the same account (`User with this externalId already exists for this account`).

---

### 6.3 Retrieve User: `GET /users/:userId`

#### Request Details
- **Method:** `GET`
- **Path:** `/users/:userId`
- **Headers:** `Authorization: Bearer <api_key>`

#### Successful Response (`200 OK`)
- **Status Code:** `200 OK`
- **Headers:** `Content-Type: application/json; charset=utf-8`
- **Body:**
```json
{
  "id": "usr_9f8e7d6c5b4a321012345678",
  "accountId": "acc_0123456789abcdef01234567",
  "planId": "plan_default_user",
  "externalId": "emp_101",
  "createdAt": "2026-10-15T00:30:00.000Z"
}
```

#### Error Responses
- `404 Not Found`: Returned uniformly if the user does not exist or belongs to another account (`User not found`).

---

### 6.4 Update User Plan: `PATCH /users/:userId/plan`

#### Request Details
- **Method:** `PATCH`
- **Path:** `/users/:userId/plan`
- **Headers:**
  - `Authorization: Bearer <api_key>`
  - `Content-Type: application/json`
- **Body:**
```json
{
  "planId": "plan_custom_user_pro"
}
```

#### Successful Response (`200 OK`)
- **Status Code:** `200 OK`
- **Headers:** `Content-Type: application/json; charset=utf-8`
- **Body:**
```json
{
  "id": "usr_9f8e7d6c5b4a321012345678",
  "accountId": "acc_0123456789abcdef01234567",
  "planId": "plan_custom_user_pro",
  "externalId": "emp_101",
  "createdAt": "2026-10-15T00:30:00.000Z"
}
```

#### Error Responses
- `400 Bad Request`: `planId` missing/invalid, plan not found/inaccessible, or plan type is not `USER`.
- `404 Not Found`: User does not exist or belongs to another account (`User not found`).

---

## 7. Plan Definition & Quota Limits Specification (Part 11)

### 7.1 Objective and Scope
Part 11 establishes the domain data model, TypeScript types, and runtime validation rules governing plans in the system. The validation function `validatePlanDefinition` provides the strict input verification layer preparing for the upcoming custom plan creation and modification endpoints (`POST /plans` and `PATCH /plans/:planId`) in Part 13.

### 7.2 Mandatory Plan Attributes and Validation Rules
All four fields are strictly required:

| Field | Type | Constraints | Description |
|---|---|---|---|
| `name` | `string` | Non-empty after `trim()`, max 100 chars | Display and operational name of the plan |
| `type` | `PlanType` | Strictly `'ACCOUNT'` or `'USER'` | Target scope of plan application |
| `monthlyLimit` | `number` | Safe integer `>= 0` and `<= 9007199254740991` | Cumulative monthly quota allowance |
| `perRequestLimit` | `number` | Safe integer `>= 0` and `<= 9007199254740991` | Maximum allowable consumption units per single request |

### 7.3 Architectural and Design Policies

1. **Explicit Relational Columns vs Generic JSON:**
   Plan quota rules are represented using explicit SQL columns (`monthly_limit`, `per_request_limit`) rather than generic JSON rule blobs. This ensures straightforward query semantics, enables direct database `CHECK` constraints, avoids rule-interpreter versioning overhead, and maximizes architectural simplicity.

2. **Zero Quota Policy (`limit = 0`):**
   Setting `monthlyLimit: 0` or `perRequestLimit: 0` is valid and supported. This permits operational pausing or blocking of consumption for a specific tenant or user without deleting the plan or modifying existing usage records.

3. **Per-Request vs Monthly Allowance Hierarchy (`perRequestLimit > monthlyLimit`):**
   Configurations where `perRequestLimit > monthlyLimit` are permitted. The quota evaluation engine treats both limits as independent mandatory constraints; a request exceeding either threshold is rejected.

4. **Strict Unknown Field Rejection:**
   Field inspection via `Object.keys` strictly rejects any extraneous, unapproved, or case-mismatched fields (e.g., `MonthlyLimit`, `plan_type`) with a `PlanValidationError` (`Unknown field: <fieldName>`). No automatic type coercion is performed.

---

## 8. Default Seeded Plans & Plan Listing: `GET /plans` (Part 12)

### 8.1 Default Baseline Plans & Design Principles
Upon database migration, the service guarantees the availability of two public baseline plans:

| Identifier | Name | Scope (`type`) | Monthly Limit | Single Request Limit | Ownership |
|---|---|---|---|---|---|
| `plan_default_account` | `Default Account Plan` | `ACCOUNT` | `100,000` | `1,000` | `NULL` (Public) |
| `plan_default_user` | `Default User Plan` | `USER` | `10,000` | `500` | `NULL` (Public) |

#### Operational Context & Scope of Limits:
1. **Single-Request Consumption Limit (`perRequestLimit`):**
   - The `perRequestLimit` parameter defines the maximum consumption quota (`units`) allowed in a single discrete consumption transaction (`POST /consumptions`).
   - It is evaluated on a per-request basis to prevent a single excessive or anomalous API call from draining an entire monthly allocation.
   - It is strictly **not** a rate limit on concurrent requests, nor a throughput capacity benchmark of the server or network.
2. **Design Choices vs Literal Handbook Requirements (`[مرن — برّر]`):**
   - The default plan values (such as `100,000` monthly / `1,000` per request for Accounts, and `10,000` monthly / `500` per request for Users) are **adopted design choices** representing realistic illustrative product tiers.
   - These figures are intentionally flexible architectural decisions (`[مرن — برّر]`) and are not literal mandatory constants prescribed by the guide.
   - Future extensions (such as tier upgrades or custom enterprise limits) can configure different values without altering the core metering invariants.

### 8.2 Distinct Idempotency Mechanisms
The architecture distinguishes between two independent idempotency mechanisms:
1. **Migration Runner Layer (`runMigrations`):** Inspects `schema_migrations` and skips already-applied files, avoiding re-reading or executing migration files on subsequent startups.
2. **SQL Statement Layer (`ON CONFLICT (id) DO NOTHING`):** Located inside `migrations/002_seed_default_plans.sql`. Prevents duplicate primary key insertion errors if the SQL script is executed directly. It protects against re-insertion collisions; it does not render records read-only in PostgreSQL. Mutation protection for public plans is an application-level constraint implemented in Part 13.

---

### 8.3 Endpoint Details: `GET /plans`

#### Objective
Retrieve all plans accessible to the calling account, including all public seeded plans and private custom plans owned by the account, with deterministic ordering.

#### Request Details
- **Method:** `GET`
- **Path:** `/plans`
- **Headers:** `Authorization: Bearer <api_key>`
- **Query Parameters:**
  - `type` (optional): Filter results by scope. Strictly `'ACCOUNT'` or `'USER'` (case-sensitive).

#### Validation and Error Responses
- `400 Bad Request`: Returned if `type` query parameter is empty (`?type=`), duplicated/array (`?type=ACCOUNT&type=USER`), lowercase, or unsupported (`?type=UNKNOWN`).
- `401 Unauthorized`: Missing or invalid API key (`WWW-Authenticate: Bearer`).
- `500 Internal Server Error`: Safe generic response on database or unexpected infrastructure failures.

#### Tenant Isolation and Visibility Rules
- Callers without custom plans see all matching public default plans.
- Callers with custom plans see matching public plans plus their own private plans (`owner_account_id = accountId`).
- Private plans belonging to other accounts are strictly filtered out by the database query.
- When an isolated environment or filter contains zero matching accessible plans, the endpoint returns `200 OK` with an empty array `[]`.

#### Successful Response (`200 OK`)
- **Status Code:** `200 OK`
- **Headers:** `Content-Type: application/json; charset=utf-8`
- **Body:**
```json
[
  {
    "id": "plan_default_account",
    "name": "Default Account Plan",
    "type": "ACCOUNT",
    "monthlyLimit": 100000,
    "perRequestLimit": 1000,
    "ownerAccountId": null,
    "createdAt": "2026-10-15T00:00:00.000Z",
    "updatedAt": "2026-10-15T00:00:00.000Z"
  },
  {
    "id": "plan_default_user",
    "name": "Default User Plan",
    "type": "USER",
    "monthlyLimit": 10000,
    "perRequestLimit": 500,
    "ownerAccountId": null,
    "createdAt": "2026-10-15T00:00:00.000Z",
    "updatedAt": "2026-10-15T00:00:00.000Z"
  }
]
```

#### Pagination Policy:
The response returns the full array of matching plans without pagination in this phase (`No Pagination`), as tenant-accessible plan catalogs are currently small. Pagination parameters (`limit`/`offset`) are documented for future scalability if catalog size warrants.

---

## 9. Custom Plans API: `POST /plans` & `PATCH /plans/:planId` (Part 13)

### 9.1 Architectural Principles & Design Decisions (`[مرن — برّر]`)

1. **Identifier Generation & Uniqueness Barrier:**
   - Plan identifiers are generated in the format `plan_<24 hex characters>` (29 characters total, safely within `VARCHAR(64)`).
   - The random space of $2^{96}$ possible identifiers makes the probability of collision negligible, while PostgreSQL's `PRIMARY KEY (id)` constraint acts as the formal, mathematical barrier preventing duplicate persistence.
2. **Zero-Quota Support (`monthlyLimit = 0`, `perRequestLimit = 0`):**
   - Both limits accept non-negative safe integers (`>= 0`).
   - A limit of `0` is an intentional architectural mechanism enabling accounts to define paused or restricted tiers without mutating account or user assignments.
3. **Plan Name Uniqueness Policy:**
   - Plan names are not required to be globally or per-account unique. Multiple custom plans may share identical names (e.g., "Custom Team Tier"), while the immutable `id` acts as the unambiguous reference across the system.
4. **Immutable Plan Scope (`type`):**
   - Plan scope (`ACCOUNT` vs `USER`) is fixed at creation time and cannot be mutated via `PATCH`. Converting an account-level plan into a user-level plan would violate referential consistency with already assigned entities.
5. **Atomic Partial Update (`COALESCE` without Read-Modify-Write):**
   - Updates use SQL `COALESCE($param, column)` directly. Omitted fields are passed as `null` to SQL, retaining existing values atomically.
   - This approach avoids read-then-rewrite anti-patterns, eliminating race conditions when concurrent requests modify distinct fields of the same plan.
6. **Public Plan Immutability (`403 Forbidden`):**
   - Public baseline plans (`plan_default_account`, `plan_default_user`) are strictly read-only. Modification attempts return `403 Forbidden` (`Default public plans cannot be modified`).
7. **Cross-Tenant Isolation (`404 Not Found`):**
   - Attempts to access or mutate plans belonging to other accounts return `404 Not Found` (`Plan not found`). The service does not reveal the existence of foreign private plans.

---

### 9.2 Endpoint Details: `POST /plans` (Custom Plan Creation)

#### Request Details
- **Method:** `POST`
- **Path:** `/plans`
- **Headers:** `Authorization: Bearer <api_key>`
- **Body:**
```json
{
  "name": "Custom Engineering Plan",
  "type": "USER",
  "monthlyLimit": 25000,
  "perRequestLimit": 500
}
```

#### Field Specifications:
| Field | Type | Constraint | Description |
|---|---|---|---|
| `name` | string | 1-100 chars (trimmed) | Display name of the plan |
| `type` | string | `'ACCOUNT'` or `'USER'` | Scope of applicability |
| `monthlyLimit` | number | Safe integer `>= 0` | Monthly allowance in units |
| `perRequestLimit` | number | Safe integer `>= 0` | Cap on single discrete request |

#### Validation & Errors
- `400 Bad Request`: Missing fields, invalid types, negative limits, unsafe integers, or extraneous/unrecognized fields (`Unknown field: <key>`).
- `401 Unauthorized`: Missing or invalid Bearer token.
- `500 Internal Server Error`: Infrastructure or database connectivity failure.

#### Successful Response (`201 Created`)
- **Status Code:** `201 Created`
- **Headers:**
  - `Location: /plans/:planId`
  - `Content-Type: application/json; charset=utf-8`
- **Body:**
```json
{
  "id": "plan_0123456789abcdef01234567",
  "name": "Custom Engineering Plan",
  "type": "USER",
  "monthlyLimit": 25000,
  "perRequestLimit": 500,
  "ownerAccountId": "acc_0123456789abcdef01234567",
  "createdAt": "2026-10-15T21:40:00.000Z",
  "updatedAt": "2026-10-15T21:40:00.000Z"
}
```

---

### 9.3 Endpoint Details: `PATCH /plans/:planId` (Custom Plan Modification)

#### Request Details
- **Method:** `PATCH`
- **Path:** `/plans/:planId`
- **Headers:** `Authorization: Bearer <api_key>`
- **Body (Partial Update):**
```json
{
  "monthlyLimit": 30000
}
```

#### Update Rules:
1. **At Least One Field:** Request body must contain at least one modifiable field (`name`, `monthlyLimit`, or `perRequestLimit`). Empty `{}` is rejected with `400 Bad Request`.
2. **Explicit Null Rejection:** Sending `null` for any field (e.g., `{ "name": null }`) is strictly rejected with `400 Bad Request`. Only completely omitted fields retain their existing values.
3. **Immutable Type:** Any payload containing `"type"` is rejected with `400 Bad Request` (`"Plan type cannot be changed"`).
4. **Unknown Fields:** Any unrecognized properties are strictly rejected via `Object.keys`.

#### Access Control & Isolation Responses:
- `403 Forbidden`: Returned when attempting to modify a public baseline plan (`Default public plans cannot be modified`).
- `404 Not Found`: Returned when `planId` does not exist or is owned by another account (`Plan not found`).

#### Successful Response (`200 OK`)
- **Status Code:** `200 OK`
- **Headers:** `Content-Type: application/json; charset=utf-8`
- **Body:**
```json
{
  "id": "plan_0123456789abcdef01234567",
  "name": "Custom Engineering Plan",
  "type": "USER",
  "monthlyLimit": 30000,
  "perRequestLimit": 500,
  "ownerAccountId": "acc_0123456789abcdef01234567",
  "createdAt": "2026-10-15T21:40:00.000Z",
  "updatedAt": "2026-10-15T21:50:00.000Z"
}
```

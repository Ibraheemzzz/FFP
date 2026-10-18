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

---

## 10. Plan Assignments & Switching: `PATCH /account/plan` (Part 14)

### 10.1 Architectural Principles & Design Decisions (`[مرن — برّر]`)

1. **Direct Current Plan Column Representation:**
   - The current plan is stored directly as `plan_id` on the `accounts` and `users` tables, adhering to the simplest correct design (`أوضح كود صحيح`).
   - A dedicated historical assignment table is omitted as decision history will be retained in `consumption_records`.
2. **Storage of Consumed vs Calculated Remaining:**
   - Only the cumulative consumed units (`total_units`) are persisted in monthly counter tables (`account_monthly_usage` and `user_monthly_usage`).
   - Remaining quota is calculated dynamically (`monthly_limit - total_units`, floored at 0) rather than stored, avoiding dual-state synchronization anomalies.
3. **Preservation of Existing Monthly Consumption:**
   - Switching an account's plan (`PATCH /account/plan`) or a user's plan (`PATCH /users/:userId/plan`) updates future capacity ceilings only.
   - It strictly **never** resets, recalculates, or mutates existing monthly consumption records (`account_monthly_usage.total_units` and `user_monthly_usage.total_units`).
   - Re-assigning the currently active plan is accepted idempotently with `200 OK` and preserves consumption.
4. **Strict Scope Separation (`ACCOUNT` vs `USER`):**
   - Accounts can only be assigned plans of type `ACCOUNT`.
   - Users can only be assigned plans of type `USER`.
   - Any attempt to cross-assign scopes is rejected with `400 Bad Request`.
5. **Caller Identity & Tenant Isolation:**
   - In `PATCH /account/plan`, the account identity is exclusively derived from `request.account.id`. Any `accountId` supplied in the request body is rejected as an unknown field.
   - Plan accessibility is verified via `getAccessiblePlan`. Plans that do not exist or are owned by another account return the unified error message: `"Plan not found or not accessible"`, preventing tenant plan discovery.
   - After `UPDATE ... RETURNING`, affected row count is verified to ensure safe `404 Not Found` handling without crashing on missing records.
6. **Concurrency Scope Notice:**
   - This part implements assignment mutation and verifies consumption preservation. Full concurrency coordination between plan switching and live request deductions using locks is deferred to subsequent dedicated parts.

---

### 10.2 Endpoint Details: `PATCH /account/plan`

#### Request Details
- **Method:** `PATCH`
- **Path:** `/account/plan`
- **Headers:** `Authorization: Bearer <api_key>`
- **Body:**
```json
{
  "planId": "plan_custom_account_enterprise"
}
```

#### Validation & Error Responses:
- `400 Bad Request`:
  - Empty body `{}` (`At least one field must be provided for update`).
  - Unknown fields (`Unknown field: <key>`).
  - `null` or empty `planId` (`planId must not be null`, `planId must not be empty`).
  - Plan is of type `USER` (`Plan '<id>' is a USER plan, not an ACCOUNT plan`).
  - Plan does not exist or belongs to another account (`Plan not found or not accessible`).
- `401 Unauthorized`: Missing or invalid Bearer token.
- `404 Not Found`: Account row not found in database.
- `500 Internal Server Error`: Generic safe response on database query failure.

#### Successful Response (`200 OK`)
- **Status Code:** `200 OK`
- **Headers:** `Content-Type: application/json; charset=utf-8`
- **Body:**
```json
{
  "id": "acc_0123456789abcdef01234567",
  "name": "Acme Corporation",
  "planId": "plan_custom_account_enterprise",
  "createdAt": "2026-10-15T00:00:00.000Z"
}
```

---

## 11. Plan Changes, Transactional Locking & Immediate Effect (Part 15)

### 11.1 Architectural Principles & Design Decisions (`[مرن — برّر]`)

1. **Centralized Transaction Runner (`withAccountLock`):**
   - All three plan-altering mutations (`updateCustomPlan`, `updateAccountPlan`, `updateUserPlan`) execute strictly within an atomic database transaction managed by `withAccountLock` in `src/db.ts`.
   - The transaction leases a single connection from `pg.Pool`, executes `BEGIN ISOLATION LEVEL READ COMMITTED`, and immediately serializes execution on the account boundary by issuing:
     ```sql
     SELECT id FROM accounts WHERE id = $1 FOR UPDATE;
     ```
2. **Lock Guarantees & Boundaries:**
   - **Protocol Guarantee:** The exclusive lock guarantees strict sequential serialization **only** among concurrent operations that adhere to this account-level locking protocol.
   - **MVCC Non-Blocking:** Normal `SELECT` queries are not blocked by the lock, allowing non-mutating reads (e.g., health checks, public queries) to proceed concurrently without degradation.
   - **Arrival Ordering:** Network arrival order does not dictate processing sequence; whichever transaction acquires the account row lock first completes first.
3. **Strict Order of Operational Reads:**
   - Under `READ COMMITTED`, every query sees committed state at its start time.
   - All operational reads and validations (checking plan existence via `getAccessiblePlan`, checking user assignment via `getUserById`, checking plan scope) execute strictly **after** the lock is acquired on the leased client, preventing read-modify-write races against concurrent mutations.
4. **Immediate Visibility Across All Assigned Entities:**
   - Changes take immediate effect for all requests executed after `COMMIT`.
   - Modifying a shared custom plan immediately reflects updated limits across all users assigned to that plan without needing to re-assign or publish.
5. **Historical Consumption Preservation on Downgrades:**
   - Lowering `monthly_limit` or `per_request_limit` below the current accumulated monthly units (`total_units`) leaves `account_monthly_usage` and `user_monthly_usage` completely untouched.
   - The service calculates remaining quota dynamically and does not reset or erase historical usage.
6. **Failure Semantics, Unknown Outcomes, & Clean Resource Disposal:**
   - **No Premature Success:** `200 OK` is returned to the client only after PostgreSQL confirms successful `COMMIT`.
   - **Indeterminate State on Commit Loss:** If connection drops during `COMMIT`, the outcome is indeterminate; the application treats this as a server error (`500`) and does not assume a rollback took place.
   - **Connection Disposal:** If an operation fails or the connection is severed during transaction execution, `ROLLBACK` is attempted, and the connection is destroyed (`client.release(true)`) to prevent dirty client reuse in the pool.

---

## 12. Consumption Input Validation: `validateConsumptionInput` (Part 16)

### 12.1 Architectural Principles & Design Decisions (`[مرن — برّر]`)

1. **Clear Scope Boundary & No Premature Route Execution:**
   - In Part 16, validation logic is encapsulated purely in `validateConsumptionInput` within `src/consumptions.ts` and tested directly via isolated unit tests.
   - An HTTP endpoint `POST /consumptions` with a dummy/temporary success response is **strictly avoided** at this stage. Exposing a route returning `200 OK` before real deduction logic is built could mislead clients or downstream consumers into assuming quota was verified and deducted. Route integration will occur once the complete atomic transaction and concurrency locking pipeline are wired.
2. **Safe Integer & Positive Amount Rule (`units`):**
   - The deduction amount `units` is validated using:
     ```typescript
     typeof units === 'number' && Number.isSafeInteger(units) && units > 0
     ```
   - This strict combination enforces:
     - Absolute rejection of non-numeric types (`string`, `boolean`, `null`, `undefined`) with zero implicit string-to-number conversion (avoiding silent truncation bugs like `parseInt("10abc")`).
     - Rejection of non-integer values (floats such as `1.5` or `0.1`).
     - Rejection of zero (`0`) and negative values (`-1`, `-100`).
     - Rejection of JavaScript numeric extremes (`NaN`, `Infinity`, `-Infinity`).
     - Guarding against precision loss by capping at `Number.MAX_SAFE_INTEGER` (`9,007,199,254,740,991`).
3. **Identifiers Trimming & String Normalization:**
   - Both `userId` and `requestId` must be non-empty strings.
   - Whitespace trimming (`.trim()`) is applied to both fields.
   - **Critical Architecture Semantics for `requestId`:** Applying trimming to `requestId` is essential because its exact normalized string value will define the request's cryptographic/operational identity in the deduplication and idempotency engine (implemented in Part 22). Treating `"req_123 "` and `"req_123"` as different keys would break deduplication guarantees and cause duplicate deductions on retries with irregular whitespace.
4. **Identifier Length Boundaries:**
   - `userId`: trimmed length must be between 1 and 64 characters (accepts 64, rejects 65).
   - `requestId`: trimmed length must be between 1 and 128 characters (accepts 128, rejects 129).
5. **Strict Field Whitelist & Anti-Spoofing:**
   - The payload must be a JSON object (not an array, primitive, or null).
   - Strict whitelisting allows only `userId`, `units`, and `requestId`. Any unexpected or case-mismatched fields (`userid`, `Units`, `RequestId`, `user_id`, `request_id`) or injected tenant fields (`accountId`) are rejected with `ConsumptionValidationError`.
6. **Subsequent Roadmap Progression:**
   - **Part 17:** شهر المعالجة (Processing Month — UTC Calendar calculation & monthly usage tracking).
   - **Part 18:** تقييم القواعد (Quota Rules Evaluation — deterministic evaluation engine).
   - **Part 19:** المستهلك والمتبقي (Remaining Quota Calculation — dynamic floor calculation without zeroing).
   - **Part 20:** المعاملة الذرية (Atomic Database Transaction — all-or-nothing ledger persistence).
   - **Part 21:** أقفال التزامن (Concurrency & Account Locking Protocol).
   - **Part 22:** منع تكرار الاستهلاك (Deduplication & Idempotent Retry Engine via `requestId`).

---

## 13. Processing Month Determination: `getUtcYearMonth` (Part 17)

### 13.1 Architectural Principles & Design Decisions (`[مرن — برّر]`)

1. **Strict UTC Calendar Month Standard:**
   - The quota tracking cycle is strictly governed by the Gregorian calendar month in UTC (`00:00:00.000Z` on the 1st of the month to `23:59:59.999Z` on the last day of the month).
   - Local system or client timezones and rolling 30-day intervals are explicitly rejected to prevent cross-timezone accounting discrepancies.
   - The month is represented in string format as `YYYY-MM` (e.g., `'2026-10'`), matching the storage format and database check constraint on monthly usage tables.
2. **Intentional Application Year Range (1000–9999):**
   - The application enforces a 4-digit positive year range `1000 <= year <= 9999`.
   - **Architecture Distinction:** This is an intentional application-level design choice (`[مرن — برّر]`) suitable for modern service lifecycles, and is not a constraint strictly imposed by the database regular expression (`CHECK (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')`, which verifies 4 numeric digits). The application bounds ensure clean calendar semantics and prevent zero/negative year anomalies.
3. **Single Timestamp Capture Post-Lock:**
   - In the future end-to-end consumption transaction (Parts 20 & 21), execution will capture a single, immutable timestamp `processedAt = new Date()` strictly **after acquiring the account lock**.
   - This exact same timestamp instance is passed to `getUtcYearMonth(processedAt)` to determine the accounting period, and persisted directly to `consumption_records.processed_at`.
   - The system clock is strictly **never called twice** for these two purposes, preventing split-second month transition anomalies where usage would be evaluated under one month but recorded under another.
4. **Scope & Integration Notice:**
   - Part 17 focuses solely on pure calendar month extraction, edge case verification, and UTC timezone normalization via `getUtcYearMonth`.
   - It deliberately excludes database counter queries (`account_monthly_usage` and `user_monthly_usage`), which are scheduled for Part 19, and does not expose intermediate HTTP endpoints.

---

## 14. Quota Rules Evaluation: `evaluateQuotaRules` (Part 18)

### 14.1 Architectural Principles & Design Decisions (`[مرن — برّر]`)

1. **Pure Domain Function Isolation:**
   - Quota rules evaluation is encapsulated in `evaluateQuotaRules` in `src/consumptions.ts`.
   - It is an entirely pure domain function: no database calls, no network I/O, and no side effects.
   - **Input Contract Specification:** The function expects pre-validated domain inputs: `requestedUnits` must be a positive safe integer (`> 0`), while plan limits and consumed counters must be non-negative safe integers (`>= 0`). It is an internal evaluation engine and does not replace the runtime input validator `validateConsumptionInput`.
2. **Deterministic Evaluation Order (`[مرن — برّر]`):**
   - When a request violates multiple rules simultaneously, the service deterministically reports a single decisive reason following this prioritized order:
     1. **Account Per-Request Limit:** `scope: 'account'`, `rule: 'max_per_request'`
     2. **User Per-Request Limit:** `scope: 'user'`, `rule: 'max_per_request'`
     3. **Account Monthly Allowance:** `scope: 'account'`, `rule: 'monthly_allowance'`
     4. **User Monthly Allowance:** `scope: 'user'`, `rule: 'monthly_allowance'`
   - **Rationale:** Instantaneous single-request bounds are evaluated prior to cumulative monthly balances. Furthermore, the account-level boundary takes precedence as the overarching shared ceiling before individual user bounds.
3. **Subtraction-Based Monthly Comparison:**
   - Monthly allowance rules are evaluated using subtraction rather than addition:
     ```typescript
     context.requestedUnits > context.accountMonthlyLimit - context.accountConsumedUnits
     context.requestedUnits > context.userMonthlyLimit - context.userConsumedUnits
     ```
   - **Safety Guarantees:**
     - **Safe Integer Arithmetic:** Avoids adding two large numbers near `Number.MAX_SAFE_INTEGER`, eliminating integer overflow risks.
     - **Natural Downgrade Handling:** If an account or user plan was downgraded below current accumulated usage (`consumed > monthlyLimit`), `limit - consumed` results in a negative value, cleanly and immediately rejecting any positive request (`requestedUnits > negative`) without special branching.
4. **All-or-Nothing Decision:**
   - If limits permit, the request is accepted in its entirety (`accepted: true`).
   - If any limit is exceeded, the request is rejected in its entirety (`accepted: false`). Partial deductions are never permitted.
5. **Scope Notice & Separation:**
   - Part 18 evaluates policy rules only. Usage snapshot computation (`UsageSnapshot` with `remaining` and `consumed` balances) and counter persistence belong to Part 19 and Part 20.

---

## 15. Consumed and Remaining Quotas: `calculateUsageSnapshot` & Monthly Usage Queries (Part 19)

### 15.1 Architectural Principles & Design Decisions (`[مرن — برّر]`)

1. **Dynamic Remaining Calculation:**
   - Remaining quota is never stored in the database. It is calculated dynamically upon query or evaluation using:
     ```typescript
     remaining = Math.max(0, monthlyLimit - consumedUnits)
     ```
   - **Rationale:** Storing both consumed and remaining amounts creates duplicate state prone to synchronization drift under concurrency. Persisting only cumulative consumed units (`total_units`) preserves a single source of truth.
2. **Non-Negative Remaining Guarantee & Historical Preservation on Downgrades:**
   - Remaining quota is strictly floored at 0 and will never be negative.
   - If an account or user plan is downgraded to a limit below the already consumed units (`consumed > monthlyLimit`), `calculateUsageSnapshot` outputs `remaining: 0`.
   - The historical cumulative consumed amount is strictly preserved and never decremented, truncated, or zeroed.
3. **Database Counter Storage & BIGINT Parsing:**
   - The `total_units` columns in `account_monthly_usage` and `user_monthly_usage` are stored as `BIGINT`.
   - In Node.js `pg`, 64-bit integers are returned as strings. Both `getAccountMonthlyUsage` and `getUserMonthlyUsage` parse them to native JavaScript `number` using `Number(rows[0].total_units)`. This is mathematically safe because database check constraints cap values at `Number.MAX_SAFE_INTEGER` (`9,007,199,254,740,991`).
4. **Absence of Counter Rows vs Error Propagation:**
   - Returning `0` from `getAccountMonthlyUsage` or `getUserMonthlyUsage` signifies exclusively the absence of a counter row for the requested month (`rows.length === 0`).
   - Query failures (database disconnect, syntax errors) are never caught or converted to `0`; they are strictly rethrown to the caller.
5. **Tenant Isolation & Existence Disclaimers in `getUserMonthlyUsage`:**
   - `getUserMonthlyUsage` enforces multi-tenant boundary checks:
     ```sql
     WHERE account_id = $1 AND user_id = $2 AND year_month = $3
     ```
   - **Critical Architecture Notice:** Returning `0` does **not** prove that the user exists or belongs to the requesting account; an unseeded user and a non-existent or foreign user both yield 0 rows. Future end-to-end consumption routes must verify user existence and account ownership (via `getUserById`) prior to trusting counter values.
6. **Concurrency & Transaction Leased Client:**
   - The two independent counter queries do not guarantee a consistent cross-entity snapshot on their own under concurrent traffic.
   - When wired into the end-to-end consumption pipeline in Part 20/21, both queries will execute on the same transaction connection (`PoolClient`) strictly **after acquiring the account-level row lock**.

---

## 16. The Atomic Transaction: `executeConsumption` (Part 20)

### 16.1 Architectural Principles & Design Decisions (`[مرن — برّر]`)

1. **All-or-Nothing Guarantee Across Three Database Writes:**
   - In consumption execution, three discrete database operations are inextricably bound:
     1. Updating the account-level monthly counter (`account_monthly_usage`).
     2. Updating the user-level monthly counter (`user_monthly_usage`).
     3. Inserting the persistent audit ledger entry (`consumption_records`).
   - If any step fails (e.g., connection drop, constraint violation, or server fault), PostgreSQL executes `ROLLBACK`, guaranteeing that counters and ledger rows are never partially modified.

2. **Business Decision Commit vs. Error Rollback:**
   - **Business Policy Rejection (`accepted: false`):** When a request exceeds a quota rule, this is a legitimate domain decision returned as a normal result value (`ConsumptionDecision`), not thrown as an error. Consequently, the transaction completes normally and successfully commits (`COMMIT`), leaving usage counters completely untouched while persisting the rejected decision, reason, snapshots, and `decision_context` into `consumption_records`.
   - **Error Rollback:** Any error thrown inside the operation—whether an application/domain exception (such as `UserNotFoundError` or missing plan configuration) or an infrastructure/database fault (connection drop, unique constraint violation, SQL error)—aborts the operation and triggers `ROLLBACK`, guaranteeing that any preceding counter increments or ledger insertions are completely undone.

3. **Clock Injection Post-Lock:**
   - Time is never accepted from the client request body.
   - The time of processing is determined via a clock provider function (`clock?: () => Date`), called strictly **once** after the account row lock is acquired.
   - The identical `Date` instance governs both the accounting month (`yearMonth = getUtcYearMonth(processedAt)`) and the immutable decision timestamp (`consumption_records.processed_at`), preventing cross-month race discrepancies.

4. **Post-Lock Plan and Identity Verification:**
   - The account's current plan assignment is read directly from the database under the row lock (`SELECT plan_id FROM accounts WHERE id = $1`), never trusted from stale authentication caches.
   - Both account and user plans are verified for existence, accessibility to the tenant, and strict plan type compliance (`accountPlan.type === 'ACCOUNT'` and `userPlan.type === 'USER'`). Missing or incompatible plans represent internal data integrity corruption and abort the transaction.

5. **Historical Decision Context Invariance (`decision_context`):**
   - Migration `003_add_decision_context_to_consumption_records.sql` introduces a `decision_context JSONB NOT NULL` column.
   - Every consumption record explicitly captures the exact plan IDs, `monthlyLimit`, `perRequestLimit`, and pre-transaction usage counters in effect at the moment of decision.
   - **Immutability Guarantee:** Subsequent changes to plan definitions (e.g. lowering or raising limits in Part 15) leave historical `response_body` and `decision_context` completely unchanged.
   - **Contract Protection:** Storing this audit snapshot in `decision_context` prevents polluting `response_body`, keeping the external HTTP response payload 100% faithful to the agreed API contract.

6. **Request ID Collision Behavior Prior to Part 22:**
   - At this stage, re-submitting an identical `requestId` within the same account triggers the PostgreSQL unique constraint `uq_consumption_account_request`.
   - Because this collision occurs within the transaction, the entire operation rolls back: usage counters do not increment a second time, and the request fails cleanly.
   - Comprehensive idempotent replay without error is the dedicated scope of Part 22.

7. **Accurate Connection Cleanup & Indeterminate Outcome Semantics:**
   - In `withAccountLock`, standard transaction errors trigger `ROLLBACK`. Upon a successful rollback, the connection remains clean and is returned to the pool (`client.release(false)`).
   - Connection disposal (`client.release(true)`) is strictly reserved for failures during `COMMIT` or failures during `ROLLBACK`.
   - If a network connection drops during `COMMIT`, the outcome is treated as indeterminate (`500 Internal Server Error`), acknowledging that PostgreSQL may have committed or aborted the transaction before the socket severed.

---

## 17. Concurrency & Account Locking Protocol: `withAccountLock` (Part 21)

### 17.1 Architectural Principles & Design Decisions (`[مرن — برّر]`)

1. **Pessimistic Account-Level Locking Standard:**
   - To eliminate race conditions, double spending, and quota over-allocation across both shared account quotas and individual user quotas, all operations that evaluate consumption or alter plan configurations acquire an exclusive row lock on the parent account:
     ```sql
     BEGIN ISOLATION LEVEL READ COMMITTED;
     SELECT id FROM accounts WHERE id = $1 FOR UPDATE;
     ```
   - **Architecture Rationale:** Locking at the user level alone is strictly insufficient because multiple concurrent users under the same account share the overarching account monthly quota (`account_monthly_usage`). The account row acts as the single serialization point for all mutating operations within that tenant.

2. **Deterministic Serialization & Zero Overspending:**
   - When concurrent requests compete for a limited remaining quota (e.g., 100 concurrent requests for 10 available units), transactions queue and serialize sequentially through the account row lock.
   - Exactly the available quota units are accepted, and subsequent requests are cleanly rejected with `accepted: false` due to exhausted monthly allowance. The final accumulated usage counter in the database matches the allowance exactly, demonstrating zero overspending.

3. **Coordinated Ordering Between Plan Changes and Consumption:**
   - Because `updateAccountPlan`, `updateUserPlan`, `updateCustomPlan`, and `executeConsumption` all adhere to the identical `withAccountLock` protocol on the tenant account, plan modifications and consumption operations serialize predictably without circular waits or deadlocks within the tenant.
   - **Case A (Plan Update First):** If a plan update acquires the lock first, subsequent consumption requests wait. Once the plan update commits, the unblocked consumption evaluates under the newly committed limits.
   - **Case B (Consumption First):** If a consumption transaction acquires the lock first, a plan update waits. The consumption evaluates under the pre-existing limits, and the plan modification executes immediately afterward without altering the completed decision.

4. **Cross-Tenant Non-Blocking Independence:**
   - Different accounts have distinct primary keys (`id`). Row-level `SELECT ... FOR UPDATE` locks on Account A never block or serialize transactions on Account B.
   - Multi-tenant workloads execute in true parallel fashion across available pool connections, sharing database engine capacity without lock contention.

5. **Bounded Contention & Short Transaction Lifecycles:**
   - The lock is held strictly for the minimum necessary duration: in-memory rule evaluation, counter UPSERTs, and ledger insertion. No external network I/O or client communication occurs while holding the lock.
   - Statement and connection timeouts (`statement_timeout`, `query_timeout`) prevent orphaned locks in the event of unexpected client disconnections.

---

## 18. Idempotency Key & Deduplication Protocol: `requestId` (Part 22)

### 18.1 Client Responsibility Standard (`[إلزامي]`)
- **Caller Obligation:** The calling application (Account tenant) is strictly responsible for reusing the identical `requestId` when retrying the same operation after network timeouts, client disconnects, or dropped HTTP responses.
- **Fresh Request Semantics:** Submitting a newly generated `requestId` is treated by the service as an independent, fresh consumption request, which will consume quota and evaluate limits anew.

### 18.2 Architectural Principles & Deduplication Semantics (`[مرن — برّر]`)

1. **Pre-Evaluation Check Order:**
   - Immediately after acquiring the account row lock, and prior to querying user records, plan definitions, or usage counters, the service queries:
     ```sql
     SELECT user_id, requested_units, response_body
     FROM consumption_records
     WHERE account_id = $1 AND request_id = $2;
     ```
   - **Performance & Consistency:** Bypasses in-memory rule evaluations and redundant queries entirely for retries, directly preserving the historical decision snapshot.

2. **Idempotent Replay (Identical Request Parameters):**
   - If an existing record is found matching both `user_id === request.userId` and `requested_units === request.units`:
     - The stored `response_body` is returned immediately as the `ConsumptionDecision`.
     - The transaction terminates cleanly with `COMMIT`.
     - **Database Invariance:** Monthly counters in `account_monthly_usage` and `user_monthly_usage` are NOT modified. No new record is inserted into `consumption_records`. The original record's `processed_at`, `response_body`, and `decision_context` remain strictly immutable.

3. **Conflict Detection & Payload Mismatch (`RequestIdConflictError`):**
   - If an existing record matches the `requestId` within the account, but differs in `userId` or `units`:
     - The service throws `RequestIdConflictError` with message: `'requestId has already been used with different request data'`.
     - In the HTTP route layer (Part 26+), this error maps deterministically to `409 Conflict`.
     - The transaction rolls back cleanly, preserving pre-existing database state and counters intact.

4. **Historical Invariance of Rejected Decisions:**
   - If an earlier request was evaluated and rejected (e.g. due to per-request limit or monthly quota exhaustion), that rejection decision was committed to `consumption_records`.
   - Replaying the identical request with the same `requestId` continues to return the identical rejection response, even if the tenant upgraded their plan limits or crossed into a new calendar month in the interim.
   - To benefit from newly upgraded limits or a new monthly allowance, the caller must submit a new request with a distinct `requestId`.

5. **Cross-Tenant Composite Uniqueness:**
   - The uniqueness guarantee is scoped strictly to `(account_id, request_id)` via `CONSTRAINT uq_consumption_account_request`.
   - Distinct accounts (Tenant A and Tenant B) can safely generate and submit identical `requestId` strings without lock contention, collision, or cross-tenant interference.

6. **Clean Retry After Pre-Commit Rollback:**
   - If an execution fails prior to `COMMIT` (e.g. database error, constraint failure, or missing user), the atomic transaction rolls back completely.
   - Because no row exists in `consumption_records` following `ROLLBACK`, re-submitting the same `requestId` after resolving the root cause proceeds normally as a fresh, uncommitted request.

7. **Replay Across Calendar Month Boundaries:**
   - If an October request (`year_month = '2026-10'`) is replayed in November (`year_month = '2026-11'`), the service returns the October decision payload.
   - Zero rows or counters are created for November (`2026-11`), strictly preventing cross-month leakage.

---

## 19. Get Current Usage API: `GET /account/usage` & `GET /users/:userId/usage` (Part 23)

### 19.1 Architectural Principles & Design Decisions (`[مرن — برّر]`)

1. **Strict Current UTC Calendar Month Scope:**
   - In Part 23, both usage endpoints strictly represent the **current UTC calendar month** only (`getUtcYearMonth()`).
   - Query parameters such as `?month=YYYY-MM` or any unexpected query strings are strictly rejected with `400 Bad Request` (`UsageQueryValidationError`).
   - **Rationale:** Preventing silent fallback or parameter ignoring avoids misleading clients into assuming historical balances were retrieved. Querying past calendar months and establishing historical limits policy is strictly governed by Part 24.

2. **Atomic Point-in-Time MVCC Snapshot (Single `SELECT` Architecture):**
   - Both endpoints execute a single, comprehensive `SELECT` query utilizing `JOIN` on assigned plans and `LEFT JOIN` on monthly usage tables.
   - In PostgreSQL, every discrete `SELECT` statement operates under an atomic statement-level MVCC snapshot. Even during an active in-flight consumption transaction, the read sees a consistent, committed point-in-time view of both account and user counters together, preventing split or dirty readings.
   - If no usage has occurred yet in the current month, `COALESCE(..., 0)` safely resolves consumed units to `0`, and remaining units to full plan quota without throwing.

3. **Dynamic Remaining Calculation & Non-Negative Flooring:**
   - Remaining quota is never stored in the database; it is computed dynamically via `calculateUsageSnapshot(monthlyLimit, consumed)`.
   - Remaining quota is strictly floored at 0 (`Math.max(0, monthlyLimit - consumed)`). If an account or user plan was downgraded below cumulative consumption, `remaining` reports `0` without error and without modifying or decrementing historical consumed totals.

4. **Multi-Tenant Boundary Enforcement & Foreign Resource Masking:**
   - In `GET /account/usage`, the account identity is derived strictly from the authenticated token (`request.account.id`).
   - In `GET /users/:userId/usage`, the query includes `WHERE u.id = $1 AND u.account_id = $2`. Attempting to access a user belonging to another tenant yields 0 rows, returning `404 Not Found` (`User not found`) with zero data leak.

5. **Informational Nature Disclaimer (`[إلزامي]`)**:
   - The usage snapshots returned by `GET /account/usage` and `GET /users/:userId/usage` are purely informational reflecting database state at the exact moment of query.
   - **No Reservation Guarantee:** Reading available balance does **not** reserve units or guarantee acceptance for subsequent consumption requests. Concurrent requests may exhaust remaining allowance before a client's write request arrives. Actual quota deduction and permission are resolved exclusively inside the atomic `executeConsumption` transaction under the tenant row lock.

---

### 19.2 Endpoint Details: `GET /account/usage`

#### Request Details
- **Method:** `GET`
- **Path:** `/account/usage`
- **Headers:** `Authorization: Bearer <api_key>`
- **Query Parameters:**
  - `month` *(optional)*: UTC month in `YYYY-MM` format (e.g. `2026-09`). If omitted or matching the current UTC month, returns the current month usage. If specifying a past month, returns historical usage. Future months and malformed values return `400 Bad Request`. Any other query parameters return `400 Bad Request`.

#### Successful Response for Current Month (`200 OK`)
```json
{
  "accountId": "acc_0123456789abcdef01234567",
  "yearMonth": "2026-10",
  "plan": {
    "id": "plan_default_account",
    "name": "Default Account Plan",
    "type": "ACCOUNT",
    "monthlyLimit": 100000,
    "perRequestLimit": 1000
  },
  "usage": {
    "consumed": 65,
    "remaining": 99935
  }
}
```

#### Successful Response for Historical Closed Month (`200 OK`, e.g. `?month=2026-09`)
*(Reflects actual consumed units from monthly counter and plan limits from the latest request's `decision_context`. Never returns a `remaining` field for historical periods)*:
```json
{
  "accountId": "acc_0123456789abcdef01234567",
  "yearMonth": "2026-09",
  "isCurrentMonth": false,
  "consumed": 65,
  "planAtLastRequest": {
    "id": "plan_starter_account",
    "monthlyLimit": 1000,
    "perRequestLimit": 100
  },
  "lastRequestAt": "2026-09-28T14:32:00.000Z"
}
```
*(If no consumption requests occurred in that historical month, or legacy context was empty, `planAtLastRequest` is `null`)*.

#### Error Responses
- `400 Bad Request`: Extraneous query parameters, invalid month format, duplicate values, or future month provided.
- `401 Unauthorized`: Missing or invalid Bearer API key.
- `404 Not Found`: Account record missing from database.
- `500 Internal Server Error`: Unexpected database error.

---

### 19.3 Endpoint Details: `GET /users/:userId/usage`

#### Request Details
- **Method:** `GET`
- **Path:** `/users/:userId/usage`
- **Headers:** `Authorization: Bearer <api_key>`
- **Query Parameters:**
  - `month` *(optional)*: UTC month in `YYYY-MM` format.

#### Successful Response for Current Month (`200 OK`)
*(Returns unified atomic snapshot of user's personal quota and parent account's shared quota)*:
```json
{
  "userId": "usr_9f8e7d6c5b4a321012345678",
  "accountId": "acc_0123456789abcdef01234567",
  "yearMonth": "2026-10",
  "userPlan": {
    "id": "plan_default_user",
    "name": "Default User Plan",
    "type": "USER",
    "monthlyLimit": 10000,
    "perRequestLimit": 500
  },
  "userUsage": {
    "consumed": 30,
    "remaining": 9970
  },
  "accountPlan": {
    "id": "plan_default_account",
    "name": "Default Account Plan",
    "type": "ACCOUNT",
    "monthlyLimit": 100000,
    "perRequestLimit": 1000
  },
  "accountUsage": {
    "consumed": 80,
    "remaining": 99920
  }
}
```

#### Successful Response for Historical Closed Month (`200 OK`, e.g. `?month=2026-09`)
```json
{
  "userId": "usr_9f8e7d6c5b4a321012345678",
  "accountId": "acc_0123456789abcdef01234567",
  "yearMonth": "2026-09",
  "isCurrentMonth": false,
  "userConsumed": 30,
  "accountConsumed": 65,
  "userPlanAtLastRequest": {
    "id": "plan_starter_user",
    "monthlyLimit": 500,
    "perRequestLimit": 50
  },
  "accountPlanAtLastRequest": {
    "id": "plan_starter_account",
    "monthlyLimit": 1000,
    "perRequestLimit": 100
  },
  "lastRequestAt": "2026-09-28T14:32:00.000Z"
}
```

#### Error Responses
- `400 Bad Request`: Extraneous query parameters, invalid month format, duplicate values, or future month provided.
- `401 Unauthorized`: Missing or invalid Bearer API key.
- `404 Not Found`: User not found or belongs to another tenant account (`User not found`).
- `500 Internal Server Error`: Unexpected database error.

---

## 20. Consumption Evaluation & Metering API: `POST /consumptions`

### 20.1 Architectural Principles & Design Decisions (`[مرن — برّر]`)

1. **Authentication as Single Source of Account Identity:**
   - The account identity is extracted strictly and exclusively from the authenticated Bearer API key (`request.account.id`).
   - The request body is validated strictly against allowed fields (`userId`, `units`, `requestId`). Passing `accountId` or any unexpected field in the JSON body is rejected with `400 Bad Request` (`Unknown field: accountId`). It is never silently ignored.

2. **HTTP 200 OK for Business Decisions (Acceptance & Quota Rejection):**
   - Both acceptance (`accepted: true`) and quota exhaustion (`accepted: false`) are valid business evaluation outcomes, not technical or protocol transport failures.
   - Both outcomes return HTTP status `200 OK` with complete usage snapshots reflecting current balances.
   - For rejections, the payload includes a structured `reason` object specifying the binding boundary (`scope`: `'account'` | `'user'`) and the triggered rule (`rule`: `'monthly_allowance'` | `'max_per_request'`).

3. **Response Schema & Immutability:**
   - The returned `ConsumptionDecision` matches the canonical internal types:
     - Accepted: `{ accepted: true, requestId, account: { consumed, remaining }, user: { consumed, remaining } }`
     - Rejected: `{ accepted: false, requestId, reason: { scope, rule }, account: { consumed, remaining }, user: { consumed, remaining } }`
   - Notice that `processedAt` is persisted internally in `consumption_records.processed_at` and is not part of the external consumption decision response body.

4. **Idempotency & Deduplication Guarantees:**
   - Every consumption request must specify a unique `requestId` (up to 128 chars).
   - Re-submitting an identical request with the same `requestId`, `userId`, and `units` returns the exact historical decision with HTTP `200 OK`, without duplicate counter increments or redundant database records.
   - Reusing a previously registered `requestId` with differing request parameters (different `userId` or `units`) violates idempotency and is rejected with `409 Conflict` (`RequestIdConflictError`).

5. **Tenant Isolation & Security:**
   - Submitting a request for a non-existent user or a user belonging to another tenant account returns `404 Not Found` (`User not found`), completely preventing enumeration or state discovery across accounts.
   - Unexpected infrastructure or database failures return a safe, generic message (`500 Internal Server Error` with `{ "error": "Internal Server Error" }`) without leaking queries, internal errors, or connection details.

---

### 20.2 Endpoint Details: `POST /consumptions`

#### Request Details
- **Method:** `POST`
- **Path:** `/consumptions`
- **Headers:**
  - `Authorization: Bearer <api_key>`
  - `Content-Type: application/json`
- **Body:**
```json
{
  "userId": "usr_9f8e7d6c5b4a321012345678",
  "units": 50,
  "requestId": "req_8a7b6c5d4e3f210987654321"
}
```

#### Field Specifications:
| Field | Type | Constraint | Description |
|---|---|---|---|
| `userId` | string | 1-64 chars (trimmed) | Identifier of the user consuming units |
| `units` | number | Safe integer `> 0` | Quantity of quota units requested |
| `requestId` | string | 1-128 chars (trimmed) | Client-generated idempotent idempotency key |

#### Successful Acceptance Response (`200 OK`)
- **Status Code:** `200 OK`
- **Body:**
```json
{
  "accepted": true,
  "requestId": "req_8a7b6c5d4e3f210987654321",
  "account": {
    "consumed": 50,
    "remaining": 99950
  },
  "user": {
    "consumed": 50,
    "remaining": 9950
  }
}
```

#### Successful Quota Rejection Response (`200 OK`)
- **Status Code:** `200 OK`
- **Body:**
```json
{
  "accepted": false,
  "requestId": "req_8a7b6c5d4e3f210987654321",
  "reason": {
    "scope": "user",
    "rule": "max_per_request"
  },
  "account": {
    "consumed": 50,
    "remaining": 99950
  },
  "user": {
    "consumed": 50,
    "remaining": 9950
  }
}
```

#### Error Responses
- `400 Bad Request`: Body is not a JSON object, missing mandatory fields (`userId`, `units`, `requestId`), unknown/extra fields provided (e.g. `accountId`), invalid `units` (<= 0, float, string, unsafe int), or empty/oversized string IDs.
- `401 Unauthorized`: Missing or invalid Bearer API key (`WWW-Authenticate: Bearer`).
- `404 Not Found`: Target `userId` does not exist or does not belong to the authenticated account (`User not found`), or parent account not found.
- `409 Conflict`: `requestId` has already been used by this account with different payload data (`requestId has already been used with different request data`).
- `500 Internal Server Error`: Generic internal server error message (`{ "error": "Internal Server Error" }`) on database or unexpected system failures.

---

## 21. Request History & Pagination API: `GET /requests` (Part 25)

### 21.1 Architectural Principles & Design Decisions (`[مرن — برّر]`)

1. **Lightweight Offset Pagination via `hasMore` (No `COUNT(*)` CTE):**
   - The endpoint queries `limit + 1` records directly using standard `LIMIT` and `OFFSET` clauses.
   - If the query returns `limit + 1` rows, `hasMore` is set to `true` and the extra row is trimmed, leaving exactly `limit` items in the response.
   - If the query returns $\le limit$ rows, `hasMore` is `false`.
   - **Rationale:** This eliminates full table scans and expensive `COUNT(*)` windowing/aggregations, keeping database load minimal.

2. **Deterministic Ordering with Tie-Breaking:**
   - Results are strictly ordered by `processed_at DESC, id DESC`.
   - In PostgreSQL, multiple requests processed in the same millisecond share identical timestamps. The primary key `id DESC` serves as the unambiguous, deterministic tie-breaker.
   - Because `id` is a 64-bit integer (`BIGSERIAL`), it is returned as a JSON `string` to prevent IEEE 754 precision loss in JavaScript runtimes.

3. **Known Limitation of Offset Pagination (Page Drift):**
   - **Documented Trade-Off:** In an append-only log, if new consumption requests are accepted while a client pages through results with `offset`, previously seen records shift down. An item seen at the tail of page $N$ may reappear at the head of page $N+1$.
   - This limitation is accepted as standard for offset-based pagination in this training milestone.

4. **Search and Filter Semantics (Empty List vs 404):**
   - `GET /requests` is a collection search endpoint, not a direct single-resource lookup.
   - Filtering by a non-existent `userId` or a user belonging to another account returns an empty list (`items: []`, `hasMore: false`) with HTTP `200 OK`.
   - Filtering by an empty month or a future month returns an empty list (`items: []`, `hasMore: false`) with HTTP `200 OK`.

5. **Index Baseline Note:**
   - Queries benefit from the composite index `idx_consumption_records_history(account_id, processed_at DESC, id DESC)` created in migration 001. No schema mutations or migrations are added in Part 25.

---

### 21.2 Endpoint Details: `GET /requests`

#### Request Details
- **Method:** `GET`
- **Path:** `/requests`
- **Headers:** `Authorization: Bearer <api_key>`
- **Query Parameters:**
  - `limit` *(optional)*: Safe integer between `1` and `100` (default: `20`).
  - `offset` *(optional)*: Non-negative safe integer `>= 0` (default: `0`).
  - `userId` *(optional)*: Filter by specific user identifier (1-64 chars, trimmed).
  - `status` *(optional)*: Filter by request status (`'ACCEPTED'` or `'REJECTED'`).
  - `month` *(optional)*: Filter by UTC calendar month in `YYYY-MM` format (1000-9999).

#### Successful Response (`200 OK`)
- **Status Code:** `200 OK`
- **Headers:** `Content-Type: application/json; charset=utf-8`
- **Body:**
```json
{
  "items": [
    {
      "id": "105",
      "requestId": "req_20261018_001",
      "userId": "usr_ahmad",
      "requestedUnits": 2,
      "status": "ACCEPTED",
      "rejectionReason": null,
      "responseBody": {
        "accepted": true,
        "requestId": "req_20261018_001",
        "account": { "consumed": 52, "remaining": 99948 },
        "user": { "consumed": 12, "remaining": 9988 }
      },
      "processedAt": "2026-10-18T17:42:00.000Z"
    },
    {
      "id": "104",
      "requestId": "req_20261018_002",
      "userId": "usr_sara",
      "requestedUnits": 600,
      "status": "REJECTED",
      "rejectionReason": {
        "scope": "user",
        "rule": "max_per_request"
      },
      "responseBody": {
        "accepted": false,
        "requestId": "req_20261018_002",
        "reason": {
          "scope": "user",
          "rule": "max_per_request"
        },
        "account": { "consumed": 50, "remaining": 99950 },
        "user": { "consumed": 10, "remaining": 9990 }
      },
      "processedAt": "2026-10-18T17:40:00.000Z"
    }
  ],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "hasMore": false
  }
}
```

#### Error Responses
- `400 Bad Request`: Unknown query parameter, duplicate parameters (arrays), non-integer or out-of-bounds `limit` / `offset`, invalid `status`, or malformed `month` / `userId`.
- `401 Unauthorized`: Missing or invalid Bearer API key.
- `500 Internal Server Error`: Safe generic response on database or unexpected system errors.

---

## 22. Observability, Request Tracing & Error Handling Architecture (Part 26)

### 22.1 Universal Request Tracing (`x-request-id`)
- **Server Generation:** Every incoming HTTP request is assigned a unique, cryptographically random identifier generated exclusively by the server via `crypto.randomUUID()` in the format `req_<32 hex chars>`.
- **Client Header Immunity:** The server enforces `requestIdHeader: false`. Any client-supplied tracking headers (e.g., `x-request-id` or `request-id`) are ignored and overwritten.
- **Response Propagation:** Every HTTP response carries the server-generated `x-request-id` header in the `onSend` lifecycle hook, enabling unambiguous cross-system log correlation.

### 22.2 Error Response Contract
- **Payload Shape:** All error responses strictly maintain the uniform schema without extra properties:
```json
{
  "error": "Descriptive error message"
}
```
- **Fastify Protocol Errors:** The central error handler identifies Fastify's verified protocol parsing codes directly:
  - `400 Bad Request` (`FST_ERR_CTP_INVALID_JSON_BODY`, `FST_ERR_CTP_EMPTY_JSON_BODY`, `FST_ERR_CTP_INVALID_CONTENT_LENGTH`): Returned with `{ "error": "Invalid request body" }`.
  - `413 Payload Too Large` (`FST_ERR_CTP_BODY_TOO_LARGE`): Returned with `{ "error": "Payload Too Large" }`.
  - `415 Unsupported Media Type` (`FST_ERR_CTP_INVALID_MEDIA_TYPE`): Returned with `{ "error": "Unsupported Media Type" }`.
  - `Domain Client Errors`: Validated business rules, conflict, and authentication errors handled within route handlers retain their specific status codes and messages.
  - `500 Internal Server Error`: All unexpected errors, internal syntax errors, or unverified exceptions return `{ "error": "Internal Server Error" }` without echoing error messages.

### 22.3 Structured Request Logging & Log Hygiene
- **Single Completion Log:** Fastify's automatic duplicate request logging is disabled (`disableRequestLogging: true`). A single structured JSON log entry is emitted on `onResponse`:
```json
{
  "event": "request_completed",
  "requestId": "req_0192a688b123456789abcdef01234567",
  "method": "POST",
  "path": "/consumptions",
  "statusCode": 200,
  "durationMs": 4.12
}
```
- **Strict Privacy & Secret Protection:**
  - Query parameters are stripped from logged paths (`request.url.split('?')[0]`).
  - Request headers (including `Authorization: Bearer <key>`) and request bodies are never logged.
  - Raw error objects and `err.message` are never printed in 500 logs; unexpected failures are logged with a constant message:
    `request.log.error({ event: 'request_failed', requestId: request.id }, 'Unexpected request failure')`.
  - Source files (`app.ts`, `auth.ts`, `server.ts`, `db.ts`, `migrator.ts`) are audited against raw error message leakage.

### 22.4 Database Timeout & Transaction Guarantees
- **Statement Timeout (`57014`) & Lock Timeout (`55P03`):** Any statement or lock timeout occurring inside `withAccountLock` aborts the transaction immediately.
- **Atomic Rollback:** The transaction is rolled back via `ROLLBACK`, guaranteeing zero partial deduction and pristine quota state.
- **Clean Discard on Catastrophic Failure:** If a transaction failure cannot be cleanly rolled back, the client connection is destroyed (`client.release(true)`), preventing poisoned connections from returning to the pool.











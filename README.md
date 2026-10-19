# Usage Metering and Quotas Service

A high-concurrency, multi-tenant usage metering and quota enforcement backend service built with **TypeScript**, **Fastify**, and **PostgreSQL**. The service enables SaaS platforms to evaluate, authorize, deduct, and audit quota consumption requests across tenant accounts and individual users in real time.

---

## Table of Contents

1. [Core Concepts & Domain Model](#1-core-concepts--domain-model)
2. [Authentication, Security & Tenant Isolation](#2-authentication-security--tenant-isolation)
3. [Quota Rules & Evaluation Logic](#3-quota-rules--evaluation-logic)
4. [Idempotency & Replay Semantics](#4-idempotency--replay-semantics)
5. [Plan Lifecycle & Monthly Calendar Boundaries](#5-plan-lifecycle--monthly-calendar-boundaries)
6. [Key Architectural Decisions](#6-key-architectural-decisions)
7. [Prerequisites & Port Configuration](#7-prerequisites--port-configuration)
8. [Running with Docker Compose](#8-running-with-docker-compose)
9. [Local Development (Without Docker)](#9-local-development-without-docker)
10. [Automated Testing](#10-automated-testing)
11. [Performance & Load Benchmarks](#11-performance--load-benchmarks)
12. [API Reference Summary](#12-api-reference-summary)
13. [Delivery & Security Audit Checklist](#13-delivery--security-audit-checklist)

---

## 1. Core Concepts & Domain Model

The service models multi-tenant usage metering through four primary entities:

- **Account:** The root tenant organization. Each account owns an API key, users, custom plans, monthly usage counters, and historical consumption records.
- **User:** An individual consumer belonging strictly to one account (`account_id`). Users cannot exist independently of an account.
- **Plan:** Defines consumption thresholds (`monthly_allowance` and `max_per_request`). Plans operate at either `ACCOUNT` scope or `USER` scope. The system provides pre-seeded system plans (`plan_default_account`, `plan_default_user`) and allows tenants to create custom plans scoped to their account.
- **Units:** The service meters abstract, generic positive integer units (`units >= 1`).
  > **Design Note:** The service does **not** model or maintain a dedicated `Resource` entity or table. Metering is performed against generic consumption units, which consuming platforms map to their own domain operations (e.g., API calls, AI inference tokens, file operations).

---

## 2. Authentication, Security & Tenant Isolation

- **API Key Issuance:** Tenant accounts register via `POST /accounts`. The service generates a secure, random plaintext API key returned **strictly once** in the registration response.
- **Cryptographic Storage:** The raw key is never stored. Only its SHA-256 hash (`api_key_hash`) is persisted in the database.
- **Request Authentication:** All protected endpoints require HTTP Bearer authentication:
  ```http
  Authorization: Bearer <api_key>
  ```
- **Strict Tenant Isolation:** Every authenticated request resolves the `accountId` directly from the token digest. Database operations automatically filter by `account_id`, preventing cross-tenant data access, plan hijacking, or quota tampering.

---

## 3. Quota Rules & Evaluation Logic

Every consumption request (`POST /consumptions`) is evaluated against four deterministic rules in strict sequential order under an exclusive account lock:

1. **Account Per-Request Limit:** `requested_units <= accountPlan.max_per_request`
2. **User Per-Request Limit:** `requested_units <= userPlan.max_per_request`
3. **Account Monthly Allowance:** `accountConsumed + requested_units <= accountPlan.monthly_allowance`
4. **User Monthly Allowance:** `userConsumed + requested_units <= userPlan.monthly_allowance`

### Rule Violation & HTTP Status
- If any rule fails, the request is rejected immediately with the structured rejection scope and rule (`scope`: `'account'` | `'user'`, `rule`: `'monthly_allowance'` | `'max_per_request'`).
- **HTTP 200 for Business Rejections:** Quota rejections are valid business decisions rather than transport or server protocol errors. The server returns HTTP `200 OK` with the rejection reason and intact usage snapshots:
  ```json
  {
    "accepted": false,
    "requestId": "req_example",
    "reason": {
      "scope": "user",
      "rule": "max_per_request"
    },
    "account": { "consumed": 0, "remaining": 100000 },
    "user": { "consumed": 0, "remaining": 10000 }
  }
  ```
- **Dynamic Balance Calculation:** Remaining allowances are computed with non-negative flooring:
  $$\text{remaining} = \max(0, \text{monthly\_allowance} - \text{consumed})$$

---

## 4. Idempotency & Replay Semantics

To guarantee safe network retries and prevent double-deductions under distributed environments, consumption requests require a unique client-supplied `requestId`.

### Account-Scoped Uniqueness & In-Transaction Execution Flow
- **Account-Scoped Uniqueness:** `requestId` uniqueness is enforced strictly within the scope of each tenant account (`UNIQUE (account_id, request_id)`), allowing independent accounts to use identical identifiers without collision.
- **In-Transaction Check:** Idempotency deduplication is executed **strictly inside the database transaction and after acquiring the exclusive account row lock**:

```mermaid
sequenceDiagram
    participant Client
    participant Service as Fastify Service
    participant DB as PostgreSQL

    Client->>Service: POST /consumptions (requestId, userId, units)
    Note over Service,DB: BEGIN ISOLATION LEVEL READ COMMITTED
    Service->>DB: SELECT id FROM accounts WHERE id = $1 FOR UPDATE
    Note over DB: Exclusive Account Row Lock Acquired
    Service->>DB: SELECT user_id, requested_units, response_body FROM consumption_records WHERE account_id = $1 AND request_id = $2
    alt Record Exists with Identical Payload
        Note over Service: Replay Cached Decision
        Service->>DB: COMMIT
        Service-->>Client: HTTP 200 (Stored Decision Snapshot)
    else Record Exists with Mismatched Payload
        Note over Service: Payload Conflict
        Service->>DB: ROLLBACK
        Service-->>Client: HTTP 409 Conflict ({ "error": "..." })
    else Record Does Not Exist (Evaluate Quota Rules)
        alt All Rules Passed (Accepted)
            Service->>DB: UPDATE account_monthly_usage & user_monthly_usage (+units)
            Service->>DB: INSERT INTO consumption_records (decision snapshot)
            Service->>DB: COMMIT
            Service-->>Client: HTTP 200 (accepted: true)
        else Any Rule Failed (Rejected)
            Note over Service,DB: Counters are NOT incremented
            Service->>DB: INSERT INTO consumption_records (rejection snapshot)
            Service->>DB: COMMIT
            Service-->>Client: HTTP 200 (accepted: false)
        end
    end
```

1. **Transaction & Lock:** Begins `READ COMMITTED` transaction and locks the account row (`SELECT id FROM accounts WHERE id = $1 FOR UPDATE`).
2. **Post-Lock Lookup:** Queries `consumption_records` for `(account_id, request_id)`.
3. **Identical Replay:** If the record exists and `userId` and `units` match, the server returns the cached decision snapshot immediately without re-evaluating rules or incrementing counters.
   - **Replay of Rejected Decisions:** If an initial request was rejected and the client replays the exact same `requestId`, the service re-returns the stored rejection snapshot, even if plan limits were upgraded subsequently. Obtaining an evaluation against newly updated plan limits requires the client to issue a new request with a distinct `requestId`.
4. **Conflict Detection:** If the record exists but `userId` or `units` differ, the transaction rolls back and returns **HTTP 409 Conflict** with `{ "error": "requestId has already been used with different request data" }`.
5. **Atomic Execution:**
   - **When Accepted:** Quota counters (`account_monthly_usage`, `user_monthly_usage`) are incremented, and the decision is saved to `consumption_records` before `COMMIT`.
   - **When Rejected:** Monthly usage counters are **not** incremented; the rejection snapshot is saved to `consumption_records` before `COMMIT` for audit history and idempotency replay.

---

## 5. Plan Lifecycle & Monthly Calendar Boundaries

- **Immediate Plan Effect:** Plan assignments (`PATCH /account/plan`, `PATCH /users/:userId/plan`) take effect immediately under the account lock without requiring service restarts.
- **Consumption Invariance:** Changing plans never modifies or erases historical consumption counters (`account_monthly_usage`, `user_monthly_usage`).
- **Downgrades & Subsequent Upgrades:** When a plan's limit is lowered below already-consumed units for the current month, remaining units cleanly floors to `0` without negative values. Subsequent requests are rejected as long as current consumption meets or exceeds the active limit. If limits are raised again later in the same billing cycle, new requests can be accepted once more against the existing monthly usage.
- **Calendar Month Boundaries:** Usage counters are partitioned by UTC calendar month `YYYY-MM`. As soon as UTC time rolls over into a new month, requests automatically initialize new counters at `0` without background batch cron jobs.

---

## 6. Key Architectural Decisions

Concise summary of actual architectural decisions implemented in the codebase:

### 1. Fastify HTTP Framework
- **Decision:** Use Fastify instead of Express or NestJS.
- **Rationale:** High throughput, low latency overhead, native schema validation with Ajv, and an encapsulated plugin architecture.
- **Limitations:** Smaller middleware ecosystem compared to Express; less out-of-the-box enterprise abstraction compared to NestJS.

### 2. Native SQL via `pg` Client (No Heavy ORM)
- **Decision:** Execute explicit SQL queries using PostgreSQL native driver (`pg`) without an ORM (e.g., Prisma or TypeORM).
- **Rationale:** Complete control over transaction lifecycles, explicit row locking (`SELECT ... FOR UPDATE`), predictable execution plans, and zero abstraction leaks.
- **Limitations:** Requires manual schema migrations, SQL query authoring, and explicit TypeScript type mapping.

### 3. Account-Level Pessimistic Row Locking
- **Decision:** Serialize operations for the same account using `SELECT id FROM accounts WHERE id = $1 FOR UPDATE` at `READ COMMITTED` isolation.
- **Rationale:** Serializes concurrent operations per account within database transaction boundaries, preventing concurrent balance mutations for that account without the abort-and-retry storms common to `SERIALIZABLE` isolation or optimistic concurrency under heavy single-tenant load.
- **Limitations:** Concurrent requests for the *same* account queue sequentially, capping single-tenant throughput by lock duration. Multi-tenant operations on different accounts execute in parallel.

### 4. Pre-Aggregated Monthly Usage Counters + Append-Only Audit Log
- **Decision:** Maintain real-time aggregated counter rows (`account_monthly_usage`, `user_monthly_usage`) alongside an append-only request audit table (`consumption_records`).
- **Rationale:** Avoids computing dynamic `SUM(requested_units)` aggregations across historical records on every consumption evaluation; historical decision records are append-only by application design and never updated in place.
- **Limitations:** Requires dual writes inside the same transaction when accepting requests to maintain strict parity between aggregated totals and record sums.

### 5. In-Transaction Lock-Protected Idempotency Check
- **Decision:** Check and record idempotency keys directly within the PostgreSQL transaction under the account lock, backed by `UNIQUE (account_id, request_id)`.
- **Rationale:** Eliminates distributed race windows between parallel identical requests without requiring external state stores.
- **Limitations:** Database connections handle deduplication lookups instead of offloading identical replays at an external caching layer (e.g., Redis).

### 6. HTTP 200 for Business Quota Rejections
- **Decision:** Return HTTP 200 with `{ "accepted": false, "reason": { ... } }` when quota thresholds are exceeded, rather than HTTP 402/403/429.
- **Rationale:** Separates business domain decisions from protocol/transport failures. Exceeding an application quota is an expected business outcome accompanied by remaining allowance metadata.
- **Limitations:** Consuming HTTP clients must inspect the `accepted` boolean in the JSON payload rather than relying solely on HTTP status codes.

### 7. Generic Abstract Consumption Units
- **Decision:** Model consumption as positive integer `units` without creating a dedicated `Resource` table.
- **Rationale:** Satisfies project requirements with the simplest correct architecture, giving client applications full flexibility to map units to their own resources.
- **Limitations:** Multi-resource metering with heterogeneous unit costs requires schema extension.

---

## 7. Prerequisites & Port Configuration

### System Prerequisites
- **Docker & Docker Compose:** Docker Engine 24+ and Docker Compose v2.20+
- **Node.js:** Node.js 22+ (for running scripts or local development without Docker)

### Port Allocation & Avoiding Host Collisions
To prevent port collisions with existing local databases or background development containers, the stack uses distinct default ports:

| Service | Container Internal Port | Default Host Port | Config Environment Variable |
|---|---|---|---|
| **Backend API Service** | `3000` | `3000` | `PORT` |
| **PostgreSQL (Docker Compose)** | `5432` | **`5434`** | `POSTGRES_PORT` |
| **PostgreSQL (Local Dev `.env`)** | `5432` | **`5433`** | `DATABASE_URL` in `.env` |

> **Important Port Distinction:**
> - Docker Compose publishes PostgreSQL to host port **`5434`** by default (`${POSTGRES_PORT:-5434}:5432`).
> - The local development configuration template (`.env.example`) points to port **`5433`** (`postgres://postgres:postgres_password@127.0.0.1:5433/usage_metering_dev`).
> - If you run local tools against the Docker container database, target port **`5434`**. Do not modify `.env` to match Docker if you maintain a separate local PostgreSQL instance on `5433`.

---

## 8. Running with Docker Compose

### 1. Start the Full Stack (Automated Demo Mode)
Launches PostgreSQL 16, runs database migrations automatically, seeds default plans, starts the Fastify service, and executes an automated demo client verifying core scenarios:

```bash
docker compose up --build
```

#### Startup Sequence:
1. **`postgres`:** Starts PostgreSQL 16 on an isolated bridge network with persistent volume storage (`postgres_data`). Health check validates readiness via `pg_isready`.
2. **`service`:** Waits for PostgreSQL to be healthy, executes schema migrations (`001`, `002`, `003`), seeds default plans, and starts listening on `0.0.0.0:3000`. Readiness check validates HTTP and DB readiness via `GET /health/ready`.
3. **`demo-client`:** Waits for the service to be healthy, executes a 7-step automated scenario (account creation, plan assignments, allowed consumption, user quota rejection, account quota rejection, immediate plan upgrades, and audit inspection), and exits with code `0`.
4. The `service` and `postgres` containers remain running and ready for traffic.

---

### 2. Interactive CLI Demo Client
To interactively explore the service using a terminal menu:

```bash
docker compose run --rm demo-client npm start
```

This launches the interactive CLI connected to the live service:
```text
──────────────────────────────────────────────────────────────────────
Active User: Ahmed (usr_...) | Plan: plan_default_user
──────────────────────────────────────────────────────────────────────
1. Select user
2. Perform action
3. View usage and remaining allowance
4. Change plan settings
5. Run guided demo
0. Exit
```

---

### 3. Stopping the Stack & Managing Data

#### Stop containers while preserving database volume:
```bash
docker compose down
```
All accounts, users, plans, consumption records, and monthly counters remain persisted in the `postgres_data` Docker volume.

#### Stop containers and wipe database state (Clean Slate):
```bash
docker compose down -v
```
Removes all containers, networks, and persistent data volumes for a fresh start.

---

## 9. Local Development (Without Docker)

### 1. Install Dependencies
```bash
npm install
npm --prefix demo-client install
```

### 2. Environment Setup
Copy the example environment file and configure your database connection:
```bash
cp .env.example .env
```
Ensure your PostgreSQL instance is running on the port specified in `.env` (default: `5433` for local development, or `5434` if targeting the Docker Compose database).

### 3. Build & Run Locally
```bash
# Compile TypeScript to dist/
npm run build

# Start Fastify service in development mode (with tsx)
npm run dev

# Run automated demo client locally
npm run demo

# Run interactive demo client locally
npm --prefix demo-client start
```

---

## 10. Automated Testing

The project includes **26 comprehensive test suites** covering unit logic, database migrations, authentication, concurrency locks, idempotency, and the demo client:

```bash
npm test
```

### Test Suite Structure
- **Core Service (`tests/`):** 24 suites testing configuration, health probes, connection pools, schema migrations, account registration, Bearer authentication, tenant isolation, user management, plan CRUD and assignments, in-flight plan mutations, payload validation, calendar month partitioning, 4-rule quota evaluation, dynamic balance math, atomic transactions, row-level concurrency locking, idempotency deduplication, usage analytics, consumption endpoints, and error handling.
- **Demo Client (`demo-client/tests/`):** 2 suites validating automated scenario execution and interactive menu state transitions.

---

## 11. Performance & Load Benchmarks

The project includes an automated, real-HTTP load testing suite (`scripts/benchmark.ts`) measuring throughput, latency percentiles (p50, p95, p99), row-lock contention, and database integrity.

### Running Benchmarks
With the Docker service running (`docker compose up -d service`):
```bash
npm run benchmark
```

### Benchmark Summary Across 5 Real-HTTP Scenarios

| Scenario | Concurrency ($C$) | Requests | Avg Throughput (req/s) | Latency p50 (ms) | Avg p95 of Runs (ms) | Latency p99 (ms) | DB Integrity Audit |
|---|---|---|---|---|---|---|---|
| **1. Single Account (Lock Contention)** | 15 | 1,800 (3 runs) | **240.25** | 61.11 | 66.59 | 99.73 | **100% PASSED** (0 discrepancies) |
| **2. Multi-Tenant Parallelism** (10 Accounts) | 15 | 1,800 (3 runs) | **653.19** | 22.27 | 30.53 | 35.61 | **100% PASSED** (0 discrepancies) |
| **3. Quota Exhaustion Transition** | 10 | 300 | **274.59** | 35.33 | 40.97 | 41.62 | **100% PASSED** (50 accepted, 250 rejected) |
| **4. Idempotent Deduplication Retries** | 15 | 500 | **617.22** | 21.74 | 40.59 | 50.29 | **100% PASSED** (10 units consumed total) |
| **5. In-Flight Plan Mutation** | 10 | 400 | **250.55** | 37.08 | 51.64 | 96.79 | **100% PASSED** (150 rejected, 250 accepted) |

> **Note on Benchmark Environment & Variance:**
> Benchmark figures were measured on a local development host and Docker container environment; they illustrate concurrency dynamics and lock behavior rather than serving as production performance guarantees. In concurrent mutation scenarios (such as Scenario 5, where a plan upgrade is dispatched concurrently with incoming traffic), the exact split between pre-upgrade rejected requests and post-upgrade accepted requests depends on thread scheduling and system load, and will vary across test runs.

For complete benchmark methodology, timing isolation, hardware environment specs, and lock bottleneck analysis:
- **Full Technical Benchmark Report:** [docs/part-02-performance-benchmarks.md](docs/part-02-performance-benchmarks.md)
- **Raw Telemetry Output:** [docs/benchmark-results.json](docs/benchmark-results.json)

---

## 12. API Reference Summary

All administrative and consumption routes require `Authorization: Bearer <apiKey>` except `/health`, `/health/ready`, and `POST /accounts`.

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `GET` | `/health` | Liveness health check | No |
| `GET` | `/health/ready` | Readiness check with live DB probe | No |
| `POST` | `/accounts` | Register tenant account & issue plaintext API key | No |
| `GET` | `/account/me` | Fetch authenticated account details | Bearer Key |
| `PATCH` | `/account/plan` | Update account plan assignment | Bearer Key |
| `POST` | `/users` | Create user under authenticated account | Bearer Key |
| `GET` | `/users/:userId` | Get user details | Bearer Key |
| `PATCH` | `/users/:userId/plan` | Update user plan assignment | Bearer Key |
| `GET` | `/plans` | List accessible default & custom plans | Bearer Key |
| `GET` | `/plans/:planId` | Fetch plan details by ID | Bearer Key |
| `POST` | `/plans` | Create custom tenant plan | Bearer Key |
| `PATCH` | `/plans/:planId` | Update custom tenant plan limits | Bearer Key |
| `POST` | `/consumptions` | Atomic quota evaluation & deduction | Bearer Key |
| `GET` | `/account/usage` | Fetch account monthly usage & remaining allowance | Bearer Key |
| `GET` | `/users/:userId/usage` | Fetch user monthly usage & remaining allowance | Bearer Key |
| `GET` | `/requests` | Query consumption audit logs & history | Bearer Key |

For full request/response schemas, JSON payloads, HTTP headers, and error codes:
- **Complete API Contracts Specification:** [docs/part-01-api-contracts.md](docs/part-01-api-contracts.md)

---

## 13. Delivery & Security Audit Checklist

- [x] **Environment Configuration & Git Hygiene:** The local environment file `.env` is excluded by `.gitignore` and `.dockerignore`, `.env.example` contains only placeholder development credentials, and no API keys or database secrets are committed in git tracked files.
- [x] **Isolated Docker Environment:** Full stack runs autonomously via `docker compose up --build` with automatic health checks, isolated bridge network, and volume persistence.
- [x] **Database Isolation & Migration Safety:** Migrations execute on startup under PostgreSQL advisory locks (`MIGRATION_LOCK_ID = 424242`), ensuring safe parallel container launches.
- [x] **No Unused Entities:** No speculative `Resource` entity; consumption accurately measures generic units.
- [x] **Deterministic Concurrency:** Account-level row locks ensure consistency without balance drift.
- [x] **Verified Telemetry & Contracts:** All benchmark results and API specifications are documented in dedicated technical reports.

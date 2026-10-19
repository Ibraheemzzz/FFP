# Usage Metering Service - Performance & Load Benchmark Report

This document presents the official benchmark methodologies, experimental configurations, empirical measurements, database audits, and architectural conclusions for the **Usage Metering Service** (Part 29).

---

## 1. Executive Summary

A real-HTTP load benchmarking suite was developed to evaluate system throughput, latency percentiles, lock contention dynamics, quota exhaustion accuracy, and idempotent deduplication integrity under controlled concurrency.

### Key Benchmark Takeaways

| Scenario | Concurrency ($C$) | Total Requests | Avg Throughput (req/s) | Latency p50 (ms) | Avg p95 of Runs (ms) (متوسط p95 للجولات) | Latency p99 (ms) | DB Integrity Audit |
|---|---|---|---|---|---|---|---|
| **1. Single Account Under High Row-Lock Contention** | 15 | 600 reqs/run (1,800 across 3 runs) | **240.25** | 61.11 | 66.59 | 99.73 | **100% PASSED** (0 discrepancies) |
| **2. Multi-Tenant Parallelism** (10 Accounts) | 15 | 600 reqs/run (1,800 across 3 runs) | **653.19** | 22.27 | 30.53 | 35.61 | **100% PASSED** (0 discrepancies) |
| **3. Quota Exhaustion Transition** | 10 | 300 | **274.59** | 35.33 | 40.97 | 41.62 | **100% PASSED** (50 accepted, 250 rejected) |
| **4. Idempotent Deduplication Retries** | 15 | 500 | **617.22** | 21.74 | 40.59 | 50.29 | **100% PASSED** (10 units consumed total) |
| **5. In-Flight Plan Mutation Under Load** | 10 | 400 | **250.55** | 37.08 | 51.64 | 96.79 | **100% PASSED** (150 pre-upgrade rejected, 250 post-upgrade accepted) |

> **Important Notes on Metrics & Aggregation**:
> - For Scenarios 1 and 2, each individual run dispatched exactly 600 requests. Across 3 repeated runs, a total of 1,800 requests were processed.
> - The values in the table for Scenarios 1 and 2 represent the **arithmetic mean across the 3 independent runs**. Specifically, the column **Avg p95 of Runs (ms)** is the average of the run-level p95 figures ($\frac{68.25 + 68.32 + 63.20}{3} = 66.59\text{ ms}$), rather than a single pooled percentile across all 1,800 requests.

---

## 2. Experimental Environment & Configurations

All benchmarks were executed over real HTTP (`fetch`) against the live containerized Fastify service and PostgreSQL database.

### Hardware & Runtime Platforms
- **Host Machine**: Windows 10 Pro (x64, Build 19044)
- **Host CPU**: 11th Gen Intel(R) Core(TM) i5-11400H @ 2.70GHz (6 physical cores, 12 logical vCPUs)
- **Host Physical Memory**: 15.78 GB RAM
- **Load Generator Runtime**: Node.js `v24.13.0` running natively on the Windows host (`scripts/benchmark.ts`).
- **Backend Service Runtime**: Node.js `v22.x` running inside the Linux Alpine container (`node:22-alpine` as specified in `Dockerfile`), Fastify v5.x, TypeScript pre-compiled into `dist/src/`.
- **Database Engine**: PostgreSQL 16.15 on Linux Alpine (x86_64) running via Docker container (`postgres:16-alpine`).

### Network & Connection Topology
- **Service Endpoint**: `http://127.0.0.1:3000` (Docker published port forward).
- **Service Database Connection Pool**: Configured in `src/db.ts` via `createPool(config.DATABASE_URL)` with default `max: 10` client connections, connection timeout 5,000ms, and statement timeout 3,000ms.
- **Benchmark Audit Pool**: Separate lightweight `pg.Pool` instance with `max: 5` client connections, executed strictly after scenario load completion. Guaranteed closure inside `finally`.
- **Database Connection Decoupling**: The benchmark suite defaults directly to the containerized database port (`postgres://postgres:***@127.0.0.1:5434/usage_metering_dev`) or reads `BENCHMARK_DATABASE_URL`, leaving the local development `.env` file (`127.0.0.1:5433`) completely untouched.
- **HTTP Client**: Node.js native `fetch` over keep-alive HTTP/1.1 connections with a 5,000ms request timeout.
- **Tenant Isolation Principle**: Every benchmark run creates completely isolated, ephemeral test accounts and plans (prefixed with `test_bench_*`). No pre-existing development data is ever accessed or altered.

---

## 3. Methodology & Measurement Rigor

### Timing Isolation
To prevent misleading throughput or latency numbers:
1. **Provisioning Isolation**: Account registration, plan creation, plan assignment, and user onboarding are executed prior to timing initialization.
2. **Pre-flight Warmup**: 50 warm-up requests are executed against a dedicated warmup account (`Warmup Benchmark Account`) to prime JIT compilation, connection pools, and TCP socket pooling. This account is never queried in scenario audits.
3. **Strict Load Timing**: The measured clock (`performance.now()`) starts immediately before worker dispatch and halts only when all response bodies are completely read and parsed via `res.json()`.
4. **Post-Load DB Audit Isolation**: Comprehensive SQL audits querying `consumption_records`, `account_monthly_usage`, and `user_monthly_usage` execute after the measured time has stopped.

### Latency Percentiles Calculation
Latencies are recorded per request from request initiation to full payload stream consumption. Percentiles are calculated using the **Nearest-Rank Method**:
$$\text{Rank}(P) = \left\lceil \frac{P}{100} \times N \right\rceil$$
where $N$ is the total number of sorted latency samples. This guarantees that calculated p50, p95, and p99 metrics correspond directly to observed request latencies without interpolation distortion.

### Outcome Classification Matrix
In accordance with the service contract, quota evaluation is a business decision returned with `HTTP 200`:
- `accepted`: HTTP 200 with JSON payload where `decision.accepted === true`.
- `quotaRejected`: HTTP 200 with JSON payload where `decision.accepted === false` and a `reason` descriptor (e.g. `account.monthly_allowance`, `account.max_per_request`).
- `conflict`: HTTP 409 (e.g. `requestId` conflict with mismatched parameters).
- `clientError`: HTTP 4xx validation or not-found error (excluding 409), OR a malformed HTTP 200 response where `decision.accepted` is missing or not a boolean.
- `serverError`: HTTP 5xx internal server errors.
- `timeoutError`: Request aborted after exceeding the 5,000ms deadline.
- `networkError`: Connection dropped, reset, or socket error.

---

## 4. Scenario Breakdown & Empirical Results

### Scenario 1: Single Account Under High Row-Lock Contention
- **Objective**: Measure throughput and queueing latency when multiple concurrent workers contend for the exact same tenant row lock (`SELECT id FROM accounts WHERE id = $1 FOR UPDATE`).
- **Load**: 600 requests per run, Concurrency $C=15$, repeated across 3 independent runs (1,800 requests total).

```
Run 1: 236.09 req/s | p50: 62.46ms | p95: 68.25ms | p99: 90.61ms  | Audit: PASSED
Run 2: 234.39 req/s | p50: 61.39ms | p95: 68.32ms | p99: 143.20ms | Audit: PASSED
Run 3: 250.28 req/s | p50: 59.47ms | p95: 63.20ms | p99: 65.37ms  | Audit: PASSED
Summary (Mean): Avg Throughput: 240.25 req/s | Avg p50: 61.11ms | Avg p95 of Runs: 66.59ms | Avg p99: 99.73ms
```

**Database Audit Verification**:
- Ledgers Audited: 1 account per run.
- Verification:
  1. Found all expected accounts (count = 1).
  2. Total ledger accepted units = 600.
  3. Total account counter units = 600.
  4. Total user counter units = 600.
  5. Zero server, timeout, or network errors.
- Discrepancies: 0 (100% atomic consistency).

---

### Scenario 2: Multi-Tenant Parallelism (Uncontended Independent Accounts)
- **Objective**: Measure throughput and latency when requests are evenly distributed across 10 distinct tenant accounts under the exact same total load and concurrency.
- **Load**: 600 requests per run (60 reqs/account), Concurrency $C=15$, repeated across 3 independent runs (1,800 requests total).

```
Run 1: 644.61 req/s | p50: 22.39ms | p95: 31.37ms | p99: 38.69ms | Audit: PASSED
Run 2: 644.10 req/s | p50: 22.52ms | p95: 31.80ms | p99: 35.57ms | Audit: PASSED
Run 3: 670.85 req/s | p50: 21.89ms | p95: 28.41ms | p99: 32.56ms | Audit: PASSED
Summary (Mean): Avg Throughput: 653.19 req/s | Avg p50: 22.27ms | Avg p95 of Runs: 30.53ms | Avg p99: 35.61ms
```

**Comparison Analysis (Scenario 1 vs Scenario 2)**:
- **Throughput Multiplier**: $653.19 \text{ req/s} \div 240.25 \text{ req/s} = \mathbf{2.72\times}$ throughput increase under identical concurrency and request volume.
- **Queueing Latency (Avg p95 of Runs)**: Dropped from **66.59ms** to **30.53ms** ($\mathbf{54\%}$ latency reduction).
- **Nuanced Architectural Analysis**: In Scenario 1, all 15 concurrent workers contend for the identical account row lock, causing lock wait queueing. In Scenario 2, workers acquire locks across 10 distinct rows, allowing parallel transaction commits. However, multi-tenant accounts are **not fully decoupled in performance**: they still contend for the shared database connection pool (`max: 10`), PostgreSQL WAL write throughput, Node.js event loop scheduling, and host CPU/disk resources.

---

### Scenario 3: Quota Exhaustion Transition
- **Objective**: Verify that an account with a finite allowance transitions seamlessly from acceptance to rejection when the limit is breached, without race conditions or counter leakage.
- **Setup**: Account monthly quota limit = 100 units. Each request requests 2 units.
- **Load**: 300 requests, Concurrency $C=10$.
- **Expected Outcome**: Exactly 50 requests accepted ($50 \times 2 = 100$ units), exactly 250 requests rejected with HTTP 200 (`accepted: false`, `reason: "account.monthly_allowance"`).

```
Throughput: 274.59 req/s | p50: 35.33ms | p95: 40.97ms | p99: 41.62ms
Outcomes:   Accepted = 50 | Quota Rejected = 250 | Errors = 0
Audit:      PASSED (Account Counter = 100, User Counter = 100, Ledger Accepted Units = 100)
```

**Integrity Verification**:
- Zero over-quota units were ever granted.
- Zero rejected requests incremented `amu.total_units` or `umu.total_units`.
- Rejections were stored in `consumption_records` with `status = 'REJECTED'` and requested units excluded from cumulative counters.

---

### Scenario 4: High-Rate Idempotent Retries (Deduplication Path)
- **Objective**: Measure deduplication retrieval performance when replaying identical request IDs at high concurrency, verifying that counters remain completely invariant.
- **Setup**: 10 seed requests created with unique idempotency keys (`seed_s4_key_0` through `seed_s4_key_9`).
- **Load**: 500 requests (each of the 10 keys replayed 50 times), Concurrency $C=15$.

```
Throughput: 617.22 req/s | p50: 21.74ms | p95: 40.59ms | p99: 50.29ms
Outcomes:   Accepted = 500/500 (HTTP 200, accepted: true)
Audit:      PASSED (Ledger Accepted Units = 10, Account Counter = 10 units, User Counter = 10 units)
```

**Accurate Mechanics Analysis**:
- The request enters `withAccountLock`, opens a transaction (`BEGIN ISOLATION LEVEL READ COMMITTED`), and acquires the account row lock (`SELECT id FROM accounts WHERE id = $1 FOR UPDATE`).
- Inside the transaction, it checks `consumption_records` matching `(account_id, request_id)` via the unique constraint `uq_consumption_account_request`.
- Because the record exists and payload matches, it immediately returns the stored JSON decision.
- **Why it achieves ~617 req/s**: It does not bypass the transaction or row lock. Instead, it **drastically minimizes the critical section held under the lock**:
  1. No `users` lookup query.
  2. No `plans` retrieval queries (account plan and user plan).
  3. No `account_monthly_usage` and `user_monthly_usage` reads.
  4. No quota calculation logic.
  5. No `INSERT INTO consumption_records`.
  6. No `UPDATE` on `account_monthly_usage` or `user_monthly_usage`.
- Despite 500 requests processed, the database counter strictly preserved the invariant: **exactly 10 units consumed total**.

---

### Scenario 5: In-Flight Plan Mutation Under Concurrent Load
- **Objective**: Test plan upgrade concurrency while a live stream of consumption requests is actively executing under row lock contention (not two discrete sequential batches).
- **Setup**:
  - Initial Plan: `per_request_limit = 5 units`.
  - Upgraded Plan: `per_request_limit = 20 units`.
  - All requests demand `10 units`.
- **Load**: 400 requests, Concurrency $C=10$ worker pool.
- **Concurrency Dynamic & Causality Verification**:
  - While workers are actively dispatching consumption requests, worker task 150 initiates `PATCH /account/plan`.
  - Because `PATCH /account/plan` calls `withAccountLock` (`SELECT id FROM accounts WHERE id = $1 FOR UPDATE`), it contends for the exact same row lock as the concurrent `POST /consumptions` requests.
  - The script records `planUpdateCommitTime = Date.now()` the moment the upgrade transaction successfully commits.
  - **Dynamic Causality Audit**:
    1. Every request initiated strictly after `planUpdateCommitTime` is asserted to have `accepted === true`. In this run, 0 stale rejections occurred after the commit timestamp.
    2. Exactly 150 requests were rejected (prior to upgrade commit under limit 5).
    3. Exactly 250 requests were accepted (after upgrade commit under limit 20).
    4. Database ledger and counter audit verified exactly $250 \times 10 = 2,500$ units accumulated, matching accepted requests exactly.
    5. Zero unaccounted requests or unexpected errors.

```
Throughput: 250.55 req/s | p50: 37.08ms | p95: 51.64ms | p99: 96.79ms
Outcomes:   Pre-Upgrade Rejections = 150 (accepted: false)
            Post-Upgrade Acceptances = 250 (accepted: true)
Audit:      PASSED (Ledger Accepted Units = 2,500, Account Counter = 2,500, User Counter = 2,500)
```

---

## 5. Answers to Clarification Inquiries

1. **Request Counts and Table Aggregation**:
   - Each individual run in Scenarios 1 and 2 executed **600 requests**.
   - With 3 runs per scenario, a total of **1,800 requests** were processed for Scenario 1 and **1,800 requests** for Scenario 2.
   - The summary rows represent the **arithmetic mean** across the 3 independent runs. The p95 column is explicitly labeled as the **Average of Run p95s (متوسط p95 للجولات)**.

2. **Accounting Month Extraction**:
   - The accounting month is extracted **dynamically** in `scripts/benchmark.ts` via:
     ```typescript
     const yearMonth = new Date().toISOString().slice(0, 7);
     ```
   - In October 2026, it evaluated dynamically to `'2026-10'`, exactly matching the service's internal UTC clock. It is never hardcoded.

3. **Warmup Isolation**:
   - The warmup phase (50 requests) provisions a dedicated account (`Warmup Benchmark Account`) and user.
   - The scenario database audits strictly query `WHERE a.id = ANY($4::text[])` passing only the account IDs created within that scenario. The warmup account is never queried in scenario audits and cannot affect ledger expectations.

4. **In-Flight Plan Mutation Verification**:
   - The plan upgrade occurred **in-flight during active request processing**, with workers concurrently issuing consumption requests and contending for the row lock.
   - Timestamp causality checks verified that 100% of requests initiated after the plan update committed observed the upgraded limit.
   - Database counters strictly reflected $250 \times 10 = 2,500$ units, proving immediate and exact plan transition without stale caching or race conditions.

5. **Environment and Database Port Decoupling**:
   - The local development environment uses `DATABASE_URL` with port `5433` in `.env`.
   - The benchmark suite is decoupled via `BENCHMARK_DATABASE_URL`, defaulting directly to the containerized database port `5434`:
     ```typescript
     const databaseUrl = process.env.BENCHMARK_DATABASE_URL || 'postgres://postgres:postgres_password@127.0.0.1:5434/usage_metering_dev';
     ```
   - This ensures `.env` remains untouched at `5433` for standard development and tests.

---

## 6. What We Learned & Architectural Insights

1. **Row Lock Contention Dynamics**:
   When multiple concurrent requests target the same account, PostgreSQL serializes transactions on the row lock (`SELECT id FROM accounts WHERE id = $1 FOR UPDATE`). Under this specific test load ($C=15$), single-account throughput measured ~240 req/s.
2. **Multi-Tenant Parallelism vs Shared Resources**:
   Distributing identical request load across multiple distinct tenants avoids row-level contention, increasing throughput by $2.72\times$ (to ~653 req/s). However, tenants still share the Fastify event loop, the database connection pool (`max: 10`), the PostgreSQL WAL buffer, and host I/O. Multi-tenant throughput is therefore not infinitely scalable without expanding shared pool capacity and hardware resources.
3. **Idempotency Critical Section Optimization**:
   The idempotent replay path still acquires the account lock and transaction, but because it executes a single indexed read and avoids all business evaluation and writes, lock hold time is minimal, yielding ~617 req/s.
4. **Absolute Ledger Invariant Integrity**:
   Across all 9 benchmark runs and thousands of concurrent operations, the SQL audits detected **zero discrepancies** between `consumption_records`, `account_monthly_usage`, and `user_monthly_usage`.

---

## 7. Scope Limitations & Environmental Boundary

- **Fixed Concurrency Model**: Load was generated using a closed-loop worker pool of fixed concurrency ($C=10$ to $C=15$). Open-model Poisson arrivals or network jitter may alter tail latency distributions in production.
- **Single-Host Topology**: Both the client benchmark runner, the Fastify service container, and the PostgreSQL container ran on the same physical host machine. Network latency was sub-millisecond localhost loopback.
- **Workstation Benchmark**: These figures characterize the performance profile of the implementation on the tested workstation for a brief load duration. They do not constitute an SLA, capacity saturation limit, or production cluster guarantee.

---

## 8. How to Reproduce

Ensure Docker service and database are up:
```bash
docker compose up -d service
```

Run the automated benchmark suite:
```bash
npm run benchmark
```

Raw JSON telemetry is output to:
```bash
docs/benchmark-results.json
```

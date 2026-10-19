# Usage Metering and Quotas Service

A high-concurrency, multi-tenant usage metering and quota enforcement service built with **TypeScript**, **Fastify**, and **PostgreSQL**. The service enables SaaS platforms to evaluate, authorize, record, and audit quota consumption requests across accounts and individual users in real-time.

---

## Architecture & Guarantees

- **Atomic Transactions & Concurrency Control:** Enforces strict sequential processing across concurrent operations on the same account using PostgreSQL pessimistic row-level locking (`SELECT ... FOR UPDATE`).
- **Idempotency & Deduplication:** Re-submitting identical requests with the same `requestId` replays the original decision without duplicate counter deductions. Payload mismatches on the same `requestId` return `409 Conflict`.
- **Dynamic Balance Calculation:** Quota balances (`consumed` and `remaining`) are computed dynamically with non-negative flooring, preserving historical consumption across plan upgrades and downgrades.
- **Immutable Audit Trails:** Preserves immutable decision snapshots and plan limits at the time of each request via JSONB `decision_context` in `consumption_records`.
- **Autonomous Migrations:** Automatically executes schema migrations and seeds default plans upon service boot using PostgreSQL advisory locks (`MIGRATION_LOCK_ID`).

---

## Prerequisites

- **Docker & Docker Compose:** Docker Engine 24+ and Docker Compose v2.20+ (e.g. Docker Desktop or Docker inside WSL2 / Linux).
- **Node.js:** Node.js 22+ (for local development without Docker).

---

## Running with Docker Compose

### 1. Start the Full Stack (Automated Demo Mode)

Run the entire application stack (PostgreSQL, Backend Service, and Demo Client) with a single command:

```bash
docker compose up --build
```

#### Lifecycle & Startup Sequence:
1. **`postgres`:** Starts PostgreSQL 16 on an isolated bridge network with a persistent volume (`postgres_data`). Healthcheck verifies readiness via `pg_isready`.
2. **`service`:** Starts after PostgreSQL is healthy. Runs schema migrations (`001`, `002`, `003`), seeds default plans, and begins listening on `0.0.0.0:3000`. Healthcheck verifies readiness via `GET /health/ready`.
3. **`demo-client`:** Starts after the service is fully healthy. Executes the 7-step automated scenario (verifying account creation, plan assignments, allowed consumption, user quota rejection, account quota rejection, immediate plan upgrades, and audit logs) and exits cleanly with code `0`.
4. The `service` and `postgres` containers remain running and ready to accept API traffic.

---

### 2. Launching the Interactive Demo Client

To interact with the service using the interactive command-line interface (CLI), override the default automated demo command:

```bash
docker compose run --rm demo-client npm start
```

This attaches your terminal (TTY/stdin) directly to the interactive menu:

```text
──────────────────────────────────────────────────────────────────────
Active User: Ahmed (usr_...) | Plan: plan_default_user
Last Request: None
──────────────────────────────────────────────────────────────────────
1. Select user
2. Perform action
3. View usage and remaining allowance
4. Change plan settings
5. Run guided demo
0. Exit
```

---

### 3. Port Configuration & Avoiding Conflicts

By default, the services publish ports to the host as follows:
- **Backend Service HTTP API:** Port `3000` (mapped to host `3000`).
- **PostgreSQL Database:** Port `5432` internally, published to host `5434` by default to prevent port collisions with existing local PostgreSQL instances or standalone development containers running on port `5433` or `5432`.

To customize published host ports, specify environment variables or place them in an `.env` file:

```bash
# Example: Run service on port 3005 and postgres on port 5435
PORT=3005 POSTGRES_PORT=5435 docker compose up --build
```

---

### 4. Stopping the Stack & Data Persistence

#### Stop containers while preserving database state:
```bash
docker compose down
```
All accounts, users, plans, consumption records, and monthly counters remain persisted in the `postgres_data` volume across restarts.

#### Stop containers and wipe database state (Clean Slate):
```bash
docker compose down -v
```
Removes all containers, networks, and persistent data volumes for a fresh start.

---

## Local Development (Without Docker)

### 1. Install Dependencies
```bash
npm install
npm --prefix demo-client install
```

### 2. Configure Environment
Create a `.env` file in the root directory:
```env
PORT=3000
HOST=127.0.0.1
DATABASE_URL=postgres://postgres:postgres_password@127.0.0.1:5433/usage_metering_dev
```

### 3. Build & Run Tests
```bash
# Compile TypeScript
npm run build

# Run all 26 automated test suites (Service + Demo Client)
npm test
```

### 4. Run Service Locally
```bash
npm run dev
```

### 5. Run Demo Client Locally
```bash
# Automated guided scenario
npm run demo

# Interactive menu
npm --prefix demo-client start
```

---

## API Summary

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `GET` | `/health` | Liveness health check | Public |
| `GET` | `/health/ready` | Readiness check with DB connectivity | Public |
| `POST` | `/accounts` | Register tenant account & issue API key | Public |
| `GET` | `/account/me` | Fetch authenticated account profile | Bearer API Key |
| `PATCH` | `/account/plan` | Update account plan assignment | Bearer API Key |
| `POST` | `/users` | Create user under authenticated account | Bearer API Key |
| `GET` | `/users/:userId` | Get user details | Bearer API Key |
| `PATCH` | `/users/:userId/plan` | Update user plan assignment | Bearer API Key |
| `GET` | `/plans` | List accessible default & custom plans | Bearer API Key |
| `POST` | `/plans` | Create tenant custom plan | Bearer API Key |
| `PATCH` | `/plans/:planId` | Update tenant custom plan limits | Bearer API Key |
| `POST` | `/consumptions` | Atomic quota evaluation & deduction | Bearer API Key |
| `GET` | `/account/usage` | Get current or historical account usage | Bearer API Key |
| `GET` | `/users/:userId/usage` | Get current or historical user usage | Bearer API Key |
| `GET` | `/requests` | Query consumption audit logs & history | Bearer API Key |

---

## Performance & Load Benchmarks

The project includes an automated, real-HTTP load testing suite that evaluates system throughput, latency percentiles (p50, p95, p99), row-lock contention, quota boundary behavior, and idempotent deduplication integrity.

### Running Benchmarks
With Docker services running (`docker compose up -d service`):
```bash
npm run benchmark
```

- **Detailed Benchmark Report**: See [docs/part-02-performance-benchmarks.md](docs/part-02-performance-benchmarks.md)
- **Raw JSON Telemetry**: See [docs/benchmark-results.json](docs/benchmark-results.json)


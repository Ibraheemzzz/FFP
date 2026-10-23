# Standalone Web Client (`client/`)

A modular, zero-dependency interactive web client and live HTTP protocol inspector for the Usage Metering & Quotas Service.

## Architecture

The client is completely decoupled from the core backend service:
- The core service in `src/` requires zero modifications, extra routes, or CORS plugins.
- Static assets and proxy logic reside strictly within `client/`.
- All UI labels, documentation, code, and test messages are 100% in English.

### Files Overview

- **`index.html`**: Clean semantic HTML5 structure providing user interfaces for accounts, plans, users, consumption testing, and the live HTTP inspector.
- **`style.css`**: Dark-mode CSS styling with responsive grid layouts, card containers, status badges, and syntax-highlighted code panels.
- **`app.js`**: Vanilla JavaScript client logic handling API requests, automatic user ID capture, one-click educational scenarios, and real-time HTTP message inspection.
- **`server.ts`**: Lightweight standalone server (using standard Node.js built-ins) serving static client assets on port `4000` and reverse-proxying `/api/*` requests to the backend service.
- **`Dockerfile`**: Container definition for building and executing the web client in Docker Compose.
- **`tests/client.test.ts`**: Comprehensive test suite verifying client asset integrity, English localization, static server delivery, and end-to-end API proxy workflows.

---

## Running the Web Client

### Option 1: Via npm (Local Development)

```bash
# Ensure the backend service is running (npm run dev or docker compose up -d)
npm run client
```

Navigate to [http://localhost:4000](http://localhost:4000) in your web browser.

### Option 2: Via Docker Compose

```bash
docker compose up client
```

The web console will be accessible at [http://localhost:4000](http://localhost:4000) while communicating with `http://service:3000` over the internal Docker network.

---

## Features

1. **Account Registration & Authentication**: Generate isolated accounts, view profile credentials, and inspect Bearer API keys.
2. **Plan CRUD, Details & Assignments**: Define custom plans, inspect individual plans by ID (`GET /plans/:id`), modify limits, and bind plans to accounts.
3. **User Management & Profile Lookup**: Register users with assigned plans, inspect user profiles by ID (`GET /users/:id`), and reassign user plans.
4. **Current & Historical Balances**: Query current monthly allowances with remaining balances, or inspect closed historical months (`?month=YYYY-MM`) with consumed totals and last request context.
5. **Request History Audit Ledger with Filters & Pagination**: Search recorded consumption requests with filters for `userId`, `status` (`ACCEPTED` / `REJECTED`), and `month`, with configurable page sizes and `Next` / `Previous` offset navigation (`hasMore`).
6. **Quota Playground & Educational Scenarios**:
   - **Scenario 1 (Accept)**: Standard consumption request within limits.
   - **Scenario 2 (User Cap)**: Request exceeding the user per-request limit (`user / max_per_request`).
   - **Scenario 3 (User Monthly Limit)**: Request exceeding user monthly allowance (`user / monthly_allowance`).
   - **Scenario 4 (Account Monthly Limit)**: Request exceeding account monthly allowance (`account / monthly_allowance`).
   - **Scenario 5 (Idempotency Replay)**: Restores original request payload (`userId`, `units`, `requestId`) to verify guaranteed zero double-deductions.
7. **Live HTTP Protocol Inspector**: Inspect raw HTTP request headers, method paths, request bodies, response headers, response latency timers, and status badges, with default API key masking.

# Standalone Usage Metering Demo Client
## Part 27 Implementation Documentation & Run Instructions

An independent subproject located within `demo-client/`, with its own dedicated `package.json`, `tsconfig.json`, and dependencies. It simulates an external client (SaaS application) integrating with the Usage Metering and Quotas Service purely via standard HTTP REST API without any direct database coupling or internal service imports.

---

## 1. Demo Objectives & Scenarios

Demonstrates real-world integration across the 7 mandatory business requirements:

1. **Account Registration & Session Storage:** Registers a new account, extracts the issued secret API key, and stores it in session state without printing or leaking secrets to stdout. Authentication is verified via `GET /account/me`.
2. **Initial Multi-User Plan Setup:**
   - Account plan configured from the beginning via `PATCH /account/plan` with `monthlyLimit: 10` and `perRequestLimit: 20`.
   - User 1 (**Ahmed**) assigned the default public plan (`plan_default_user`).
   - User 2 (**Sara**) assigned a custom restricted plan (`monthlyLimit: 30`, `perRequestLimit: 5`).
3. **Acceptance Scenario (`POST /consumptions`):** Ahmed consumes 2 units within limits $\rightarrow$ Accepted (`accepted: true`). Counters update atomically: Ahmed = 2, Account = 2 (remaining: 8).
4. **User-Level Quota Rejection (`POST /consumptions`):** Sara attempts to consume 6 units with her limit at 5 $\rightarrow$ Rejected with `{ "scope": "user", "rule": "max_per_request" }`. Zero units deducted (Sara = 0, Account = 2).
5. **Account-Level Quota Rejection (`POST /consumptions`):** Ahmed requests 9 units when shared account remaining is 8 $\rightarrow$ Rejected with `{ "scope": "account", "rule": "monthly_allowance" }`. Zero units deducted (Ahmed = 2, Account = 2).
6. **Dynamic Plan Elevation & Retry (`PATCH /plans/:planId`):** Sara's plan is updated via API to `perRequestLimit: 10`. Her request of 6 units is re-sent with a new `requestId` $\rightarrow$ Accepted immediately without restarting the server. Counters update: Sara = 6 (remaining: 24), Account = 8 (remaining: 2).
7. **Strict Balance & Audit Verification:** Final balances are verified: Account = 8 (remaining: 2), Ahmed = 2, Sara = 6. Complete request audit history inspected via `GET /requests`.

---

## 2. Prerequisites

- **Node.js** (v20.12+ or v22+)
- Running Usage Metering backend service (defaults to `http://127.0.0.1:3000`)

---

## 3. Execution Modes & Running the Demo Client

The demo client provides two operational modes: an **Interactive CLI Mode** for simulated business actions and plan adjustments, and an **Automated Guided Demo** for test automation and containerized environments.

### Step 1: Start the Backend Service (in a separate terminal)
From the project root (`d:\FFP`):
```bash
npm run dev
```

### Step 2: Choose Execution Mode

#### Mode 1: Interactive CLI Menu (Requires TTY Terminal)
Simulates a SaaS company performing actions on behalf of users, verifying quota responses, replaying requests for idempotency, and adjusting plans dynamically:
```bash
# From demo-client directory:
npm start

# Or from project root:
npm --prefix demo-client start
```

**Interactive Menu Options:**
```text
1. Select user                        # Switch active user between Ahmed and Sara
2. Perform action                      # Consume units, simulate business action, or retry previous request
3. View usage and remaining allowance  # Inspect GET /account/usage and GET /users/:userId/usage
4. Change plan settings                # Dynamically update account or user limits (creates custom plan if public)
5. Run guided demo                     # Execute complete 7-step scenario in an independent account
0. Exit                                # Terminate interactive session gracefully
```

**Key Interactive Features:**
- **Action Simulation:** If accepted by the service, prints `Action completed` and updates local action state. If rejected, prints the exact reason and prevents local action execution.
- **Pre-Flight Request Saving & Idempotent Retry:** Every request is saved in memory before sending. Replaying with `r` retains the original requester and units, even after switching users, and avoids duplicate execution if already completed locally.
- **Dynamic Plan Elevation:** Ahmed is on a public read-only plan (`plan_default_user`). Modifying his plan automatically creates a custom user plan and assigns it via `PATCH /users/:userId/plan`. Sara's custom plan is updated directly via `PATCH /plans/:planId`.
- **Session Isolation:** Running Option 5 (Guided Demo) provisions an isolated account, leaving your interactive session counters and plan states untouched.

#### Mode 2: Automated Guided Demo (For Docker / CI / Automated Testing)
Runs the full 7-step verified scenario without requiring user interaction:
```bash
# From project root:
npm run demo

# From demo-client directory:
npm run demo
# or:
npm start -- --demo
```

### Non-Interactive (TTY-less) Environment Handling
When `npm start` is invoked in an environment where `!process.stdin.isTTY` (such as non-interactive Docker containers or CI pipelines):
- The client prevents unexpected hangs or accidental account creation.
- It displays clear instructions and exits with code `1`:
  ```text
  Error: Interactive mode requires an interactive TTY terminal.
  To run the automated guided demo in non-interactive environments (e.g. Docker/CI), use:
    npm start -- --demo  (or: npm run demo)
  ```
- Containerized and automated runners should explicitly pass `--demo` (or use `npm run demo`).

#### Customizing the Service URL (Optional)
If running on a different port or host:
```bash
API_BASE_URL=http://127.0.0.1:8080 npm start
```

---

## 4. Running the Integration Tests

To execute the automated end-to-end integration test suite verifying all invariants:

From project root:
```bash
npm test
```

From inside `demo-client/`:
```bash
npm test
```

To run TypeScript static type-checking on the demo client:
```bash
npm run build
```

---

## 5. Directory Structure

```text
demo-client/
├── package.json          # Subproject manifest, scripts, and dependencies
├── tsconfig.json         # Independent TypeScript compiler configuration
├── README.md             # Documentation and execution instructions
├── src/
│   ├── client.ts         # MeteringHttpClient wrapper utilizing native fetch
│   ├── index.ts          # CLI launcher, TTY detection, and automated guided scenario
│   └── menu.ts           # Interactive readline CLI menu and session state
└── tests/
    └── demo.test.ts      # Automated integration test suite
```

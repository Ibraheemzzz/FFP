import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import pg from 'pg';

interface BenchmarkRunResult {
  scenarioId: string;
  scenarioName: string;
  runIndex: number;
  totalRequests: number;
  concurrency: number;
  durationMs: number;
  throughputReqSec: number;
  latencies: {
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
  };
  outcomes: {
    accepted: number;
    quotaRejected: number;
    conflict: number;
    clientError: number;
    serverError: number;
    timeoutError: number;
    networkError: number;
  };
  audit: {
    passed: boolean;
    accountsAudited: number;
    totalLedgerUnits: number;
    totalAccountCounterUnits: number;
    totalUserCounterUnits: number;
    discrepancies: string[];
  };
}

interface BenchmarkSuiteOutput {
  metadata: {
    timestamp: string;
    targetUrl: string;
    environment: {
      platform: string;
      osRelease: string;
      cpuModel: string;
      cpuCores: number;
      totalMemoryGb: number;
      benchmarkClientNodeVersion: string;
      serviceContainerNodeVersion: string;
      postgresVersion: string;
    };
    percentileMethod: string;
  };
  summary: {
    totalScenarios: number;
    totalRuns: number;
    allAuditsPassed: boolean;
  };
  scenarios: Record<
    string,
    {
      name: string;
      description: string;
      runs: BenchmarkRunResult[];
      aggregate: {
        avgThroughputReqSec: number;
        avgP50LatencyMs: number;
        avgP95LatencyMs: number;
        avgP99LatencyMs: number;
      };
    }
  >;
}

interface SingleRequestOutcome {
  latencyMs: number;
  status: number;
  decisionAccepted?: boolean;
  rejectionReason?: { scope: string; rule: string };
  isConflict: boolean;
  isClientError: boolean;
  isServerError: boolean;
  isTimeout: boolean;
  isNetworkError: boolean;
  timestamp: number;
}

/**
 * Computes exact percentile using the Nearest-Rank Method
 */
function calculatePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.max(0, Math.min(rank - 1, sorted.length - 1));
  return Number(sorted[index].toFixed(2));
}

/**
 * Executes tasks concurrently with a bounded worker pool
 */
async function runConcurrentWorkers<T>(
  totalTasks: number,
  concurrency: number,
  taskFn: (index: number) => Promise<T>
): Promise<T[]> {
  const results: T[] = new Array(totalTasks);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < totalTasks) {
      const idx = nextIndex++;
      results[idx] = await taskFn(idx);
    }
  }

  const workerPromises = Array.from({ length: Math.min(concurrency, totalTasks) }, () => worker());
  await Promise.all(workerPromises);
  return results;
}

/**
 * Sends a single consumption request over real HTTP and measures latency strictly
 */
async function sendConsumptionRequest(
  baseUrl: string,
  apiKey: string,
  userId: string,
  units: number,
  requestId: string,
  timeoutMs = 5000
): Promise<SingleRequestOutcome> {
  const t0 = performance.now();
  const timestamp = Date.now();

  try {
    const res = await fetch(`${baseUrl}/consumptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ userId, units, requestId }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const t1 = performance.now();
    const latencyMs = Number((t1 - t0).toFixed(2));

    const status = res.status;
    const isConflict = status === 409;
    const isClientError = status >= 400 && status < 500 && !isConflict;
    const isServerError = status >= 500;
    const decisionAccepted = typeof data.accepted === 'boolean' ? data.accepted : undefined;
    const rejectionReason = data.reason as { scope: string; rule: string } | undefined;

    return {
      latencyMs,
      status,
      decisionAccepted,
      rejectionReason,
      isConflict,
      isClientError,
      isServerError,
      isTimeout: false,
      isNetworkError: false,
      timestamp,
    };
  } catch (err: unknown) {
    const t1 = performance.now();
    const latencyMs = Number((t1 - t0).toFixed(2));
    const isTimeout =
      (err instanceof Error && err.name === 'TimeoutError') ||
      (err instanceof Error && err.name === 'AbortError');

    return {
      latencyMs,
      status: 0,
      isConflict: false,
      isClientError: false,
      isServerError: false,
      isTimeout,
      isNetworkError: !isTimeout,
      timestamp,
    };
  }
}

/**
 * Helpers to provision benchmark entities
 */
async function createBenchmarkAccount(
  baseUrl: string,
  name: string
): Promise<{ accountId: string; apiKey: string }> {
  const res = await fetch(`${baseUrl}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`Failed to create benchmark account '${name}': HTTP ${res.status}`);
  }
  const data = (await res.json()) as { id: string; apiKey: string };
  return { accountId: data.id, apiKey: data.apiKey };
}

async function createBenchmarkPlan(
  baseUrl: string,
  apiKey: string,
  type: 'ACCOUNT' | 'USER',
  monthlyLimit: number,
  perRequestLimit: number
): Promise<string> {
  const res = await fetch(`${baseUrl}/plans`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      name: `Benchmark Plan ${Date.now()}`,
      type,
      monthlyLimit,
      perRequestLimit,
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`Failed to create benchmark plan: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}

async function updateAccountPlan(
  baseUrl: string,
  apiKey: string,
  planId: string
): Promise<void> {
  const res = await fetch(`${baseUrl}/account/plan`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ planId }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`Failed to update account plan: HTTP ${res.status}`);
  }
}

async function createBenchmarkUser(
  baseUrl: string,
  apiKey: string,
  planId?: string
): Promise<string> {
  const res = await fetch(`${baseUrl}/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(planId ? { planId } : {}),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`Failed to create benchmark user: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}

/**
 * Audits PostgreSQL directly for the specific benchmark accounts and month
 */
async function auditBenchmarkAccounts(
  pool: pg.Pool,
  accountIds: string[],
  yearMonth: string,
  expectedTotalUnits?: number
): Promise<{
  passed: boolean;
  accountsAudited: number;
  totalLedgerUnits: number;
  totalAccountCounterUnits: number;
  totalUserCounterUnits: number;
  discrepancies: string[];
}> {
  const [yearStr, monthStr] = yearMonth.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));

  const query = `
    SELECT
      a.id AS account_id,
      COALESCE(amu.total_units, 0) AS account_counter_units,
      COALESCE((
        SELECT SUM(cr.requested_units)
        FROM consumption_records cr
        WHERE cr.account_id = a.id
          AND cr.status = 'ACCEPTED'
          AND cr.processed_at >= $2 AND cr.processed_at < $3
      ), 0) AS ledger_accepted_units,
      COALESCE((
        SELECT SUM(umu.total_units)
        FROM user_monthly_usage umu
        WHERE umu.account_id = a.id AND umu.year_month = $1
      ), 0) AS user_counter_sum_units
    FROM accounts a
    LEFT JOIN account_monthly_usage amu ON amu.account_id = a.id AND amu.year_month = $1
    WHERE a.id = ANY($4::text[]);
  `;

  const res = await pool.query<{
    account_id: string;
    account_counter_units: string | number;
    ledger_accepted_units: string | number;
    user_counter_sum_units: string | number;
  }>(query, [yearMonth, start.toISOString(), end.toISOString(), accountIds]);

  const discrepancies: string[] = [];
  let totalLedgerUnits = 0;
  let totalAccountCounterUnits = 0;
  let totalUserCounterUnits = 0;

  // 1. Verify that all expected accounts were actually found in the database
  if (res.rows.length !== accountIds.length) {
    discrepancies.push(
      `Audited account count mismatch: Expected ${accountIds.length} accounts, found ${res.rows.length} in database`
    );
  }

  for (const row of res.rows) {
    const ledger = Number(row.ledger_accepted_units);
    const accCounter = Number(row.account_counter_units);
    const usrSum = Number(row.user_counter_sum_units);

    totalLedgerUnits += ledger;
    totalAccountCounterUnits += accCounter;
    totalUserCounterUnits += usrSum;

    if (ledger !== accCounter) {
      discrepancies.push(
        `Account ${row.account_id}: Ledger accepted units (${ledger}) != Account counter (${accCounter})`
      );
    }
    if (accCounter !== usrSum) {
      discrepancies.push(
        `Account ${row.account_id}: Account counter (${accCounter}) != Sum of user counters (${usrSum})`
      );
    }
  }

  // 2. If expected total units is specified, assert that the database actually recorded that amount
  // (guards against false pass where both ledger and counter are 0 despite expected acceptances)
  if (expectedTotalUnits !== undefined && totalAccountCounterUnits !== expectedTotalUnits) {
    discrepancies.push(
      `Total consumed units mismatch: Expected ${expectedTotalUnits} units, but found ${totalAccountCounterUnits} units in database`
    );
  }

  return {
    passed: discrepancies.length === 0,
    accountsAudited: res.rows.length,
    totalLedgerUnits,
    totalAccountCounterUnits,
    totalUserCounterUnits,
    discrepancies,
  };
}

/**
 * Aggregates benchmark outcomes and latencies, asserting against expected outcomes and unexpected errors
 */
function compileRunResult(
  scenarioId: string,
  scenarioName: string,
  runIndex: number,
  concurrency: number,
  durationMs: number,
  outcomes: SingleRequestOutcome[],
  audit: {
    passed: boolean;
    accountsAudited: number;
    totalLedgerUnits: number;
    totalAccountCounterUnits: number;
    totalUserCounterUnits: number;
    discrepancies: string[];
  },
  expected?: {
    expectedAccepted?: number;
    expectedQuotaRejected?: number;
    allowClientErrors?: boolean;
    allowConflicts?: boolean;
  }
): BenchmarkRunResult {
  const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
  const totalRequests = outcomes.length;
  const throughputReqSec = Number(((totalRequests / (durationMs / 1000)) || 0).toFixed(2));

  let accepted = 0;
  let quotaRejected = 0;
  let conflict = 0;
  let clientError = 0;
  let serverError = 0;
  let timeoutError = 0;
  let networkError = 0;
  let latencySum = 0;

  for (const o of outcomes) {
    latencySum += o.latencyMs;
    if (o.status === 200 && o.decisionAccepted === true) accepted++;
    else if (o.status === 200 && o.decisionAccepted === false) quotaRejected++;
    else if (o.status === 200 && o.decisionAccepted === undefined) clientError++; // Missing or non-boolean decision
    else if (o.isConflict) conflict++;
    else if (o.isClientError) clientError++;
    else if (o.isServerError) serverError++;
    else if (o.isTimeout) timeoutError++;
    else if (o.isNetworkError) networkError++;
  }

  // Outcome assertions
  if (expected?.expectedAccepted !== undefined && accepted !== expected.expectedAccepted) {
    audit.passed = false;
    audit.discrepancies.push(
      `Accepted count mismatch: Expected ${expected.expectedAccepted}, got ${accepted}`
    );
  }
  if (expected?.expectedQuotaRejected !== undefined && quotaRejected !== expected.expectedQuotaRejected) {
    audit.passed = false;
    audit.discrepancies.push(
      `Quota rejected count mismatch: Expected ${expected.expectedQuotaRejected}, got ${quotaRejected}`
    );
  }
  if (serverError > 0) {
    audit.passed = false;
    audit.discrepancies.push(`Unexpected server errors: ${serverError}`);
  }
  if (timeoutError > 0) {
    audit.passed = false;
    audit.discrepancies.push(`Unexpected timeout errors: ${timeoutError}`);
  }
  if (networkError > 0) {
    audit.passed = false;
    audit.discrepancies.push(`Unexpected network errors: ${networkError}`);
  }
  if (clientError > 0 && !expected?.allowClientErrors) {
    audit.passed = false;
    audit.discrepancies.push(`Unexpected client errors: ${clientError}`);
  }
  if (conflict > 0 && !expected?.allowConflicts) {
    audit.passed = false;
    audit.discrepancies.push(`Unexpected conflicts: ${conflict}`);
  }

  const avg = Number((latencySum / totalRequests).toFixed(2));
  const min = latencies[0] ?? 0;
  const max = latencies[latencies.length - 1] ?? 0;
  const p50 = calculatePercentile(latencies, 50);
  const p95 = calculatePercentile(latencies, 95);
  const p99 = calculatePercentile(latencies, 99);

  return {
    scenarioId,
    scenarioName,
    runIndex,
    totalRequests,
    concurrency,
    durationMs: Number(durationMs.toFixed(2)),
    throughputReqSec,
    latencies: { min, max, avg, p50, p95, p99 },
    outcomes: {
      accepted,
      quotaRejected,
      conflict,
      clientError,
      serverError,
      timeoutError,
      networkError,
    },
    audit,
  };
}

// ============================================================================
// MAIN BENCHMARK ORCHESTRATION
// ============================================================================

async function runBenchmarkSuite(): Promise<void> {
  const baseUrl = process.env.SERVICE_URL || 'http://127.0.0.1:3000';
  const databaseUrl =
    process.env.BENCHMARK_DATABASE_URL ||
    'postgres://postgres:postgres_password@127.0.0.1:5434/usage_metering_dev';
  const yearMonth = new Date().toISOString().slice(0, 7);

  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('  Usage Metering Service - Automated Performance & Load Benchmark (Part 29)');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log(`Target Service:  ${baseUrl}`);
  console.log(`Postgres Target: ${databaseUrl.replace(/:([^:@]+)@/, ':***@')}`);
  console.log(`Accounting Month:${yearMonth}`);
  console.log(`OS:              ${os.type()} ${os.release()} (${os.arch()})`);
  console.log(`CPU:             ${os.cpus()[0]?.model} (${os.cpus().length} vCPUs)`);
  console.log(`RAM:             ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log(`Client Node:     ${process.version} (Host load generator on Windows)`);
  console.log(`Service Node:    v22.x (Docker container node:22-alpine)`);
  console.log('───────────────────────────────────────────────────────────────────────────\n');

  // Verify service readiness
  const healthRes = await fetch(`${baseUrl}/health/ready`).catch(() => null);
  if (!healthRes || !healthRes.ok) {
    console.error('✖ Benchmark failed: Target service is not reachable or not ready at /health/ready.');
    process.exit(1);
  }

  // Create audit pool with guaranteed closure inside finally
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });

  const suiteOutput: BenchmarkSuiteOutput = {
    metadata: {
      timestamp: new Date().toISOString(),
      targetUrl: baseUrl,
      environment: {
        platform: os.platform(),
        osRelease: os.release(),
        cpuModel: os.cpus()[0]?.model ?? 'Unknown',
        cpuCores: os.cpus().length,
        totalMemoryGb: Number((os.totalmem() / 1024 / 1024 / 1024).toFixed(2)),
        benchmarkClientNodeVersion: process.version,
        serviceContainerNodeVersion: 'v22.x (Docker node:22-alpine container)',
        postgresVersion: '',
      },
      percentileMethod: 'Nearest-Rank Method on fully resolved request latencies',
    },
    summary: {
      totalScenarios: 5,
      totalRuns: 0,
      allAuditsPassed: true,
    },
    scenarios: {},
  };

  try {
    const pgVerRes = await pool.query<{ version: string }>('SELECT version()');
    suiteOutput.metadata.environment.postgresVersion = pgVerRes.rows[0].version;

    // Warmup phase (50 requests to warm up JIT, pool, sockets; excluded from timing)
    console.log('▶ Pre-flight Warmup (50 requests on dedicated warmup account)...');
    const warmupAccount = await createBenchmarkAccount(baseUrl, 'Warmup Benchmark Account');
    const warmupUser = await createBenchmarkUser(baseUrl, warmupAccount.apiKey);
    await runConcurrentWorkers(50, 10, (i) =>
      sendConsumptionRequest(
        baseUrl,
        warmupAccount.apiKey,
        warmupUser,
        1,
        `warmup_req_${Date.now()}_${i}`
      )
    );
    console.log('✔ Warmup completed successfully.\n');

    // --------------------------------------------------------------------------
    // Scenario 1: Single Account Under High Row-Lock Contention
    // --------------------------------------------------------------------------
    {
      const scenarioId = 'scenario_1_single_account';
      const scenarioName = 'Single Account Under High Row-Lock Contention';
      const scenarioDesc =
        'Measures throughput and queueing latency when multiple concurrent workers contend for the same tenant row lock.';
      console.log(`▶ Scenario 1: ${scenarioName} (3 Repeated Runs)`);

      const runs: BenchmarkRunResult[] = [];
      const N = 600;
      const C = 15;

      for (let run = 1; run <= 3; run++) {
        // Exclude setup time from measured interval
        const account = await createBenchmarkAccount(baseUrl, `S1 Account Run ${run}`);
        const planId = await createBenchmarkPlan(baseUrl, account.apiKey, 'ACCOUNT', 1000000, 10000);
        await updateAccountPlan(baseUrl, account.apiKey, planId);
        const user = await createBenchmarkUser(baseUrl, account.apiKey);

        // Measure isolated load duration
        const tStart = performance.now();
        const outcomes = await runConcurrentWorkers(N, C, (i) =>
          sendConsumptionRequest(
            baseUrl,
            account.apiKey,
            user,
            1,
            `req_s1_r${run}_${Date.now()}_${i}`
          )
        );
        const tEnd = performance.now();
        const durationMs = tEnd - tStart;

        // Audit DB with strict verification of expected units (600)
        const audit = await auditBenchmarkAccounts(pool, [account.accountId], yearMonth, N);
        const runResult = compileRunResult(
          scenarioId,
          scenarioName,
          run,
          C,
          durationMs,
          outcomes,
          audit,
          { expectedAccepted: N, expectedQuotaRejected: 0 }
        );

        if (!runResult.audit.passed) suiteOutput.summary.allAuditsPassed = false;
        runs.push(runResult);
        suiteOutput.summary.totalRuns++;

        console.log(
          `  Run ${run}/3: ${runResult.throughputReqSec} req/s | p50: ${runResult.latencies.p50}ms | p95: ${runResult.latencies.p95}ms | p99: ${runResult.latencies.p99}ms | Audit: ${runResult.audit.passed ? 'PASSED' : 'FAILED'}`
        );
      }

      const avgThroughput = Number(
        (runs.reduce((acc, r) => acc + r.throughputReqSec, 0) / runs.length).toFixed(2)
      );
      const avgP50 = Number(
        (runs.reduce((acc, r) => acc + r.latencies.p50, 0) / runs.length).toFixed(2)
      );
      const avgP95 = Number(
        (runs.reduce((acc, r) => acc + r.latencies.p95, 0) / runs.length).toFixed(2)
      );
      const avgP99 = Number(
        (runs.reduce((acc, r) => acc + r.latencies.p99, 0) / runs.length).toFixed(2)
      );

      suiteOutput.scenarios[scenarioId] = {
        name: scenarioName,
        description: scenarioDesc,
        runs,
        aggregate: {
          avgThroughputReqSec: avgThroughput,
          avgP50LatencyMs: avgP50,
          avgP95LatencyMs: avgP95,
          avgP99LatencyMs: avgP99,
        },
      };
      console.log(`  ✔ Scenario 1 Summary: Avg Throughput: ${avgThroughput} req/s | Avg p95 of Runs: ${avgP95}ms\n`);
    }

    // --------------------------------------------------------------------------
    // Scenario 2: Multi-Tenant Parallelism (Uncontended Independent Accounts)
    // --------------------------------------------------------------------------
    {
      const scenarioId = 'scenario_2_multi_tenant';
      const scenarioName = 'Multi-Tenant Parallelism (Multiple Independent Accounts)';
      const scenarioDesc =
        'Measures throughput and latency across multiple distinct tenant accounts with identical total requests and concurrency, sharing pool resources without row-lock contention.';
      console.log(`▶ Scenario 2: ${scenarioName} (3 Repeated Runs)`);

      const runs: BenchmarkRunResult[] = [];
      const N = 600;
      const C = 15;
      const TENANT_COUNT = 10;

      for (let run = 1; run <= 3; run++) {
        // Setup 10 accounts and users outside measured timing
        const tenants: Array<{ accountId: string; apiKey: string; userId: string }> = [];
        for (let t = 0; t < TENANT_COUNT; t++) {
          const acc = await createBenchmarkAccount(baseUrl, `S2 Tenant ${t} Run ${run}`);
          const pId = await createBenchmarkPlan(baseUrl, acc.apiKey, 'ACCOUNT', 1000000, 10000);
          await updateAccountPlan(baseUrl, acc.apiKey, pId);
          const usr = await createBenchmarkUser(baseUrl, acc.apiKey);
          tenants.push({ accountId: acc.accountId, apiKey: acc.apiKey, userId: usr });
        }

        // Distribute tasks across tenants
        const tStart = performance.now();
        const outcomes = await runConcurrentWorkers(N, C, (i) => {
          const tenant = tenants[i % TENANT_COUNT];
          return sendConsumptionRequest(
            baseUrl,
            tenant.apiKey,
            tenant.userId,
            1,
            `req_s2_r${run}_${Date.now()}_${i}`
          );
        });
        const tEnd = performance.now();
        const durationMs = tEnd - tStart;

        // Audit DB with strict verification of all 10 accounts and expected units (600)
        const audit = await auditBenchmarkAccounts(
          pool,
          tenants.map((t) => t.accountId),
          yearMonth,
          N
        );
        const runResult = compileRunResult(
          scenarioId,
          scenarioName,
          run,
          C,
          durationMs,
          outcomes,
          audit,
          { expectedAccepted: N, expectedQuotaRejected: 0 }
        );

        if (!runResult.audit.passed) suiteOutput.summary.allAuditsPassed = false;
        runs.push(runResult);
        suiteOutput.summary.totalRuns++;

        console.log(
          `  Run ${run}/3: ${runResult.throughputReqSec} req/s | p50: ${runResult.latencies.p50}ms | p95: ${runResult.latencies.p95}ms | p99: ${runResult.latencies.p99}ms | Audit: ${runResult.audit.passed ? 'PASSED' : 'FAILED'}`
        );
      }

      const avgThroughput = Number(
        (runs.reduce((acc, r) => acc + r.throughputReqSec, 0) / runs.length).toFixed(2)
      );
      const avgP50 = Number(
        (runs.reduce((acc, r) => acc + r.latencies.p50, 0) / runs.length).toFixed(2)
      );
      const avgP95 = Number(
        (runs.reduce((acc, r) => acc + r.latencies.p95, 0) / runs.length).toFixed(2)
      );
      const avgP99 = Number(
        (runs.reduce((acc, r) => acc + r.latencies.p99, 0) / runs.length).toFixed(2)
      );

      suiteOutput.scenarios[scenarioId] = {
        name: scenarioName,
        description: scenarioDesc,
        runs,
        aggregate: {
          avgThroughputReqSec: avgThroughput,
          avgP50LatencyMs: avgP50,
          avgP95LatencyMs: avgP95,
          avgP99LatencyMs: avgP99,
        },
      };
      console.log(`  ✔ Scenario 2 Summary: Avg Throughput: ${avgThroughput} req/s | Avg p95 of Runs: ${avgP95}ms\n`);
    }

    // --------------------------------------------------------------------------
    // Scenario 3: Quota Exhaustion Transition
    // --------------------------------------------------------------------------
    {
      const scenarioId = 'scenario_3_quota_exhaustion';
      const scenarioName = 'Quota Exhaustion Transition';
      const scenarioDesc =
        'Evaluates performance and accuracy when an allowance limit is exhausted, transitioning from acceptance to rejection without counter corruption.';
      console.log(`▶ Scenario 3: ${scenarioName}`);

      const account = await createBenchmarkAccount(baseUrl, 'S3 Quota Exhaustion Account');
      const planId = await createBenchmarkPlan(baseUrl, account.apiKey, 'ACCOUNT', 100, 100);
      await updateAccountPlan(baseUrl, account.apiKey, planId);
      const user = await createBenchmarkUser(baseUrl, account.apiKey);

      const N = 300;
      const C = 10;

      const tStart = performance.now();
      const outcomes = await runConcurrentWorkers(N, C, (i) =>
        sendConsumptionRequest(baseUrl, account.apiKey, user, 2, `req_s3_${Date.now()}_${i}`)
      );
      const tEnd = performance.now();
      const durationMs = tEnd - tStart;

      // Exactly 50 requests accepted (100 units total), 250 requests rejected
      const audit = await auditBenchmarkAccounts(pool, [account.accountId], yearMonth, 100);
      const runResult = compileRunResult(
        scenarioId,
        scenarioName,
        1,
        C,
        durationMs,
        outcomes,
        audit,
        { expectedAccepted: 50, expectedQuotaRejected: 250 }
      );

      if (!runResult.audit.passed) suiteOutput.summary.allAuditsPassed = false;
      suiteOutput.summary.totalRuns++;

      suiteOutput.scenarios[scenarioId] = {
        name: scenarioName,
        description: scenarioDesc,
        runs: [runResult],
        aggregate: {
          avgThroughputReqSec: runResult.throughputReqSec,
          avgP50LatencyMs: runResult.latencies.p50,
          avgP95LatencyMs: runResult.latencies.p95,
          avgP99LatencyMs: runResult.latencies.p99,
        },
      };

      console.log(
        `  Result: ${runResult.throughputReqSec} req/s | Accepted: ${runResult.outcomes.accepted} (expected: 50) | Quota Rejected: ${runResult.outcomes.quotaRejected} (expected: 250) | Audit: ${runResult.audit.passed ? 'PASSED' : 'FAILED'}\n`
      );
    }

    // --------------------------------------------------------------------------
    // Scenario 4: High-Rate Idempotent Retries
    // --------------------------------------------------------------------------
    {
      const scenarioId = 'scenario_4_idempotent_retries';
      const scenarioName = 'High-Rate Idempotent Retries (Deduplication Path)';
      const scenarioDesc =
        'Measures deduplication retrieval performance when replaying identical requestIds, proving invariant counters.';
      console.log(`▶ Scenario 4: ${scenarioName}`);

      const account = await createBenchmarkAccount(baseUrl, 'S4 Idempotent Account');
      const user = await createBenchmarkUser(baseUrl, account.apiKey);

      // Pre-seed 10 unique requests
      const uniqueKeys: string[] = [];
      for (let k = 0; k < 10; k++) {
        const key = `seed_s4_key_${Date.now()}_${k}`;
        uniqueKeys.push(key);
        await sendConsumptionRequest(baseUrl, account.apiKey, user, 1, key);
      }

      // Replay the 10 keys 50 times each concurrently (total 500 requests)
      const N = 500;
      const C = 15;

      const tStart = performance.now();
      const outcomes = await runConcurrentWorkers(N, C, (i) => {
        const key = uniqueKeys[i % uniqueKeys.length];
        return sendConsumptionRequest(baseUrl, account.apiKey, user, 1, key);
      });
      const tEnd = performance.now();
      const durationMs = tEnd - tStart;

      // Exactly 10 units consumed total despite 500 replays
      const audit = await auditBenchmarkAccounts(pool, [account.accountId], yearMonth, 10);
      const runResult = compileRunResult(
        scenarioId,
        scenarioName,
        1,
        C,
        durationMs,
        outcomes,
        audit,
        { expectedAccepted: 500, expectedQuotaRejected: 0 }
      );

      if (!runResult.audit.passed) suiteOutput.summary.allAuditsPassed = false;
      suiteOutput.summary.totalRuns++;

      suiteOutput.scenarios[scenarioId] = {
        name: scenarioName,
        description: scenarioDesc,
        runs: [runResult],
        aggregate: {
          avgThroughputReqSec: runResult.throughputReqSec,
          avgP50LatencyMs: runResult.latencies.p50,
          avgP95LatencyMs: runResult.latencies.p95,
          avgP99LatencyMs: runResult.latencies.p99,
        },
      };

      console.log(
        `  Result: ${runResult.throughputReqSec} req/s | p50: ${runResult.latencies.p50}ms | p95: ${runResult.latencies.p95}ms | Accepted Retries: ${runResult.outcomes.accepted}/500 | Distinct Units Consumed: ${audit.totalAccountCounterUnits} (expected: 10) | Audit: ${runResult.audit.passed ? 'PASSED' : 'FAILED'}\n`
      );
    }

    // --------------------------------------------------------------------------
    // Scenario 5: In-Flight Plan Mutation Under Concurrent Load
    // --------------------------------------------------------------------------
    {
      const scenarioId = 'scenario_5_plan_mutation';
      const scenarioName = 'In-Flight Plan Mutation Under Concurrent Load';
      const scenarioDesc =
        'Tests in-flight plan upgrade during active concurrent consumption streams under row-lock contention, recording timestamp causality and verifying immediate effect without corruption.';
      console.log(`▶ Scenario 5: ${scenarioName}`);

      const account = await createBenchmarkAccount(baseUrl, 'S5 Plan Mutation Account');
      // Initial plan: perRequestLimit = 5
      const initialPlanId = await createBenchmarkPlan(baseUrl, account.apiKey, 'ACCOUNT', 100000, 5);
      await updateAccountPlan(baseUrl, account.apiKey, initialPlanId);
      // Upgraded plan: perRequestLimit = 20
      const upgradedPlanId = await createBenchmarkPlan(baseUrl, account.apiKey, 'ACCOUNT', 100000, 20);
      const user = await createBenchmarkUser(baseUrl, account.apiKey);

      const N = 400;
      const C = 10;
      let planUpdateCommitTime = 0;

      const tStart = performance.now();

      // Launch worker pool: halfway through, dispatch the plan update
      const outcomes = await runConcurrentWorkers(N, C, async (i) => {
        if (i === 150) {
          // Dispatch plan upgrade mid-stream concurrently
          await updateAccountPlan(baseUrl, account.apiKey, upgradedPlanId);
          planUpdateCommitTime = Date.now();
        }

        // Each request asks for 10 units:
        // Under initial plan (limit 5) -> REJECTED.
        // Under upgraded plan (limit 20) -> ACCEPTED.
        return sendConsumptionRequest(
          baseUrl,
          account.apiKey,
          user,
          10,
          `req_s5_${Date.now()}_${i}`
        );
      });

      const tEnd = performance.now();
      const durationMs = tEnd - tStart;

      // Dynamic physical causality audit:
      // 1. Audit database ledger and counters
      const audit = await auditBenchmarkAccounts(pool, [account.accountId], yearMonth);

      // 2. Compile outcomes
      const runResult = compileRunResult(
        scenarioId,
        scenarioName,
        1,
        C,
        durationMs,
        outcomes,
        audit
      );

      // 3. Causality verification: All requests initiated strictly after plan update commit time MUST be accepted
      if (planUpdateCommitTime > 0) {
        const postUpgradeRequests = outcomes.filter((o) => o.timestamp >= planUpdateCommitTime);
        const postUpgradeRejections = postUpgradeRequests.filter((o) => o.decisionAccepted !== true);
        if (postUpgradeRejections.length > 0) {
          runResult.audit.passed = false;
          runResult.audit.discrepancies.push(
            `Causality violation: ${postUpgradeRejections.length} requests initiated after plan update completed were rejected`
          );
        }
      } else {
        runResult.audit.passed = false;
        runResult.audit.discrepancies.push('Plan update was never recorded as committed');
      }

      // 4. Exact ledger integrity: Database ledger and counters must equal accepted * 10
      const expectedUnits = runResult.outcomes.accepted * 10;
      if (
        audit.totalAccountCounterUnits !== expectedUnits ||
        audit.totalLedgerUnits !== expectedUnits
      ) {
        runResult.audit.passed = false;
        runResult.audit.discrepancies.push(
          `Ledger mismatch: Expected ${expectedUnits} units (${runResult.outcomes.accepted} * 10), but found ${audit.totalAccountCounterUnits} units in database`
        );
      }

      // 5. Total requests accounted for: accepted + quotaRejected must equal total requests N
      if (runResult.outcomes.accepted + runResult.outcomes.quotaRejected !== N) {
        runResult.audit.passed = false;
        runResult.audit.discrepancies.push(
          `Unaccounted requests: Total = ${N}, accepted = ${runResult.outcomes.accepted}, rejected = ${runResult.outcomes.quotaRejected}`
        );
      }

      if (!runResult.audit.passed) suiteOutput.summary.allAuditsPassed = false;
      suiteOutput.summary.totalRuns++;

      suiteOutput.scenarios[scenarioId] = {
        name: scenarioName,
        description: scenarioDesc,
        runs: [runResult],
        aggregate: {
          avgThroughputReqSec: runResult.throughputReqSec,
          avgP50LatencyMs: runResult.latencies.p50,
          avgP95LatencyMs: runResult.latencies.p95,
          avgP99LatencyMs: runResult.latencies.p99,
        },
      };

      console.log(
        `  Result: ${runResult.throughputReqSec} req/s | Pre-Upgrade Rejections: ${runResult.outcomes.quotaRejected} | Post-Upgrade Acceptances: ${runResult.outcomes.accepted} | Audit: ${runResult.audit.passed ? 'PASSED' : 'FAILED'}\n`
      );
    }
  } finally {
    // Guaranteed connection pool closure
    await pool.end();
  }

  // Save raw results to JSON file for diagnosis regardless of pass/fail
  const resultsPath = path.resolve(process.cwd(), 'docs', 'benchmark-results.json');
  await fs.writeFile(resultsPath, JSON.stringify(suiteOutput, null, 2), 'utf-8');
  console.log(`✔ Raw benchmark results written to: ${resultsPath}`);

  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  if (suiteOutput.summary.allAuditsPassed) {
    console.log('  Benchmark Suite Complete - ALL SCENARIOS & AUDITS PASSED (100% Consistent)');
    console.log('═══════════════════════════════════════════════════════════════════════════\n');
  } else {
    console.error('  Benchmark Suite FAILED - Discrepancies detected during audit.');
    console.log('═══════════════════════════════════════════════════════════════════════════\n');
    process.exit(1);
  }
}

runBenchmarkSuite().catch((err) => {
  console.error('\n✖ Benchmark suite encountered an unhandled error:', err);
  process.exit(1);
});

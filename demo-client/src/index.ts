// demo-client/src/index.ts
// Comprehensive interactive demo scenario verifying Usage Metering and Quotas Service integration

import { MeteringHttpClient, type ConsumptionDecision } from './client.js';

export interface DemoScenarioResult {
  accountId: string;
  userAhmedId: string;
  userSaraId: string;
  accountPlanId: string;
  saraPlanId: string;
  step3Decision: ConsumptionDecision;
  step4Decision: ConsumptionDecision;
  step5Decision: ConsumptionDecision;
  step6Decision: ConsumptionDecision;
  finalAccountConsumed: number;
  finalAccountRemaining: number;
  finalAhmedConsumed: number;
  finalSaraConsumed: number;
}

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

function logHeader(title: string): void {
  console.log(`\n${colors.bright}${colors.cyan}══════════════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}  ${title}${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}══════════════════════════════════════════════════════════════════════${colors.reset}`);
}

function logStep(stepNum: number, title: string): void {
  console.log(`\n${colors.bright}${colors.yellow}▶ [Step ${stepNum}] ${title}${colors.reset}`);
}

function logSuccess(message: string): void {
  console.log(`  ${colors.green}✔ ${message}${colors.reset}`);
}

function logInfo(label: string, value: unknown): void {
  console.log(`    ${colors.dim}${label}:${colors.reset} ${colors.bright}${typeof value === 'object' ? JSON.stringify(value, null, 2) : value}${colors.reset}`);
}

/**
 * Executes the complete demo scenario with strict verification of results and quota balances at each step
 */
export async function runDemoScenario(
  baseUrl: string = process.env.API_BASE_URL || 'http://127.0.0.1:3000'
): Promise<DemoScenarioResult> {
  logHeader('Starting Standalone Demo Client (Usage Metering Service)');
  console.log(`${colors.dim}Connecting to service over HTTP at: ${colors.bright}${baseUrl}${colors.reset}`);

  const client = new MeteringHttpClient(baseUrl);

  // =========================================================================
  // Step 1: Register account and store API key in session without logging
  // =========================================================================
  logStep(1, 'Register new account and issue API key (POST /accounts)');
  const accountRes = await client.createAccount('Acme SaaS Demo Enterprise');
  if (!accountRes.ok || !accountRes.data?.apiKey) {
    throw new Error(`Failed to create account (Status: ${accountRes.status})`);
  }

  const account = accountRes.data;
  client.setApiKey(account.apiKey);

  logSuccess('Account successfully registered and API key stored in session safely');
  logInfo('Account ID', account.id);
  logInfo('Account Name', account.name);
  logInfo('Server Request ID (x-request-id)', accountRes.requestId);

  // Confirm authentication via GET /account/me
  const meRes = await client.getAccountProfile();
  if (!meRes.ok) {
    throw new Error(`Failed to verify account profile (Status: ${meRes.status})`);
  }
  logSuccess(`Authentication confirmed via Bearer Token (Status: ${meRes.status})`);

  // =========================================================================
  // Step 2: Configure account plan from the beginning (monthly: 10, per-request: 20) and users
  // =========================================================================
  logStep(2, 'Configure initial account plan (monthly: 10, per-request: 20) and assign plans to users');

  // 2.1 Create approved account plan
  const accountPlanRes = await client.createCustomPlan({
    name: 'Demo Account Plan (Monthly 10, PerRequest 20)',
    type: 'ACCOUNT',
    monthlyLimit: 10,
    perRequestLimit: 20,
  });
  if (!accountPlanRes.ok || !accountPlanRes.data?.id) {
    throw new Error(`Failed to create account plan (Status: ${accountPlanRes.status})`);
  }
  const accountPlan = accountPlanRes.data;

  // Assign account plan via PATCH /account/plan
  const updateAccountPlanRes = await client.updateAccountPlan(accountPlan.id);
  if (!updateAccountPlanRes.ok) {
    throw new Error(`Failed to update account plan (Status: ${updateAccountPlanRes.status})`);
  }
  logSuccess('Account plan assigned from the beginning via PATCH /account/plan');
  logInfo('Account Plan ID', accountPlan.id);
  logInfo('Monthly Limit', accountPlan.monthlyLimit);
  logInfo('Per-Request Limit', accountPlan.perRequestLimit);

  // 2.2 Create custom restricted plan for Sara (monthly: 30, per-request: 5)
  const saraPlanRes = await client.createCustomPlan({
    name: 'Demo Sara Plan (Monthly 30, PerRequest 5)',
    type: 'USER',
    monthlyLimit: 30,
    perRequestLimit: 5,
  });
  if (!saraPlanRes.ok || !saraPlanRes.data?.id) {
    throw new Error(`Failed to create Sara plan (Status: ${saraPlanRes.status})`);
  }
  const saraPlan = saraPlanRes.data;
  logSuccess('Custom plan for Sara created via POST /plans');
  logInfo('Sara Plan ID', saraPlan.id);
  logInfo('Sara Per-Request Limit', saraPlan.perRequestLimit);
  logInfo('Sara Monthly Limit', saraPlan.monthlyLimit);

  // 2.3 Create first user (Ahmed) with default public user plan
  const user1Res = await client.createUser('plan_default_user');
  if (!user1Res.ok || !user1Res.data?.id) {
    throw new Error(`Failed to create Ahmed user (Status: ${user1Res.status})`);
  }
  const userAhmed = user1Res.data;
  logSuccess('First user (Ahmed) created with default plan (plan_default_user)');
  logInfo('Ahmed User ID', userAhmed.id);

  // 2.4 Create second user (Sara) with custom restricted plan
  const user2Res = await client.createUser(saraPlan.id);
  if (!user2Res.ok || !user2Res.data?.id) {
    throw new Error(`Failed to create Sara user (Status: ${user2Res.status})`);
  }
  const userSara = user2Res.data;
  logSuccess('Second user (Sara) created with custom restricted plan');
  logInfo('Sara User ID', userSara.id);

  // =========================================================================
  // Step 3: Ahmed consumes 2 units -> Accepted
  // =========================================================================
  logStep(3, 'Ahmed consumes 2 units within limits -> Accepted (POST /consumptions)');
  const reqIdStep3 = `req_demo_step3_${Date.now()}`;
  const resStep3 = await client.executeConsumption({
    userId: userAhmed.id,
    units: 2,
    requestId: reqIdStep3,
  });

  if (!resStep3.ok) {
    throw new Error(`Consumption HTTP request failed in Step 3 (Status: ${resStep3.status})`);
  }

  const decision3 = resStep3.data;

  // Strict verification of Step 3 decision and balances
  if (!decision3.accepted) {
    throw new Error(`Expected Step 3 to be accepted, but was rejected with reason: ${JSON.stringify((decision3 as any).reason)}`);
  }
  if (decision3.user.consumed !== 2) {
    throw new Error(`Expected Ahmed consumed in Step 3 to be 2, got: ${decision3.user.consumed}`);
  }
  if (decision3.account.consumed !== 2 || decision3.account.remaining !== 8) {
    throw new Error(`Expected Account in Step 3 to have consumed: 2, remaining: 8. Got consumed: ${decision3.account.consumed}, remaining: ${decision3.account.remaining}`);
  }

  logSuccess('Ahmed consumption of 2 units accepted and balances updated atomically');
  logInfo('Decision (accepted)', decision3.accepted);
  logInfo('Ahmed Balance (consumed: 2)', decision3.user);
  logInfo('Shared Account Balance (consumed: 2, remaining: 8)', decision3.account);

  // =========================================================================
  // Step 4: Sara requests 6 units (her limit is 5) -> Rejected user / max_per_request
  // =========================================================================
  logStep(4, 'Sara requests 6 units with limit 5 -> Rejected user / max_per_request');
  const reqIdStep4 = `req_demo_step4_${Date.now()}`;
  const resStep4 = await client.executeConsumption({
    userId: userSara.id,
    units: 6,
    requestId: reqIdStep4,
  });

  if (!resStep4.ok) {
    throw new Error(`Consumption HTTP request failed in Step 4 (Status: ${resStep4.status})`);
  }

  const decision4 = resStep4.data;

  // Strict verification of Step 4 decision and balances
  if (decision4.accepted) {
    throw new Error(`Expected Step 4 to be rejected due to user limit, but was accepted`);
  }
  const reason4 = (decision4 as any).reason;
  if (!reason4 || reason4.scope !== 'user' || reason4.rule !== 'max_per_request') {
    throw new Error(`Expected Step 4 rejection reason to be user.max_per_request, got: ${JSON.stringify(reason4)}`);
  }
  if (decision4.user.consumed !== 0) {
    throw new Error(`Expected Sara consumed to remain 0 after rejection, got: ${decision4.user.consumed}`);
  }
  if (decision4.account.consumed !== 2) {
    throw new Error(`Expected Account consumed to remain 2 after Sara rejection, got: ${decision4.account.consumed}`);
  }

  logSuccess('Sara request rejected accurately with user.max_per_request without deducting units');
  logInfo('Decision (accepted)', decision4.accepted);
  logInfo('Explicit Rejection Reason', reason4);
  logInfo('Sara Consumed (unchanged = 0)', decision4.user.consumed);
  logInfo('Account Consumed (unchanged = 2)', decision4.account.consumed);

  // =========================================================================
  // Step 5: Ahmed requests 9 units (shared account remaining is 8) -> Rejected account / monthly_allowance
  // =========================================================================
  logStep(5, 'Ahmed requests 9 units with shared remaining 8 -> Rejected account / monthly_allowance');
  const reqIdStep5 = `req_demo_step5_${Date.now()}`;
  const resStep5 = await client.executeConsumption({
    userId: userAhmed.id,
    units: 9,
    requestId: reqIdStep5,
  });

  if (!resStep5.ok) {
    throw new Error(`Consumption HTTP request failed in Step 5 (Status: ${resStep5.status})`);
  }

  const decision5 = resStep5.data;

  // Strict verification of Step 5 decision and balances
  if (decision5.accepted) {
    throw new Error(`Expected Step 5 to be rejected due to shared allowance, but was accepted`);
  }
  const reason5 = (decision5 as any).reason;
  if (!reason5 || reason5.scope !== 'account' || reason5.rule !== 'monthly_allowance') {
    throw new Error(`Expected Step 5 rejection reason to be account.monthly_allowance, got: ${JSON.stringify(reason5)}`);
  }
  if (decision5.user.consumed !== 2) {
    throw new Error(`Expected Ahmed consumed to remain 2 after rejection, got: ${decision5.user.consumed}`);
  }
  if (decision5.account.consumed !== 2) {
    throw new Error(`Expected Account consumed to remain 2 after rejection, got: ${decision5.account.consumed}`);
  }

  logSuccess('Ahmed request rejected accurately with account.monthly_allowance without deducting units');
  logInfo('Decision (accepted)', decision5.accepted);
  logInfo('Explicit Rejection Reason', reason5);
  logInfo('Ahmed Consumed (unchanged = 2)', decision5.user.consumed);
  logInfo('Account Consumed (unchanged = 2)', decision5.account.consumed);

  // =========================================================================
  // Step 6: Elevate Sara limit to 10 via API, re-send 6 units with new requestId -> Accepted
  // =========================================================================
  logStep(6, 'Elevate Sara per-request limit to 10 via API, re-send 6 units with new requestId -> Accepted');

  // Update Sara plan via PATCH /plans/:planId
  const updateSaraPlanRes = await client.updateCustomPlan(saraPlan.id, {
    perRequestLimit: 10,
  });
  if (!updateSaraPlanRes.ok || updateSaraPlanRes.data?.perRequestLimit !== 10) {
    throw new Error(`Failed to update Sara plan (Status: ${updateSaraPlanRes.status})`);
  }
  logSuccess('Sara plan updated to perRequestLimit: 10 via PATCH /plans/:planId');
  logInfo('Updated Sara Per-Request Limit', updateSaraPlanRes.data.perRequestLimit);

  // Re-send 6 units with new requestId
  const reqIdStep6 = `req_demo_step6_${Date.now()}`;
  const resStep6 = await client.executeConsumption({
    userId: userSara.id,
    units: 6,
    requestId: reqIdStep6,
  });

  if (!resStep6.ok) {
    throw new Error(`Consumption HTTP request failed in Step 6 (Status: ${resStep6.status})`);
  }

  const decision6 = resStep6.data;

  // Strict verification of Step 6 decision and balances
  if (!decision6.accepted) {
    throw new Error(`Expected Step 6 to be accepted after limit elevation, but was rejected with reason: ${JSON.stringify((decision6 as any).reason)}`);
  }
  if (decision6.user.consumed !== 6 || decision6.user.remaining !== 24) {
    throw new Error(`Expected Sara in Step 6 to have consumed: 6, remaining: 24. Got consumed: ${decision6.user.consumed}, remaining: ${decision6.user.remaining}`);
  }
  if (decision6.account.consumed !== 8 || decision6.account.remaining !== 2) {
    throw new Error(`Expected Account in Step 6 to have consumed: 8, remaining: 2. Got consumed: ${decision6.account.consumed}, remaining: ${decision6.account.remaining}`);
  }

  logSuccess('Sara consumption of 6 units accepted immediately without server restart');
  logInfo('Decision (accepted)', decision6.accepted);
  logInfo('Sara Balance (consumed: 6, remaining: 24)', decision6.user);
  logInfo('Account Balance (consumed: 8, remaining: 2)', decision6.account);

  // =========================================================================
  // Step 7: Verify final cumulative consumption and complete audit trail
  // =========================================================================
  logStep(7, 'Verify final cumulative consumption balances and audit log (Account: 8, Ahmed: 2, Sara: 6)');

  // 7.1 Verify Account usage
  const finalAccountUsageRes = await client.getAccountUsage();
  if (!finalAccountUsageRes.ok) {
    throw new Error(`Failed to fetch final account usage (Status: ${finalAccountUsageRes.status})`);
  }
  const accountUsageData = finalAccountUsageRes.data as any;
  const finalAccountConsumed = accountUsageData.usage.consumed;
  const finalAccountRemaining = accountUsageData.usage.remaining;

  if (finalAccountConsumed !== 8 || finalAccountRemaining !== 2) {
    throw new Error(`Final account usage mismatch! Expected consumed: 8, remaining: 2. Got consumed: ${finalAccountConsumed}, remaining: ${finalAccountRemaining}`);
  }
  logSuccess(`Account final usage verified: consumed = ${finalAccountConsumed} (expected: 8), remaining = ${finalAccountRemaining} (expected: 2)`);

  // 7.2 Verify Ahmed usage
  const ahmedUsageRes = await client.getUserUsage(userAhmed.id);
  if (!ahmedUsageRes.ok) {
    throw new Error(`Failed to fetch Ahmed user usage (Status: ${ahmedUsageRes.status})`);
  }
  const ahmedUsageData = ahmedUsageRes.data as any;
  const finalAhmedConsumed = ahmedUsageData.userUsage.consumed;

  if (finalAhmedConsumed !== 2) {
    throw new Error(`Final Ahmed usage mismatch! Expected consumed: 2, got: ${finalAhmedConsumed}`);
  }
  logSuccess(`Ahmed final usage verified: consumed = ${finalAhmedConsumed} (expected: 2)`);

  // 7.3 Verify Sara usage
  const saraUsageRes = await client.getUserUsage(userSara.id);
  if (!saraUsageRes.ok) {
    throw new Error(`Failed to fetch Sara user usage (Status: ${saraUsageRes.status})`);
  }
  const saraUsageData = saraUsageRes.data as any;
  const finalSaraConsumed = saraUsageData.userUsage.consumed;

  if (finalSaraConsumed !== 6) {
    throw new Error(`Final Sara usage mismatch! Expected consumed: 6, got: ${finalSaraConsumed}`);
  }
  logSuccess(`Sara final usage verified: consumed = ${finalSaraConsumed} (expected: 6)`);

  // 7.4 Fetch request history audit log
  const historyRes = await client.getRequestHistory({ limit: 10 });
  if (!historyRes.ok || !Array.isArray(historyRes.data?.items)) {
    throw new Error(`Failed to fetch request history audit log (Status: ${historyRes.status})`);
  }

  if (historyRes.data.items.length !== 4) {
    throw new Error(`Expected exactly 4 audit records in history, got: ${historyRes.data.items.length}`);
  }

  logSuccess(`Request audit history retrieved successfully (${historyRes.data.items.length} records):`);
  console.table(
    historyRes.data.items.map((item) => ({
      ID: item.id,
      RequestId: item.requestId,
      UserId: item.userId,
      Units: item.requestedUnits,
      Status: item.status,
      RejectionRule: item.rejectionReason ? `${item.rejectionReason.scope}.${item.rejectionReason.rule}` : 'N/A',
      ProcessedAt: item.processedAt,
    }))
  );

  logHeader('All Scenario Steps Completed & Verified Successfully with Zero Anomalies');

  return {
    accountId: account.id,
    userAhmedId: userAhmed.id,
    userSaraId: userSara.id,
    accountPlanId: accountPlan.id,
    saraPlanId: saraPlan.id,
    step3Decision: decision3,
    step4Decision: decision4,
    step5Decision: decision5,
    step6Decision: decision6,
    finalAccountConsumed,
    finalAccountRemaining,
    finalAhmedConsumed,
    finalSaraConsumed,
  };
}

// Direct CLI execution when invoked as main module
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

if (isMainModule) {
  const isDemoFlag = process.argv.includes('--demo');

  if (isDemoFlag) {
    runDemoScenario()
      .then(() => {
        console.log('\n✔ Standalone demo client completed successfully.');
        process.exit(0);
      })
      .catch((err) => {
        console.error('\n✖ Standalone demo client encountered an error:', err);
        process.exit(1);
      });
  } else {
    // Check for interactive terminal (isTTY may be undefined or false)
    if (!process.stdin.isTTY) {
      console.error('Error: Interactive mode requires an interactive TTY terminal.');
      console.error('To run the automated guided demo in non-interactive environments (e.g. Docker/CI), use:');
      console.error('  npm start -- --demo  (or: npm run demo)');
      process.exit(1);
    }

    import('./menu.js')
      .then((m) => m.startInteractiveMenu())
      .catch((err) => {
        console.error('\n✖ Interactive session failed:', err);
        process.exit(1);
      });
  }
}

// demo-client/src/menu.ts
// Interactive CLI menu for the Usage Metering Demo Client

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { MeteringHttpClient, type ConsumptionDecision } from './client.js';
import { runDemoScenario } from './index.js';

interface DemoUser {
  id: string;
  name: string;
  planId: string;
  isCustomPlan: boolean;
}

interface LastRequestState {
  requestId: string;
  userId: string;
  userName: string;
  units: number;
  localActionCompleted: boolean;
  decision?: ConsumptionDecision;
}

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

/**
 * Starts the interactive CLI session
 */
export async function startInteractiveMenu(
  baseUrl: string = process.env.API_BASE_URL || 'http://127.0.0.1:3000',
  inStream: NodeJS.ReadableStream = input,
  outStream: NodeJS.WritableStream = output
): Promise<void> {
  const rl = readline.createInterface({ input: inStream, output: outStream });

  console.log(`\n${colors.bright}${colors.cyan}══════════════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}  Initializing Interactive Demo Client Session${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}══════════════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.dim}Target Service: ${colors.bright}${baseUrl}${colors.reset}\n`);

  const client = new MeteringHttpClient(baseUrl);

  // 1. Initialize company account
  process.stdout.write('  Setting up company account via HTTP (POST /accounts)... ');
  const accountRes = await client.createAccount('Acme Interactive Corp');
  if (!accountRes.ok || !accountRes.data?.apiKey) {
    console.log(`${colors.red}FAILED${colors.reset}`);
    rl.close();
    throw new Error(`Failed to initialize account: HTTP ${accountRes.status}`);
  }
  const account = accountRes.data;
  client.setApiKey(account.apiKey);
  console.log(`${colors.green}OK (Account ID: ${account.id})${colors.reset}`);

  // 2. Set account plan (Monthly: 20, PerRequest: 20)
  process.stdout.write('  Configuring initial account plan (Monthly 20, PerRequest 20)... ');
  const accountPlanRes = await client.createCustomPlan({
    name: 'Acme Initial Account Plan',
    type: 'ACCOUNT',
    monthlyLimit: 20,
    perRequestLimit: 20,
  });
  if (!accountPlanRes.ok || !accountPlanRes.data?.id) {
    console.log(`${colors.red}FAILED${colors.reset}`);
    rl.close();
    throw new Error(`Failed to configure account plan: HTTP ${accountPlanRes.status}`);
  }
  await client.updateAccountPlan(accountPlanRes.data.id);
  console.log(`${colors.green}OK${colors.reset}`);

  // 3. Setup demo users
  process.stdout.write('  Provisioning User 1 (Ahmed - Default Public Plan)... ');
  const ahmedRes = await client.createUser('plan_default_user');
  if (!ahmedRes.ok || !ahmedRes.data?.id) {
    console.log(`${colors.red}FAILED${colors.reset}`);
    rl.close();
    throw new Error(`Failed to create Ahmed: HTTP ${ahmedRes.status}`);
  }
  const ahmed: DemoUser = {
    id: ahmedRes.data.id,
    name: 'Ahmed',
    planId: 'plan_default_user',
    isCustomPlan: false,
  };
  console.log(`${colors.green}OK (ID: ${ahmed.id})${colors.reset}`);

  process.stdout.write('  Provisioning User 2 (Sara - Restricted Plan: Limit 5)... ');
  const saraPlanRes = await client.createCustomPlan({
    name: 'Sara Initial Restricted Plan',
    type: 'USER',
    monthlyLimit: 30,
    perRequestLimit: 5,
  });
  if (!saraPlanRes.ok || !saraPlanRes.data?.id) {
    console.log(`${colors.red}FAILED${colors.reset}`);
    rl.close();
    throw new Error(`Failed to create Sara plan: HTTP ${saraPlanRes.status}`);
  }
  const saraRes = await client.createUser(saraPlanRes.data.id);
  if (!saraRes.ok || !saraRes.data?.id) {
    console.log(`${colors.red}FAILED${colors.reset}`);
    rl.close();
    throw new Error(`Failed to create Sara: HTTP ${saraRes.status}`);
  }
  const sara: DemoUser = {
    id: saraRes.data.id,
    name: 'Sara',
    planId: saraPlanRes.data.id,
    isCustomPlan: true,
  };
  console.log(`${colors.green}OK (ID: ${sara.id})${colors.reset}`);

  const users: DemoUser[] = [ahmed, sara];
  let activeUserIndex = 0; // Default active user: Ahmed
  let lastRequest: LastRequestState | null = null;

  try {
    let running = true;
    while (running) {
      const activeUser = users[activeUserIndex];
      console.log(`\n${colors.bright}${colors.cyan}──────────────────────────────────────────────────────────────────────${colors.reset}`);
      console.log(`${colors.bright}Active User:${colors.reset} ${colors.yellow}${activeUser.name}${colors.reset} (${activeUser.id}) | ${colors.bright}Plan:${colors.reset} ${activeUser.planId}`);
      if (lastRequest) {
        const localStatus = lastRequest.localActionCompleted
          ? `${colors.green}completed${colors.reset}`
          : `${colors.dim}not executed${colors.reset}`;
        console.log(`${colors.dim}Last Request: [${lastRequest.requestId}] for ${lastRequest.userName} (${lastRequest.units} units, local action: ${localStatus})${colors.reset}`);
      }
      console.log(`${colors.bright}${colors.cyan}──────────────────────────────────────────────────────────────────────${colors.reset}`);
      console.log('1. Select user');
      console.log('2. Perform action');
      console.log('3. View usage and remaining allowance');
      console.log('4. Change plan settings');
      console.log('5. Run guided demo');
      console.log('0. Exit');

      const choice = (await rl.question(`\n${colors.bright}Enter choice (0-5): ${colors.reset}`)).trim();

      switch (choice) {
        case '1': {
          // ==========================================
          // 1. Select user
          // ==========================================
          console.log(`\n${colors.bright}Available Users:${colors.reset}`);
          for (let i = 0; i < users.length; i++) {
            const u = users[i];
            const currentTag = i === activeUserIndex ? ` ${colors.green}(active)${colors.reset}` : '';
            console.log(`  ${i + 1}. ${u.name} (ID: ${u.id}, Plan: ${u.planId})${currentTag}`);
          }
          const selection = (await rl.question(`Select user number (1-${users.length}, or 'b' to back): `)).trim();
          if (selection.toLowerCase() === 'b' || selection === '') {
            break;
          }
          const selectedIdx = parseInt(selection, 10) - 1;
          if (Number.isNaN(selectedIdx) || selectedIdx < 0 || selectedIdx >= users.length) {
            console.log(`${colors.red}Invalid selection.${colors.reset}`);
          } else {
            activeUserIndex = selectedIdx;
            console.log(`${colors.green}✔ Active user switched to: ${users[activeUserIndex].name}${colors.reset}`);
            // Note: lastRequest is intentionally preserved and remains tied to its original requester
          }
          break;
        }

        case '2': {
          // ==========================================
          // 2. Perform action
          // ==========================================
          console.log(`\n${colors.bright}--- Perform Action ---${colors.reset}`);
          console.log(`Selected User for new actions: ${colors.yellow}${activeUser.name}${colors.reset} (${activeUser.id})`);

          let promptMsg = 'Enter units to consume (positive integer, or \'b\' to cancel): ';
          if (lastRequest) {
            promptMsg = `Enter units (or 'r' to retry last request [${lastRequest.requestId}], 'b' to cancel): `;
          }

          const actionInput = (await rl.question(promptMsg)).trim();
          if (actionInput.toLowerCase() === 'b' || actionInput === '') {
            break;
          }

          // Case A: Retry previous request with identical requestId, user, and units
          if (actionInput.toLowerCase() === 'r' && lastRequest) {
            console.log(`\n${colors.bright}${colors.yellow}Retrying previous request with identical parameters:${colors.reset}`);
            console.log(`  Request ID:    ${lastRequest.requestId}`);
            console.log(`  Original User: ${lastRequest.userName} (${lastRequest.userId})`);
            console.log(`  Units:         ${lastRequest.units}`);
            if (lastRequest.localActionCompleted) {
              console.log(`  ${colors.dim}Note: Simulated action was already completed locally for this request.`);
              console.log(`  Replaying to verify server response without repeating local action.${colors.reset}`);
            }

            const confirm = (await rl.question('Confirm replaying this request? (y/n): ')).trim().toLowerCase();
            if (confirm !== 'y' && confirm !== 'yes') {
              console.log('Retry cancelled.');
              break;
            }

            console.log(`Sending idempotent POST /consumptions for ${lastRequest.requestId}...`);
            const retryRes = await client.executeConsumption({
              userId: lastRequest.userId,
              units: lastRequest.units,
              requestId: lastRequest.requestId,
            });

            if (!retryRes.ok) {
              console.log(`${colors.red}✖ Server error (HTTP ${retryRes.status}): ${JSON.stringify(retryRes.data)}${colors.reset}`);
              break;
            }

            const decision = retryRes.data;
            lastRequest.decision = decision;

            if (decision.accepted) {
              console.log(`${colors.green}✔ Decision: ACCEPTED${colors.reset}`);
              if (lastRequest.localActionCompleted) {
                console.log(`  ${colors.dim}(Simulated action was already completed previously; local duplicate execution skipped.)${colors.reset}`);
              } else {
                console.log(`  ${colors.bright}${colors.green}Action completed${colors.reset} (Simulated action executed locally).`);
                lastRequest.localActionCompleted = true;
              }
              console.log(`  User Balance:    consumed = ${decision.user.consumed}, remaining = ${decision.user.remaining}`);
              console.log(`  Account Balance: consumed = ${decision.account.consumed}, remaining = ${decision.account.remaining}`);
            } else {
              console.log(`${colors.red}✖ Decision: REJECTED${colors.reset}`);
              console.log(`  Reason: ${decision.reason.scope}.${decision.reason.rule}`);
              console.log(`  Simulated action was NOT executed.`);
              console.log(`  User Balance:    consumed = ${decision.user.consumed}, remaining = ${decision.user.remaining}`);
              console.log(`  Account Balance: consumed = ${decision.account.consumed}, remaining = ${decision.account.remaining}`);
              lastRequest.localActionCompleted = false;
            }
            break;
          }

          // Case B: New action with new requestId
          const requestedUnits = parseInt(actionInput, 10);
          if (Number.isNaN(requestedUnits) || requestedUnits <= 0) {
            console.log(`${colors.red}Invalid units. Please specify a positive integer.${colors.reset}`);
            break;
          }

          const newRequestId = `req_interactive_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

          // CRITICAL: Save request state BEFORE sending so it is available even if connection fails
          lastRequest = {
            requestId: newRequestId,
            userId: activeUser.id,
            userName: activeUser.name,
            units: requestedUnits,
            localActionCompleted: false,
          };

          console.log(`Sending POST /consumptions (units: ${requestedUnits}, requestId: ${newRequestId})...`);
          let response;
          try {
            response = await client.executeConsumption({
              userId: activeUser.id,
              units: requestedUnits,
              requestId: newRequestId,
            });
          } catch (netErr) {
            console.log(`${colors.red}✖ Network/Connection failure: ${netErr instanceof Error ? netErr.message : netErr}${colors.reset}`);
            console.log(`${colors.yellow}Notice: Request [${newRequestId}] is saved in memory. You can retry it with 'r' to safely recover.${colors.reset}`);
            break;
          }

          if (!response.ok) {
            console.log(`${colors.red}✖ Server returned HTTP ${response.status}: ${JSON.stringify(response.data)}${colors.reset}`);
            console.log(`${colors.yellow}Request [${newRequestId}] is preserved in memory for idempotent retry.${colors.reset}`);
            break;
          }

          const decision = response.data;
          lastRequest.decision = decision;

          if (decision.accepted) {
            console.log(`\n${colors.bright}${colors.green}✔ Action completed${colors.reset} (Simulated business action executed locally).`);
            console.log(`  Decision:        ACCEPTED`);
            console.log(`  User Balance:    consumed = ${decision.user.consumed}, remaining = ${decision.user.remaining}`);
            console.log(`  Account Balance: consumed = ${decision.account.consumed}, remaining = ${decision.account.remaining}`);
            lastRequest.localActionCompleted = true;
          } else {
            console.log(`\n${colors.bright}${colors.red}✖ Action rejected by quota rules${colors.reset}`);
            console.log(`  Decision:        REJECTED`);
            console.log(`  Rejection Rule:  ${decision.reason.scope}.${decision.reason.rule}`);
            console.log(`  Notice:          Simulated business action was NOT executed.`);
            console.log(`  User Balance:    consumed = ${decision.user.consumed}, remaining = ${decision.user.remaining}`);
            console.log(`  Account Balance: consumed = ${decision.account.consumed}, remaining = ${decision.account.remaining}`);
            lastRequest.localActionCompleted = false;
          }
          break;
        }

        case '3': {
          // ==========================================
          // 3. View usage and remaining allowance
          // ==========================================
          console.log(`\n${colors.bright}--- Current Usage & Quotas ---${colors.reset}`);
          process.stdout.write('Fetching current usage from service... ');

          // Fetch account usage via GET /account/usage
          const accUsageRes = await client.getAccountUsage();
          // Fetch user usage via GET /users/:userId/usage
          const userUsageRes = await client.getUserUsage(activeUser.id);

          if (!accUsageRes.ok || !userUsageRes.ok) {
            console.log(`${colors.red}FAILED${colors.reset}`);
            console.log(`Failed to retrieve usage data (Account HTTP ${accUsageRes.status}, User HTTP ${userUsageRes.status})`);
            break;
          }
          console.log(`${colors.green}OK${colors.reset}\n`);

          const accData = accUsageRes.data as any;
          const userData = userUsageRes.data as any;

          console.log(`${colors.bright}Company Account Usage (${account.name}):${colors.reset}`);
          console.log(`  Month:             ${accData.yearMonth}`);
          console.log(`  Plan:              ${accData.plan.name} (${accData.plan.id})`);
          console.log(`  Monthly Consumed:  ${colors.bright}${accData.usage.consumed}${colors.reset} units`);
          console.log(`  Monthly Remaining: ${colors.bright}${accData.usage.remaining}${colors.reset} units`);
          console.log(`  Monthly Limit:     ${accData.plan.monthlyLimit} units`);
          console.log(`  Per-Request Limit: ${accData.plan.perRequestLimit} units`);

          console.log(`\n${colors.bright}Active User Usage (${activeUser.name} - ${activeUser.id}):${colors.reset}`);
          console.log(`  Month:             ${userData.yearMonth}`);
          console.log(`  Plan:              ${userData.userPlan.name} (${userData.userPlan.id})`);
          console.log(`  Monthly Consumed:  ${colors.bright}${userData.userUsage.consumed}${colors.reset} units`);
          console.log(`  Monthly Remaining: ${colors.bright}${userData.userUsage.remaining}${colors.reset} units`);
          console.log(`  Monthly Limit:     ${userData.userPlan.monthlyLimit} units`);
          console.log(`  Per-Request Limit: ${userData.userPlan.perRequestLimit} units`);
          break;
        }

        case '4': {
          // ==========================================
          // 4. Change plan settings
          // ==========================================
          console.log(`\n${colors.bright}--- Plan Settings ---${colors.reset}`);
          console.log('1. Modify Account Plan');
          console.log(`2. Modify Active User Plan (${activeUser.name})`);
          console.log('b. Back to main menu');

          const planChoice = (await rl.question('Enter option (1-2, or \'b\'): ')).trim();
          if (planChoice === '1') {
            console.log(`\nUpdating Account Plan for ${account.name}:`);
            const monthlyInput = (await rl.question('Enter new monthly limit (positive integer, or \'b\' to cancel): ')).trim();
            if (monthlyInput.toLowerCase() === 'b' || monthlyInput === '') break;
            const newMonthly = parseInt(monthlyInput, 10);
            if (Number.isNaN(newMonthly) || newMonthly <= 0) {
              console.log(`${colors.red}Invalid monthly limit.${colors.reset}`);
              break;
            }

            const perReqInput = (await rl.question('Enter new per-request limit (positive integer, or \'b\' to cancel): ')).trim();
            if (perReqInput.toLowerCase() === 'b' || perReqInput === '') break;
            const newPerReq = parseInt(perReqInput, 10);
            if (Number.isNaN(newPerReq) || newPerReq <= 0) {
              console.log(`${colors.red}Invalid per-request limit.${colors.reset}`);
              break;
            }

            process.stdout.write('Applying new account plan via API... ');
            const newAccPlanRes = await client.createCustomPlan({
              name: `Acme Account Plan (${newMonthly}m/${newPerReq}r)`,
              type: 'ACCOUNT',
              monthlyLimit: newMonthly,
              perRequestLimit: newPerReq,
            });
            if (!newAccPlanRes.ok || !newAccPlanRes.data?.id) {
              console.log(`${colors.red}FAILED (HTTP ${newAccPlanRes.status})${colors.reset}`);
              break;
            }
            const updateRes = await client.updateAccountPlan(newAccPlanRes.data.id);
            if (!updateRes.ok) {
              console.log(`${colors.red}FAILED to assign plan (HTTP ${updateRes.status})${colors.reset}`);
              break;
            }
            console.log(`${colors.green}OK${colors.reset}`);
            console.log(`${colors.green}✔ Account plan updated successfully (Monthly: ${newMonthly}, Per-Request: ${newPerReq}). New limits active immediately.${colors.reset}`);
          } else if (planChoice === '2') {
            console.log(`\nUpdating Plan for User: ${activeUser.name} (${activeUser.id}):`);
            const monthlyInput = (await rl.question('Enter new monthly limit (positive integer, or \'b\' to cancel): ')).trim();
            if (monthlyInput.toLowerCase() === 'b' || monthlyInput === '') break;
            const newMonthly = parseInt(monthlyInput, 10);
            if (Number.isNaN(newMonthly) || newMonthly <= 0) {
              console.log(`${colors.red}Invalid monthly limit.${colors.reset}`);
              break;
            }

            const perReqInput = (await rl.question('Enter new per-request limit (positive integer, or \'b\' to cancel): ')).trim();
            if (perReqInput.toLowerCase() === 'b' || perReqInput === '') break;
            const newPerReq = parseInt(perReqInput, 10);
            if (Number.isNaN(newPerReq) || newPerReq <= 0) {
              console.log(`${colors.red}Invalid per-request limit.${colors.reset}`);
              break;
            }

            if (!activeUser.isCustomPlan) {
              // Ahmed is on public default plan: create a custom plan and assign it
              console.log(`${colors.dim}Note: ${activeUser.name} is on the default public plan (read-only). Creating and assigning a custom user plan...${colors.reset}`);
              const newCustomPlanRes = await client.createCustomPlan({
                name: `${activeUser.name} Custom Plan`,
                type: 'USER',
                monthlyLimit: newMonthly,
                perRequestLimit: newPerReq,
              });
              if (!newCustomPlanRes.ok || !newCustomPlanRes.data?.id) {
                console.log(`${colors.red}FAILED to create custom plan (HTTP ${newCustomPlanRes.status})${colors.reset}`);
                break;
              }
              const assignRes = await client.updateUserPlan(activeUser.id, newCustomPlanRes.data.id);
              if (!assignRes.ok) {
                console.log(`${colors.red}FAILED to assign custom plan (HTTP ${assignRes.status})${colors.reset}`);
                break;
              }
              activeUser.planId = newCustomPlanRes.data.id;
              activeUser.isCustomPlan = true;
              console.log(`${colors.green}✔ Custom user plan created and assigned to ${activeUser.name} (Monthly: ${newMonthly}, Per-Request: ${newPerReq}). New limits active immediately.${colors.reset}`);
            } else {
              // Sara is already on a custom plan owned by the account: update the custom plan
              process.stdout.write(`Updating existing custom plan ${activeUser.planId} via PATCH /plans/:planId... `);
              const updatePlanRes = await client.updateCustomPlan(activeUser.planId, {
                monthlyLimit: newMonthly,
                perRequestLimit: newPerReq,
              });
              if (!updatePlanRes.ok) {
                console.log(`${colors.red}FAILED (HTTP ${updatePlanRes.status})${colors.reset}`);
                break;
              }
              console.log(`${colors.green}OK${colors.reset}`);
              console.log(`${colors.green}✔ User plan updated successfully (Monthly: ${newMonthly}, Per-Request: ${newPerReq}). New limits active immediately.${colors.reset}`);
            }
          }
          break;
        }

        case '5': {
          // ==========================================
          // 5. Run guided demo
          // ==========================================
          console.log(`\n${colors.bright}${colors.cyan}══════════════════════════════════════════════════════════════════════${colors.reset}`);
          console.log(`${colors.bright}${colors.cyan}  Running Automated Guided Demo Scenario (Independent Account)${colors.reset}`);
          console.log(`${colors.bright}${colors.cyan}══════════════════════════════════════════════════════════════════════${colors.reset}`);
          console.log(`${colors.dim}This scenario runs in its own isolated account without mutating your interactive session.${colors.reset}`);

          try {
            await runDemoScenario(baseUrl);
            console.log(`\n${colors.green}✔ Guided demo completed successfully. Returning to interactive session.${colors.reset}`);
          } catch (err) {
            console.log(`\n${colors.red}✖ Guided demo encountered an error: ${err instanceof Error ? err.message : err}${colors.reset}`);
          }
          break;
        }

        case '0': {
          // ==========================================
          // 0. Exit
          // ==========================================
          console.log(`\n${colors.bright}Exiting interactive session. Goodbye!${colors.reset}`);
          running = false;
          break;
        }

        default: {
          console.log(`${colors.red}Invalid option '${choice}'. Please enter a number between 0 and 5.${colors.reset}`);
          break;
        }
      }
    }
  } finally {
    rl.close();
  }
}

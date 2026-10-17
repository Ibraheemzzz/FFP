// tests/quota-evaluation.test.ts
// اختبارات دالة تقييم قواعد الحصص الأربع (Part 18: Quota Rules Evaluation)

import assert from 'node:assert/strict';
import {
  evaluateQuotaRules,
  type QuotaEvaluationContext,
  type QuotaEvaluationResult,
} from '../src/consumptions.js';

function runQuotaEvaluationTests(): void {
  console.log('--- Starting Quota Rules Evaluation Tests (Part 18) ---');

  // ==========================================
  // Test 1: Full Acceptance (All Rules Permit)
  // ==========================================
  {
    const ctx: QuotaEvaluationContext = {
      requestedUnits: 10,
      accountMonthlyLimit: 100,
      accountPerRequestLimit: 20,
      userMonthlyLimit: 50,
      userPerRequestLimit: 15,
      accountConsumedUnits: 30,
      userConsumedUnits: 10,
    };
    const result: QuotaEvaluationResult = evaluateQuotaRules(ctx);
    assert.deepEqual(result, { accepted: true });

    // Exact boundary matches for per-request limits
    const exactPerRequestCtx: QuotaEvaluationContext = {
      requestedUnits: 25,
      accountMonthlyLimit: 1000,
      accountPerRequestLimit: 25,
      userMonthlyLimit: 500,
      userPerRequestLimit: 25,
      accountConsumedUnits: 0,
      userConsumedUnits: 0,
    };
    assert.deepEqual(evaluateQuotaRules(exactPerRequestCtx), { accepted: true });

    // Exact boundary matches for monthly allowances
    const exactMonthlyCtx: QuotaEvaluationContext = {
      requestedUnits: 10,
      accountMonthlyLimit: 100,
      accountPerRequestLimit: 50,
      userMonthlyLimit: 50,
      userPerRequestLimit: 50,
      accountConsumedUnits: 90, // 100 - 90 = 10 exactly
      userConsumedUnits: 40,    // 50 - 40 = 10 exactly
    };
    assert.deepEqual(evaluateQuotaRules(exactMonthlyCtx), { accepted: true });

    console.log('✔ Test 1: Full acceptance and exact boundary matches passed');
  }

  // ==========================================
  // Test 2: Rejection by Account Per-Request Limit (account / max_per_request)
  // ==========================================
  {
    const ctx: QuotaEvaluationContext = {
      requestedUnits: 21,
      accountMonthlyLimit: 1000,
      accountPerRequestLimit: 20, // exceeds by 1
      userMonthlyLimit: 500,
      userPerRequestLimit: 50,
      accountConsumedUnits: 0,
      userConsumedUnits: 0,
    };
    const result = evaluateQuotaRules(ctx);
    assert.deepEqual(result, {
      accepted: false,
      reason: { scope: 'account', rule: 'max_per_request' },
    });

    console.log('✔ Test 2: Account per-request limit rejection passed');
  }

  // ==========================================
  // Test 3: Rejection by User Per-Request Limit (user / max_per_request)
  // ==========================================
  {
    const ctx: QuotaEvaluationContext = {
      requestedUnits: 16,
      accountMonthlyLimit: 1000,
      accountPerRequestLimit: 50, // allows
      userMonthlyLimit: 500,
      userPerRequestLimit: 15,    // exceeds by 1
      accountConsumedUnits: 0,
      userConsumedUnits: 0,
    };
    const result = evaluateQuotaRules(ctx);
    assert.deepEqual(result, {
      accepted: false,
      reason: { scope: 'user', rule: 'max_per_request' },
    });

    console.log('✔ Test 3: User per-request limit rejection passed');
  }

  // ==========================================
  // Test 4: Rejection by Account Monthly Allowance (account / monthly_allowance)
  // (Ensuring per-request limits allow the amount so they don't hide the monthly rejection)
  // ==========================================
  {
    const ctx: QuotaEvaluationContext = {
      requestedUnits: 15,
      accountMonthlyLimit: 100,
      accountPerRequestLimit: 200, // generously allows 15
      userMonthlyLimit: 100,
      userPerRequestLimit: 200,    // generously allows 15
      accountConsumedUnits: 90,    // remaining is 10, requested is 15 -> exceeds
      userConsumedUnits: 10,       // remaining is 90 -> allows
    };
    const result = evaluateQuotaRules(ctx);
    assert.deepEqual(result, {
      accepted: false,
      reason: { scope: 'account', rule: 'monthly_allowance' },
    });

    console.log('✔ Test 4: Account monthly allowance rejection (with unblocking per-request limits) passed');
  }

  // ==========================================
  // Test 5: Rejection by User Monthly Allowance (user / monthly_allowance)
  // (Ensuring per-request limits and account monthly allowance allow the amount)
  // ==========================================
  {
    const ctx: QuotaEvaluationContext = {
      requestedUnits: 15,
      accountMonthlyLimit: 200,
      accountPerRequestLimit: 200, // generously allows
      userMonthlyLimit: 50,
      userPerRequestLimit: 200,    // generously allows
      accountConsumedUnits: 20,    // remaining is 180 -> allows
      userConsumedUnits: 40,       // remaining is 10, requested is 15 -> exceeds
    };
    const result = evaluateQuotaRules(ctx);
    assert.deepEqual(result, {
      accepted: false,
      reason: { scope: 'user', rule: 'monthly_allowance' },
    });

    console.log('✔ Test 5: User monthly allowance rejection (with unblocking prior limits) passed');
  }

  // ==========================================
  // Test 6: Deterministic Evaluation Order on Multiple Violations
  // ==========================================
  {
    // Violation of ALL 4 rules simultaneously -> Must reject by Rule 1 (account / max_per_request)
    const allViolatedCtx: QuotaEvaluationContext = {
      requestedUnits: 100,
      accountMonthlyLimit: 50,
      accountPerRequestLimit: 10,  // Rule 1 violated
      userMonthlyLimit: 40,
      userPerRequestLimit: 15,     // Rule 2 violated
      accountConsumedUnits: 45,    // Rule 3 violated
      userConsumedUnits: 35,       // Rule 4 violated
    };
    assert.deepEqual(evaluateQuotaRules(allViolatedCtx), {
      accepted: false,
      reason: { scope: 'account', rule: 'max_per_request' },
    });

    // Rule 1 passes, but Rules 2, 3, 4 violated -> Must reject by Rule 2 (user / max_per_request)
    const userPerRequestViolatedCtx: QuotaEvaluationContext = {
      requestedUnits: 25,
      accountMonthlyLimit: 50,
      accountPerRequestLimit: 30,  // Rule 1 passes (30 >= 25)
      userMonthlyLimit: 40,
      userPerRequestLimit: 20,     // Rule 2 violated
      accountConsumedUnits: 45,    // Rule 3 violated
      userConsumedUnits: 35,       // Rule 4 violated
    };
    assert.deepEqual(evaluateQuotaRules(userPerRequestViolatedCtx), {
      accepted: false,
      reason: { scope: 'user', rule: 'max_per_request' },
    });

    // Rules 1 and 2 pass, but Rules 3 and 4 violated -> Must reject by Rule 3 (account / monthly_allowance)
    const bothMonthlyViolatedCtx: QuotaEvaluationContext = {
      requestedUnits: 20,
      accountMonthlyLimit: 50,
      accountPerRequestLimit: 100, // Rule 1 passes
      userMonthlyLimit: 40,
      userPerRequestLimit: 100,    // Rule 2 passes
      accountConsumedUnits: 40,    // Rule 3 violated (50 - 40 = 10 < 20)
      userConsumedUnits: 30,       // Rule 4 violated (40 - 30 = 10 < 20)
    };
    assert.deepEqual(evaluateQuotaRules(bothMonthlyViolatedCtx), {
      accepted: false,
      reason: { scope: 'account', rule: 'monthly_allowance' },
    });

    console.log('✔ Test 6: Deterministic rule evaluation precedence verified');
  }

  // ==========================================
  // Test 7: User Limit Greater than Account Limit (Account Limit Remains Binding)
  // ==========================================
  {
    // User monthly limit (500) > Account monthly limit (100)
    // User has consumed only 10 (remaining 490), but Account has consumed 95 (remaining 5)
    // Request is 10: User has capacity, but Account does not. Must reject with account / monthly_allowance.
    const userGreaterMonthlyCtx: QuotaEvaluationContext = {
      requestedUnits: 10,
      accountMonthlyLimit: 100,
      accountPerRequestLimit: 200,
      userMonthlyLimit: 500, // User plan is larger than account!
      userPerRequestLimit: 200,
      accountConsumedUnits: 95, // 100 - 95 = 5 < 10
      userConsumedUnits: 10,    // 500 - 10 = 490 >= 10
    };
    assert.deepEqual(evaluateQuotaRules(userGreaterMonthlyCtx), {
      accepted: false,
      reason: { scope: 'account', rule: 'monthly_allowance' },
    });

    // User per-request limit (100) > Account per-request limit (10)
    // Request is 15: User per-request allows, but Account per-request restricts.
    const userGreaterPerRequestCtx: QuotaEvaluationContext = {
      requestedUnits: 15,
      accountMonthlyLimit: 1000,
      accountPerRequestLimit: 10, // Account restricts
      userMonthlyLimit: 1000,
      userPerRequestLimit: 100,   // User allows
      accountConsumedUnits: 0,
      userConsumedUnits: 0,
    };
    assert.deepEqual(evaluateQuotaRules(userGreaterPerRequestCtx), {
      accepted: false,
      reason: { scope: 'account', rule: 'max_per_request' },
    });

    console.log('✔ Test 7: User limit higher than account limit proves account limit remains binding');
  }

  // ==========================================
  // Test 8: Plan Downgraded Below Current Consumption (Negative Subtraction)
  // ==========================================
  {
    // Account was downgraded from 100 to 50, but already consumed 70 units
    // limit - consumed = 50 - 70 = -20.
    // Any positive requestedUnits (> 0) must be rejected with monthly_allowance.
    const downgradedAccountCtx: QuotaEvaluationContext = {
      requestedUnits: 1,
      accountMonthlyLimit: 50,
      accountPerRequestLimit: 100,
      userMonthlyLimit: 100,
      userPerRequestLimit: 100,
      accountConsumedUnits: 70, // consumed > limit
      userConsumedUnits: 10,
    };
    assert.deepEqual(evaluateQuotaRules(downgradedAccountCtx), {
      accepted: false,
      reason: { scope: 'account', rule: 'monthly_allowance' },
    });

    // User was downgraded from 50 to 20, but already consumed 25 units
    const downgradedUserCtx: QuotaEvaluationContext = {
      requestedUnits: 1,
      accountMonthlyLimit: 500,
      accountPerRequestLimit: 100,
      userMonthlyLimit: 20,
      userPerRequestLimit: 100,
      accountConsumedUnits: 30,
      userConsumedUnits: 25, // consumed > limit
    };
    assert.deepEqual(evaluateQuotaRules(downgradedUserCtx), {
      accepted: false,
      reason: { scope: 'user', rule: 'monthly_allowance' },
    });

    console.log('✔ Test 8: Plan downgrade below current consumption rejected cleanly via subtraction');
  }

  // ==========================================
  // Test 9: Zero-Limit Plans (Paused Usage)
  // ==========================================
  {
    // Zero per-request limit
    const zeroPerReqCtx: QuotaEvaluationContext = {
      requestedUnits: 1,
      accountMonthlyLimit: 100,
      accountPerRequestLimit: 0,
      userMonthlyLimit: 100,
      userPerRequestLimit: 100,
      accountConsumedUnits: 0,
      userConsumedUnits: 0,
    };
    assert.deepEqual(evaluateQuotaRules(zeroPerReqCtx), {
      accepted: false,
      reason: { scope: 'account', rule: 'max_per_request' },
    });

    // Zero monthly limit
    const zeroMonthlyCtx: QuotaEvaluationContext = {
      requestedUnits: 1,
      accountMonthlyLimit: 0,
      accountPerRequestLimit: 10,
      userMonthlyLimit: 10,
      userPerRequestLimit: 10,
      accountConsumedUnits: 0,
      userConsumedUnits: 0,
    };
    assert.deepEqual(evaluateQuotaRules(zeroMonthlyCtx), {
      accepted: false,
      reason: { scope: 'account', rule: 'monthly_allowance' },
    });

    console.log('✔ Test 9: Zero-limit plan rejections passed');
  }

  // ==========================================
  // Test 10: Near Number.MAX_SAFE_INTEGER Calculations
  // ==========================================
  {
    const maxSafe = Number.MAX_SAFE_INTEGER; // 9,007,199,254,740,991

    // Consumed: maxSafe - 10, Requested: 10 -> exactly maxSafe -> Accepted
    const maxSafeAcceptCtx: QuotaEvaluationContext = {
      requestedUnits: 10,
      accountMonthlyLimit: maxSafe,
      accountPerRequestLimit: maxSafe,
      userMonthlyLimit: maxSafe,
      userPerRequestLimit: maxSafe,
      accountConsumedUnits: maxSafe - 10,
      userConsumedUnits: maxSafe - 10,
    };
    assert.deepEqual(evaluateQuotaRules(maxSafeAcceptCtx), { accepted: true });

    // Consumed: maxSafe - 10, Requested: 11 -> exceeds maxSafe by 1 -> Rejected
    // Subtraction: maxSafe - (maxSafe - 10) = 10. requestedUnits (11) > 10.
    // If addition were used (maxSafe - 10 + 11 = maxSafe + 1), it would exceed safe integer range!
    const maxSafeRejectCtx: QuotaEvaluationContext = {
      requestedUnits: 11,
      accountMonthlyLimit: maxSafe,
      accountPerRequestLimit: maxSafe,
      userMonthlyLimit: maxSafe,
      userPerRequestLimit: maxSafe,
      accountConsumedUnits: maxSafe - 10,
      userConsumedUnits: 0,
    };
    assert.deepEqual(evaluateQuotaRules(maxSafeRejectCtx), {
      accepted: false,
      reason: { scope: 'account', rule: 'monthly_allowance' },
    });

    console.log('✔ Test 10: Near MAX_SAFE_INTEGER calculations and safe subtraction verified');
  }

  // ==========================================
  // Test 11: Context Immutability (Input Object is Never Mutated)
  // ==========================================
  {
    const frozenCtx: QuotaEvaluationContext = Object.freeze({
      requestedUnits: 5,
      accountMonthlyLimit: 100,
      accountPerRequestLimit: 50,
      userMonthlyLimit: 50,
      userPerRequestLimit: 25,
      accountConsumedUnits: 10,
      userConsumedUnits: 5,
    });

    // Should execute on frozen object without error
    const result = evaluateQuotaRules(frozenCtx);
    assert.deepEqual(result, { accepted: true });

    // Verify properties remain identical
    assert.equal(frozenCtx.requestedUnits, 5);
    assert.equal(frozenCtx.accountConsumedUnits, 10);
    assert.equal(frozenCtx.userConsumedUnits, 5);

    console.log('✔ Test 11: Context immutability verified');
  }

  console.log('All Quota Rules Evaluation Tests (Part 18) Passed Successfully!');
}

runQuotaEvaluationTests();

// tests/plans.test.ts
import assert from 'node:assert/strict';
import {
  validatePlanDefinition,
  PlanValidationError,
  type PlanType,
  type PlanDefinitionInput,
} from '../src/plans.js';

function runPlanDefinitionTests(): void {
  // ==========================================
  // Test 1: Valid Plan Definitions
  // ==========================================
  const validAccountPlan: PlanDefinitionInput = validatePlanDefinition({
    name: 'Standard Account Plan',
    type: 'ACCOUNT',
    monthlyLimit: 100000,
    perRequestLimit: 1000,
  });
  assert.equal(validAccountPlan.name, 'Standard Account Plan');
  assert.equal(validAccountPlan.type, 'ACCOUNT');
  assert.equal(validAccountPlan.monthlyLimit, 100000);
  assert.equal(validAccountPlan.perRequestLimit, 1000);

  const validUserPlan: PlanDefinitionInput = validatePlanDefinition({
    name: '   Standard User Plan   ',
    type: 'USER',
    monthlyLimit: 5000,
    perRequestLimit: 250,
  });
  assert.equal(validUserPlan.name, 'Standard User Plan', 'name should be trimmed');
  assert.equal(validUserPlan.type, 'USER');
  assert.equal(validUserPlan.monthlyLimit, 5000);
  assert.equal(validUserPlan.perRequestLimit, 250);
  console.log('✔ Valid plan definitions for ACCOUNT and USER passed');

  // ==========================================
  // Test 2: Boundary cases - Zero Limits and perRequestLimit > monthlyLimit
  // ==========================================
  const zeroLimitPlan = validatePlanDefinition({
    name: 'Paused Plan',
    type: 'ACCOUNT',
    monthlyLimit: 0,
    perRequestLimit: 0,
  });
  assert.equal(zeroLimitPlan.monthlyLimit, 0, 'Zero monthly limit must be accepted');
  assert.equal(zeroLimitPlan.perRequestLimit, 0, 'Zero per-request limit must be accepted');

  const invertedLimitsPlan = validatePlanDefinition({
    name: 'High Burst Plan',
    type: 'USER',
    monthlyLimit: 50,
    perRequestLimit: 100,
  });
  assert.equal(invertedLimitsPlan.monthlyLimit, 50);
  assert.equal(invertedLimitsPlan.perRequestLimit, 100);
  assert.ok(
    invertedLimitsPlan.perRequestLimit > invertedLimitsPlan.monthlyLimit,
    'perRequestLimit > monthlyLimit is valid and permitted'
  );

  const maxSafeIntegerPlan = validatePlanDefinition({
    name: 'Max Safe Plan',
    type: 'ACCOUNT',
    monthlyLimit: Number.MAX_SAFE_INTEGER,
    perRequestLimit: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(maxSafeIntegerPlan.monthlyLimit, 9007199254740991);
  assert.equal(maxSafeIntegerPlan.perRequestLimit, 9007199254740991);
  console.log('✔ Boundary cases (zero limits, perRequestLimit > monthlyLimit, MAX_SAFE_INTEGER) passed');

  // ==========================================
  // Test 3: Invalid Body Shapes
  // ==========================================
  const invalidBodies = [
    { val: null, desc: 'null' },
    { val: undefined, desc: 'undefined' },
    { val: [1, 2, 3], desc: 'array' },
    { val: 'string', desc: 'primitive string' },
    { val: 12345, desc: 'primitive number' },
    { val: true, desc: 'boolean' },
  ];
  for (const testCase of invalidBodies) {
    assert.throws(
      () => validatePlanDefinition(testCase.val),
      (err: unknown) => {
        assert.ok(err instanceof PlanValidationError);
        assert.equal(err.message, 'Request body must be a valid JSON object');
        return true;
      },
      `Body with ${testCase.desc} must throw PlanValidationError`
    );
  }
  console.log('✔ Invalid body shapes rejection passed');

  // ==========================================
  // Test 4: Unknown and Case-Mismatched Fields Rejection
  // ==========================================
  const unknownFieldCases = [
    {
      payload: {
        name: 'Test Plan',
        type: 'ACCOUNT',
        monthlyLimit: 100,
        perRequestLimit: 10,
        extraProp: 'not_allowed',
      },
      expectedField: 'extraProp',
    },
    {
      payload: {
        Name: 'Test Plan',
        type: 'ACCOUNT',
        monthlyLimit: 100,
        perRequestLimit: 10,
      },
      expectedField: 'Name',
    },
    {
      payload: {
        name: 'Test Plan',
        Type: 'ACCOUNT',
        monthlyLimit: 100,
        perRequestLimit: 10,
      },
      expectedField: 'Type',
    },
    {
      payload: {
        name: 'Test Plan',
        type: 'ACCOUNT',
        MonthlyLimit: 100,
        perRequestLimit: 10,
      },
      expectedField: 'MonthlyLimit',
    },
    {
      payload: {
        name: 'Test Plan',
        type: 'ACCOUNT',
        monthlyLimit: 100,
        PerRequestLimit: 10,
      },
      expectedField: 'PerRequestLimit',
    },
    {
      payload: {
        name: 'Test Plan',
        type: 'ACCOUNT',
        monthlyLimit: 100,
        perRequestLimit: 10,
        monthly_limit: 100,
      },
      expectedField: 'monthly_limit',
    },
  ];
  for (const testCase of unknownFieldCases) {
    assert.throws(
      () => validatePlanDefinition(testCase.payload),
      (err: unknown) => {
        assert.ok(err instanceof PlanValidationError);
        assert.equal(err.message, `Unknown field: ${testCase.expectedField}`);
        return true;
      }
    );
  }
  console.log('✔ Strict unknown and case-mismatched field rejection passed');

  // ==========================================
  // Test 5: Name Validation
  // ==========================================
  const invalidNameCases = [
    {
      payload: { type: 'ACCOUNT', monthlyLimit: 100, perRequestLimit: 10 },
      expectedErr: 'name is required',
    },
    {
      payload: { name: 12345, type: 'ACCOUNT', monthlyLimit: 100, perRequestLimit: 10 },
      expectedErr: 'name must be a string',
    },
    {
      payload: { name: '', type: 'ACCOUNT', monthlyLimit: 100, perRequestLimit: 10 },
      expectedErr: 'name must not be empty',
    },
    {
      payload: { name: '     ', type: 'ACCOUNT', monthlyLimit: 100, perRequestLimit: 10 },
      expectedErr: 'name must not be empty',
    },
    {
      payload: { name: 'n'.repeat(101), type: 'ACCOUNT', monthlyLimit: 100, perRequestLimit: 10 },
      expectedErr: 'name must not exceed 100 characters',
    },
  ];
  for (const testCase of invalidNameCases) {
    assert.throws(
      () => validatePlanDefinition(testCase.payload),
      (err: unknown) => {
        assert.ok(err instanceof PlanValidationError);
        assert.equal(err.message, testCase.expectedErr);
        return true;
      }
    );
  }
  console.log('✔ Name validation tests passed');

  // ==========================================
  // Test 6: Type Validation
  // ==========================================
  const invalidTypeCases = [
    {
      payload: { name: 'Plan', monthlyLimit: 100, perRequestLimit: 10 },
      expectedErr: 'type is required',
    },
    {
      payload: { name: 'Plan', type: 123, monthlyLimit: 100, perRequestLimit: 10 },
      expectedErr: 'type must be a string',
    },
    {
      payload: { name: 'Plan', type: 'account', monthlyLimit: 100, perRequestLimit: 10 },
      expectedErr: "type must be either 'ACCOUNT' or 'USER'",
    },
    {
      payload: { name: 'Plan', type: 'user', monthlyLimit: 100, perRequestLimit: 10 },
      expectedErr: "type must be either 'ACCOUNT' or 'USER'",
    },
    {
      payload: { name: 'Plan', type: 'ORGANIZATION', monthlyLimit: 100, perRequestLimit: 10 },
      expectedErr: "type must be either 'ACCOUNT' or 'USER'",
    },
  ];
  for (const testCase of invalidTypeCases) {
    assert.throws(
      () => validatePlanDefinition(testCase.payload),
      (err: unknown) => {
        assert.ok(err instanceof PlanValidationError);
        assert.equal(err.message, testCase.expectedErr);
        return true;
      }
    );
  }
  console.log('✔ Type validation tests passed');

  // ==========================================
  // Test 7: MonthlyLimit Validation
  // ==========================================
  const invalidMonthlyLimitCases = [
    {
      payload: { name: 'Plan', type: 'ACCOUNT', perRequestLimit: 10 },
      expectedErr: 'monthlyLimit is required',
    },
    {
      payload: { name: 'Plan', type: 'ACCOUNT', monthlyLimit: '100', perRequestLimit: 10 },
      expectedErr: 'monthlyLimit must be a safe integer',
    },
    {
      payload: { name: 'Plan', type: 'ACCOUNT', monthlyLimit: true, perRequestLimit: 10 },
      expectedErr: 'monthlyLimit must be a safe integer',
    },
    {
      payload: { name: 'Plan', type: 'ACCOUNT', monthlyLimit: 100.5, perRequestLimit: 10 },
      expectedErr: 'monthlyLimit must be a safe integer',
    },
    {
      payload: { name: 'Plan', type: 'ACCOUNT', monthlyLimit: -1, perRequestLimit: 10 },
      expectedErr: 'monthlyLimit must not be negative',
    },
    {
      payload: { name: 'Plan', type: 'ACCOUNT', monthlyLimit: Number.MAX_SAFE_INTEGER + 1, perRequestLimit: 10 },
      expectedErr: 'monthlyLimit must be a safe integer',
    },
    {
      payload: { name: 'Plan', type: 'ACCOUNT', monthlyLimit: NaN, perRequestLimit: 10 },
      expectedErr: 'monthlyLimit must be a safe integer',
    },
    {
      payload: { name: 'Plan', type: 'ACCOUNT', monthlyLimit: Infinity, perRequestLimit: 10 },
      expectedErr: 'monthlyLimit must be a safe integer',
    },
  ];
  for (const testCase of invalidMonthlyLimitCases) {
    assert.throws(
      () => validatePlanDefinition(testCase.payload),
      (err: unknown) => {
        assert.ok(err instanceof PlanValidationError);
        assert.equal(err.message, testCase.expectedErr);
        return true;
      }
    );
  }
  console.log('✔ MonthlyLimit validation tests passed');

  // ==========================================
  // Test 8: PerRequestLimit Validation
  // ==========================================
  const invalidPerRequestLimitCases = [
    {
      payload: { name: 'Plan', type: 'USER', monthlyLimit: 100 },
      expectedErr: 'perRequestLimit is required',
    },
    {
      payload: { name: 'Plan', type: 'USER', monthlyLimit: 100, perRequestLimit: '10' },
      expectedErr: 'perRequestLimit must be a safe integer',
    },
    {
      payload: { name: 'Plan', type: 'USER', monthlyLimit: 100, perRequestLimit: 10.25 },
      expectedErr: 'perRequestLimit must be a safe integer',
    },
    {
      payload: { name: 'Plan', type: 'USER', monthlyLimit: 100, perRequestLimit: -5 },
      expectedErr: 'perRequestLimit must not be negative',
    },
    {
      payload: { name: 'Plan', type: 'USER', monthlyLimit: 100, perRequestLimit: Number.MAX_SAFE_INTEGER + 10 },
      expectedErr: 'perRequestLimit must be a safe integer',
    },
    {
      payload: { name: 'Plan', type: 'USER', monthlyLimit: 100, perRequestLimit: NaN },
      expectedErr: 'perRequestLimit must be a safe integer',
    },
  ];
  for (const testCase of invalidPerRequestLimitCases) {
    assert.throws(
      () => validatePlanDefinition(testCase.payload),
      (err: unknown) => {
        assert.ok(err instanceof PlanValidationError);
        assert.equal(err.message, testCase.expectedErr);
        return true;
      }
    );
  }
  console.log('✔ PerRequestLimit validation tests passed');

  console.log('\nAll plan definition tests passed successfully.');
}

runPlanDefinitionTests();

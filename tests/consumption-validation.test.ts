// tests/consumption-validation.test.ts
// اختبارات التحقق من مدخلات طلب الاستهلاك (Part 16: Consumption Input Validation)

import assert from 'node:assert/strict';
import {
  validateConsumptionInput,
  ConsumptionValidationError,
} from '../src/consumptions.js';

function runConsumptionValidationTests(): void {
  console.log('--- Starting Consumption Input Validation Tests (Part 16) ---');

  // ==========================================
  // Test 1: Valid Consumption Inputs
  // ==========================================
  {
    const valid = validateConsumptionInput({
      userId: 'usr_abc123',
      units: 5,
      requestId: 'req_20261016_001',
    });
    assert.equal(valid.userId, 'usr_abc123');
    assert.equal(valid.units, 5);
    assert.equal(valid.requestId, 'req_20261016_001');

    // Minimal positive units (1)
    const minUnits = validateConsumptionInput({
      userId: 'usr_1',
      units: 1,
      requestId: 'req_1',
    });
    assert.equal(minUnits.units, 1);

    // Maximum safe integer units
    const maxUnits = validateConsumptionInput({
      userId: 'usr_1',
      units: Number.MAX_SAFE_INTEGER,
      requestId: 'req_1',
    });
    assert.equal(maxUnits.units, Number.MAX_SAFE_INTEGER);

    // Trimming whitespace from both identifiers
    const trimmed = validateConsumptionInput({
      userId: '   usr_padded   ',
      units: 10,
      requestId: '   req_padded   ',
    });
    assert.equal(trimmed.userId, 'usr_padded', 'userId must be trimmed');
    assert.equal(trimmed.requestId, 'req_padded', 'requestId must be trimmed for idempotency identity');

    console.log('✔ Test 1: Valid consumption requests and trimming passed');
  }

  // ==========================================
  // Test 2: Exact Boundary Limits for Identifier Lengths (64 and 128)
  // ==========================================
  {
    const id64 = 'u'.repeat(64);
    const id65 = 'u'.repeat(65);
    const req128 = 'r'.repeat(128);
    const req129 = 'r'.repeat(129);

    // 64-char userId accepted
    const res64 = validateConsumptionInput({
      userId: id64,
      units: 2,
      requestId: 'req_test',
    });
    assert.equal(res64.userId.length, 64);

    // 65-char userId rejected
    assert.throws(
      () => {
        validateConsumptionInput({
          userId: id65,
          units: 2,
          requestId: 'req_test',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ConsumptionValidationError);
        assert.match(err.message, /userId must not exceed 64 characters/);
        return true;
      }
    );

    // 128-char requestId accepted
    const res128 = validateConsumptionInput({
      userId: 'usr_test',
      units: 2,
      requestId: req128,
    });
    assert.equal(res128.requestId.length, 128);

    // 129-char requestId rejected
    assert.throws(
      () => {
        validateConsumptionInput({
          userId: 'usr_test',
          units: 2,
          requestId: req129,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ConsumptionValidationError);
        assert.match(err.message, /requestId must not exceed 128 characters/);
        return true;
      }
    );

    // Padded 64-char string that trims to 64 is accepted
    const padded64 = `   ${id64}   `;
    const resPadded64 = validateConsumptionInput({
      userId: padded64,
      units: 2,
      requestId: 'req_test',
    });
    assert.equal(resPadded64.userId, id64);

    // Padded 128-char string that trims to 128 is accepted
    const padded128 = `   ${req128}   `;
    const resPadded128 = validateConsumptionInput({
      userId: 'usr_test',
      units: 2,
      requestId: padded128,
    });
    assert.equal(resPadded128.requestId, req128);

    console.log('✔ Test 2: Boundary limits (64 chars for userId, 128 chars for requestId) passed');
  }

  // ==========================================
  // Test 3: Units Validation (Zero, Negatives, Floats, Strings, Unsafe Integers)
  // ==========================================
  {
    const invalidUnitsCases = [
      { val: 0, label: 'zero (0)' },
      { val: -1, label: 'negative integer (-1)' },
      { val: -100, label: 'large negative integer (-100)' },
      { val: 1.5, label: 'float (1.5)' },
      { val: 0.1, label: 'small float (0.1)' },
      { val: '10', label: 'numeric string ("10")' },
      { val: '1', label: 'numeric string ("1")' },
      { val: true, label: 'boolean (true)' },
      { val: false, label: 'boolean (false)' },
      { val: null, label: 'null' },
      { val: Number.MAX_SAFE_INTEGER + 1, label: 'unsafe integer (MAX_SAFE_INTEGER + 1)' },
    ];

    for (const { val, label } of invalidUnitsCases) {
      assert.throws(
        () => {
          validateConsumptionInput({
            userId: 'usr_1',
            units: val,
            requestId: 'req_1',
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ConsumptionValidationError, `Expected ConsumptionValidationError for units: ${label}`);
          return true;
        },
        `Should reject units value: ${label}`
      );
    }

    console.log('✔ Test 3: Units validation (rejection of zero, negative, floats, strings, unsafe ints) passed');
  }

  // ==========================================
  // Test 4: Direct Function Testing for Non-JSON Values (NaN, Infinity, undefined)
  // ==========================================
  {
    // NaN
    assert.throws(
      () => {
        validateConsumptionInput({
          userId: 'usr_1',
          units: NaN,
          requestId: 'req_1',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ConsumptionValidationError);
        assert.match(err.message, /units must be a positive safe integer/);
        return true;
      },
      'Should reject NaN directly'
    );

    // Infinity
    assert.throws(
      () => {
        validateConsumptionInput({
          userId: 'usr_1',
          units: Infinity,
          requestId: 'req_1',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ConsumptionValidationError);
        assert.match(err.message, /units must be a positive safe integer/);
        return true;
      },
      'Should reject Infinity directly'
    );

    // -Infinity
    assert.throws(
      () => {
        validateConsumptionInput({
          userId: 'usr_1',
          units: -Infinity,
          requestId: 'req_1',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ConsumptionValidationError);
        assert.match(err.message, /units must be a positive safe integer/);
        return true;
      },
      'Should reject -Infinity directly'
    );

    // units: undefined
    assert.throws(
      () => {
        validateConsumptionInput({
          userId: 'usr_1',
          units: undefined,
          requestId: 'req_1',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ConsumptionValidationError);
        assert.match(err.message, /units is required/);
        return true;
      },
      'Should reject undefined units directly'
    );

    console.log('✔ Test 4: Direct testing for non-JSON values (NaN, Infinity, -Infinity, undefined) passed');
  }

  // ==========================================
  // Test 5: userId Invalid Cases (Empty, Whitespace, Non-String, Missing)
  // ==========================================
  {
    // Missing userId
    assert.throws(
      () => {
        validateConsumptionInput({
          units: 1,
          requestId: 'req_1',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ConsumptionValidationError);
        assert.match(err.message, /userId is required/);
        return true;
      }
    );

    // Empty userId
    assert.throws(
      () => {
        validateConsumptionInput({
          userId: '',
          units: 1,
          requestId: 'req_1',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ConsumptionValidationError);
        assert.match(err.message, /userId must not be empty/);
        return true;
      }
    );

    // Whitespace-only userId
    assert.throws(
      () => {
        validateConsumptionInput({
          userId: '    ',
          units: 1,
          requestId: 'req_1',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ConsumptionValidationError);
        assert.match(err.message, /userId must not be empty/);
        return true;
      }
    );

    // Non-string userId
    const nonStringUsers = [123, true, {}, [], null];
    for (const val of nonStringUsers) {
      assert.throws(
        () => {
          validateConsumptionInput({
            userId: val,
            units: 1,
            requestId: 'req_1',
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ConsumptionValidationError);
          return true;
        }
      );
    }

    console.log('✔ Test 5: userId validation cases passed');
  }

  // ==========================================
  // Test 6: requestId Invalid Cases (Empty, Whitespace, Non-String, Missing)
  // ==========================================
  {
    // Missing requestId
    assert.throws(
      () => {
        validateConsumptionInput({
          userId: 'usr_1',
          units: 1,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ConsumptionValidationError);
        assert.match(err.message, /requestId is required/);
        return true;
      }
    );

    // Empty requestId
    assert.throws(
      () => {
        validateConsumptionInput({
          userId: 'usr_1',
          units: 1,
          requestId: '',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ConsumptionValidationError);
        assert.match(err.message, /requestId must not be empty/);
        return true;
      }
    );

    // Whitespace-only requestId
    assert.throws(
      () => {
        validateConsumptionInput({
          userId: 'usr_1',
          units: 1,
          requestId: '    ',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ConsumptionValidationError);
        assert.match(err.message, /requestId must not be empty/);
        return true;
      }
    );

    // Non-string requestId
    const nonStringReqs = [123, true, {}, [], null];
    for (const val of nonStringReqs) {
      assert.throws(
        () => {
          validateConsumptionInput({
            userId: 'usr_1',
            units: 1,
            requestId: val,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ConsumptionValidationError);
          return true;
        }
      );
    }

    console.log('✔ Test 6: requestId validation cases passed');
  }

  // ==========================================
  // Test 7: Body Structure & Strict Unknown/Extra Fields Rejection
  // ==========================================
  {
    // Body is not an object
    const nonObjectBodies = [null, undefined, [], 'string', 12345, true];
    for (const body of nonObjectBodies) {
      assert.throws(
        () => {
          validateConsumptionInput(body);
        },
        (err: unknown) => {
          assert.ok(err instanceof ConsumptionValidationError);
          assert.match(err.message, /Request body must be a JSON object/);
          return true;
        }
      );
    }

    // Extra unknown field
    assert.throws(
      () => {
        validateConsumptionInput({
          userId: 'usr_1',
          units: 1,
          requestId: 'req_1',
          extraField: 'unexpected',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ConsumptionValidationError);
        assert.match(err.message, /Unknown field: extraField/);
        return true;
      }
    );

    // Injected tenant field (accountId)
    assert.throws(
      () => {
        validateConsumptionInput({
          userId: 'usr_1',
          units: 1,
          requestId: 'req_1',
          accountId: 'acc_spoof',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ConsumptionValidationError);
        assert.match(err.message, /Unknown field: accountId/);
        return true;
      }
    );

    // Case mismatches in field names
    const caseMismatches = [
      { key: 'userid', payload: { userid: 'usr_1', units: 1, requestId: 'req_1' } },
      { key: 'Units', payload: { userId: 'usr_1', Units: 1, requestId: 'req_1' } },
      { key: 'RequestId', payload: { userId: 'usr_1', units: 1, RequestId: 'req_1' } },
      { key: 'user_id', payload: { user_id: 'usr_1', units: 1, requestId: 'req_1' } },
      { key: 'request_id', payload: { userId: 'usr_1', units: 1, request_id: 'req_1' } },
    ];

    for (const { key, payload } of caseMismatches) {
      assert.throws(
        () => {
          validateConsumptionInput(payload);
        },
        (err: unknown) => {
          assert.ok(err instanceof ConsumptionValidationError);
          assert.match(err.message, new RegExp(`Unknown field: ${key}`));
          return true;
        },
        `Should reject case mismatch field: ${key}`
      );
    }

    console.log('✔ Test 7: Body structure and strict unknown/case-mismatch fields rejection passed');
  }

  console.log('All Consumption Input Validation Tests (Part 16) Passed Successfully!');
}

runConsumptionValidationTests();

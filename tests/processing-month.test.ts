// tests/processing-month.test.ts
// Tests for processing month determination (Part 17: Processing Month)

import assert from 'node:assert/strict';
import { getUtcYearMonth } from '../src/consumptions.js';

function runProcessingMonthTests(): void {
  console.log('--- Starting Processing Month Tests (Part 17) ---');

  // ==========================================
  // Test 1: Timezone Offset where local month differs from UTC month
  // ==========================================
  {
    // 2026-11-01 at 00:30 in UTC+03:00 is 2026-10-31 at 21:30:00.000Z in UTC
    const dateWithOffset = new Date('2026-11-01T00:30:00+03:00');
    const result = getUtcYearMonth(dateWithOffset);
    assert.equal(result, '2026-10', 'Should extract UTC month (October) despite local time being in November');

    // 2026-05-01 at 01:00 in UTC+04:00 is 2026-04-30 at 21:00:00.000Z in UTC
    const dateAprilMay = new Date('2026-05-01T01:00:00+04:00');
    assert.equal(getUtcYearMonth(dateAprilMay), '2026-04');

    console.log('✔ Test 1: Timezone offset handling (UTC priority) passed');
  }

  // ==========================================
  // Test 2: Month Boundaries at 23:59:59.999Z vs 00:00:00.000Z
  // ==========================================
  {
    const endOfOctober = new Date('2026-10-31T23:59:59.999Z');
    assert.equal(getUtcYearMonth(endOfOctober), '2026-10');

    const startOfNovember = new Date('2026-11-01T00:00:00.000Z');
    assert.equal(getUtcYearMonth(startOfNovember), '2026-11');

    const endOfJanuary = new Date('2026-01-31T23:59:59.999Z');
    assert.equal(getUtcYearMonth(endOfJanuary), '2026-01');

    const startOfFebruary = new Date('2026-02-01T00:00:00.000Z');
    assert.equal(getUtcYearMonth(startOfFebruary), '2026-02');

    console.log('✔ Test 2: Exact UTC month boundaries passed');
  }

  // ==========================================
  // Test 3: Year Transition (December 31 -> January 1)
  // ==========================================
  {
    const endOfYear = new Date('2026-12-31T23:59:59.999Z');
    assert.equal(getUtcYearMonth(endOfYear), '2026-12');

    const startOfNewYear = new Date('2027-01-01T00:00:00.000Z');
    assert.equal(getUtcYearMonth(startOfNewYear), '2027-01');

    console.log('✔ Test 3: Year transitions passed');
  }

  // ==========================================
  // Test 4: February and Leap Years
  // ==========================================
  {
    // Leap year 2028: February 29
    const leapDay = new Date('2028-02-29T12:00:00.000Z');
    assert.equal(getUtcYearMonth(leapDay), '2028-02');

    const afterLeapDay = new Date('2028-03-01T00:00:00.000Z');
    assert.equal(getUtcYearMonth(afterLeapDay), '2028-03');

    // Non-leap year 2026: February 28
    const nonLeapEndFeb = new Date('2026-02-28T23:59:59.999Z');
    assert.equal(getUtcYearMonth(nonLeapEndFeb), '2026-02');

    const nonLeapStartMarch = new Date('2026-03-01T00:00:00.000Z');
    assert.equal(getUtcYearMonth(nonLeapStartMarch), '2026-03');

    console.log('✔ Test 4: Leap years and February handling passed');
  }

  // ==========================================
  // Test 5: Invalid Date Rejections
  // ==========================================
  {
    // Invalid Date string
    assert.throws(
      () => {
        getUtcYearMonth(new Date('invalid-date-string'));
      },
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /Invalid date provided/);
        return true;
      }
    );

    // NaN timestamp
    assert.throws(
      () => {
        getUtcYearMonth(new Date(NaN));
      },
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /Invalid date provided/);
        return true;
      }
    );

    // Non-Date object
    assert.throws(
      () => {
        getUtcYearMonth(null as unknown as Date);
      },
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /Invalid date provided/);
        return true;
      }
    );

    console.log('✔ Test 5: Invalid Date objects rejected with RangeError');
  }

  // ==========================================
  // Test 6: 4-Digit Year Bounds (1000 - 9999)
  // ==========================================
  {
    // Valid lower boundary: Year 1000
    const year1000 = new Date(Date.UTC(1000, 0, 1));
    assert.equal(getUtcYearMonth(year1000), '1000-01');

    // Valid upper boundary: Year 9999
    const year9999 = new Date(Date.UTC(9999, 11, 31));
    assert.equal(getUtcYearMonth(year9999), '9999-12');

    // Year 999 (below 1000)
    const year999 = new Date(Date.UTC(999, 11, 31));
    assert.throws(
      () => {
        getUtcYearMonth(year999);
      },
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /Year must be a 4-digit positive integer between 1000 and 9999/);
        return true;
      }
    );

    // Year 10000 (above 9999)
    const year10000 = new Date(Date.UTC(10000, 0, 1));
    assert.throws(
      () => {
        getUtcYearMonth(year10000);
      },
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /Year must be a 4-digit positive integer between 1000 and 9999/);
        return true;
      }
    );

    console.log('✔ Test 6: 4-digit year bounds (1000 to 9999) verified');
  }

  // ==========================================
  // Test 7: Default Invocation without Arguments
  // ==========================================
  {
    const before = new Date();
    const defaultResult = getUtcYearMonth();
    const after = new Date();

    assert.match(defaultResult, /^[0-9]{4}-(0[1-9]|1[0-2])$/);

    const formatUtcYearMonth = (d: Date): string => {
      const year = d.getUTCFullYear();
      const month = String(d.getUTCMonth() + 1).padStart(2, '0');
      return `${year}-${month}`;
    };

    const expectedBefore = formatUtcYearMonth(before);
    const expectedAfter = formatUtcYearMonth(after);

    assert.ok(
      defaultResult === expectedBefore || defaultResult === expectedAfter,
      `Expected default result (${defaultResult}) to match either before (${expectedBefore}) or after (${expectedAfter})`
    );

    console.log('✔ Test 7: Default invocation with current time passed');
  }

  console.log('All Processing Month Tests (Part 17) Passed Successfully!');
}

runProcessingMonthTests();

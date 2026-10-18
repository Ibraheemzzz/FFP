// tests/requests.test.ts
// اختبارات مسار استعلام وتصفية سجل طلبات الاستهلاك وتقسيم الصفحات (Part 25: GET /requests)

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type pg from 'pg';
import { initEnvironment, loadConfig } from '../src/config.js';
import { createPool, checkDatabaseHealth } from '../src/db.js';
import { runMigrations } from '../src/migrator.js';
import { buildApp } from '../src/app.js';
import { createAccount } from '../src/accounts.js';
import { createUser } from '../src/users.js';
import { executeConsumption } from '../src/consumptions.js';
import type { RequestHistoryResponse } from '../src/types.js';

/**
 * دالة مساعدة لإنشاء حساب مع مفتاح API
 */
async function createTestAccount(
  pool: pg.Pool,
  name: string,
  planId = 'plan_default_account'
): Promise<{ accountId: string; apiKey: string }> {
  const account = await createAccount(pool, { name, planId });
  return { accountId: account.id, apiKey: account.apiKey };
}

/**
 * دالة مساعدة لإنشاء مستخدم تحت حساب معين
 */
async function createTestUser(
  pool: pg.Pool,
  accountId: string,
  planId = 'plan_default_user'
): Promise<{ userId: string }> {
  const user = await createUser(pool, accountId, { planId });
  return { userId: user.id };
}

async function runRequestsHistoryTests(): Promise<void> {
  console.log('--- Starting Request History & Pagination Tests (Part 25: GET /requests) ---');

  initEnvironment();
  const config = loadConfig();

  const pool = createPool(config.DATABASE_URL, {
    max: 20,
    connectionTimeoutMillis: 10000,
    statementTimeoutMillis: 15000,
    queryTimeoutMillis: 20000,
  });

  const app = buildApp({
    checkHealth: () => checkDatabaseHealth(pool),
    pool,
  });

  try {
    await runMigrations(pool);

    // =========================================================================
    // 1. اختبارات المصادقة (Authentication Checks)
    // =========================================================================
    {
      // أ) غياب الترويسة
      const noAuthRes = await app.inject({
        method: 'GET',
        url: '/requests',
      });
      assert.equal(noAuthRes.statusCode, 401, 'Must return 401 Unauthorized when Authorization header is missing');

      // ب) مفتاح API غير صالح
      const invalidAuthRes = await app.inject({
        method: 'GET',
        url: '/requests',
        headers: { authorization: 'Bearer invalid_api_key_456' },
      });
      assert.equal(invalidAuthRes.statusCode, 401, 'Must return 401 Unauthorized for invalid API key');

      console.log('✔ Test 1: Authentication checks passed (401 on missing/invalid key)');
    }

    // =========================================================================
    // 2. التحقق الصارم من مدخلات الاستعلام (Strict Query Validation)
    // =========================================================================
    {
      const { apiKey } = await createTestAccount(pool, 'Query Validation Account');

      // أ) معاملات غير معرّفة
      const unknownParamRes = await app.inject({
        method: 'GET',
        url: '/requests?extra=param',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(unknownParamRes.statusCode, 400, 'Unknown query parameters must return 400 Bad Request');
      assert.equal(unknownParamRes.json().error, 'Unknown query parameter: extra');

      // ب) معاملات مكررة (مصفوفات)
      const duplicateParamRes = await app.inject({
        method: 'GET',
        url: '/requests?limit=10&limit=20',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(duplicateParamRes.statusCode, 400, 'Duplicate query parameters must return 400 Bad Request');

      // ج) قيم limit غير صالحة: سالبة، صفر، كسرية، نصوص، تفوق 100
      for (const invalidLimit of ['-1', '0', '1.5', 'abc', '101']) {
        const res = await app.inject({
          method: 'GET',
          url: `/requests?limit=${invalidLimit}`,
          headers: { authorization: `Bearer ${apiKey}` },
        });
        assert.equal(res.statusCode, 400, `limit=${invalidLimit} must be rejected with 400`);
      }

      // د) قيم offset غير صالحة: سالبة، كسرية، نصوص
      for (const invalidOffset of ['-5', '2.5', 'xyz']) {
        const res = await app.inject({
          method: 'GET',
          url: `/requests?offset=${invalidOffset}`,
          headers: { authorization: `Bearer ${apiKey}` },
        });
        assert.equal(res.statusCode, 400, `offset=${invalidOffset} must be rejected with 400`);
      }

      // هـ) قيم status غير صالحة: حروف صغيرة أو قيم عشوائية
      for (const invalidStatus of ['accepted', 'rejected', 'PENDING', '123']) {
        const res = await app.inject({
          method: 'GET',
          url: `/requests?status=${invalidStatus}`,
          headers: { authorization: `Bearer ${apiKey}` },
        });
        assert.equal(res.statusCode, 400, `status=${invalidStatus} must be rejected with 400`);
      }

      // و) صيغة شهر غير صالحة
      for (const invalidMonth of ['2026-13', '2026-00', '2026/10', '26-10', 'October']) {
        const res = await app.inject({
          method: 'GET',
          url: `/requests?month=${invalidMonth}`,
          headers: { authorization: `Bearer ${apiKey}` },
        });
        assert.equal(res.statusCode, 400, `month=${invalidMonth} must be rejected with 400`);
      }

      // ز) userId فارغ أو مسافات فقط
      const emptyUserRes = await app.inject({
        method: 'GET',
        url: '/requests?userId=%20%20%20',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(emptyUserRes.statusCode, 400, 'Whitespace-only userId must be rejected with 400');

      console.log('✔ Test 2: Strict query validation passed (400 on invalid/unknown/duplicate params)');
    }

    // =========================================================================
    // 3. السجل الفارغ وتجاوز الـ offset لنهاية النتائج (Empty History & Out-of-bounds Offset)
    // =========================================================================
    {
      const { apiKey } = await createTestAccount(pool, 'Empty History Account');

      // أ) حساب جديد بدون أي طلبات
      const emptyRes = await app.inject({
        method: 'GET',
        url: '/requests',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(emptyRes.statusCode, 200);
      const emptyJson = emptyRes.json() as RequestHistoryResponse;
      assert.deepEqual(emptyJson.items, []);
      assert.equal(emptyJson.pagination.limit, 20);
      assert.equal(emptyJson.pagination.offset, 0);
      assert.equal(emptyJson.pagination.hasMore, false);

      // ب) حساب بدون طلبات مع تحديد offset و limit
      const offsetRes = await app.inject({
        method: 'GET',
        url: '/requests?limit=10&offset=50',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(offsetRes.statusCode, 200);
      const offsetJson = offsetRes.json() as RequestHistoryResponse;
      assert.deepEqual(offsetJson.items, []);
      assert.equal(offsetJson.pagination.limit, 10);
      assert.equal(offsetJson.pagination.offset, 50);
      assert.equal(offsetJson.pagination.hasMore, false);

      console.log('✔ Test 3: Empty history and out-of-bounds offset verified (items: [], hasMore: false)');
    }

    // =========================================================================
    // 4. دقة تقسيم الصفحات وحالة (عدد النتائج يساوي limit تماماً -> hasMore: false)
    // =========================================================================
    {
      const account = await createTestAccount(pool, 'Pagination Test Account');
      const user = await createTestUser(pool, account.accountId);

      // إنشاء 3 طلبات متتابعة
      const reqIds: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const rId = `req_page_${i}_${crypto.randomUUID()}`;
        reqIds.push(rId);
        await executeConsumption(pool, account.accountId, {
          userId: user.userId,
          units: 10 * i,
          requestId: rId,
        });
      }

      // أ) طلب صفحة بحجم 2 بدءاً من offset 0 -> يوجد 3 عناصر، فيجب أن يعيد 2 مع hasMore: true
      const page1Res = await app.inject({
        method: 'GET',
        url: '/requests?limit=2&offset=0',
        headers: { authorization: `Bearer ${account.apiKey}` },
      });
      assert.equal(page1Res.statusCode, 200);
      const page1Json = page1Res.json() as RequestHistoryResponse;
      assert.equal(page1Json.items.length, 2);
      assert.equal(page1Json.pagination.limit, 2);
      assert.equal(page1Json.pagination.offset, 0);
      assert.equal(page1Json.pagination.hasMore, true, 'hasMore must be true when more items exist');

      // ب) طلب الصفحة التالية limit=2&offset=2 -> يتبقى عنصر واحد فقط
      const page2Res = await app.inject({
        method: 'GET',
        url: '/requests?limit=2&offset=2',
        headers: { authorization: `Bearer ${account.apiKey}` },
      });
      assert.equal(page2Res.statusCode, 200);
      const page2Json = page2Res.json() as RequestHistoryResponse;
      assert.equal(page2Json.items.length, 1);
      assert.equal(page2Json.pagination.hasMore, false, 'hasMore must be false on final page');

      // ج) الحالة الحرجة المطلوبة: عدد النتائج يساوي limit تماماً (3 عناصر و limit=3)
      // يجب أن يعيد العناصر الثلاثة مع hasMore: false
      const exactMatchRes = await app.inject({
        method: 'GET',
        url: '/requests?limit=3&offset=0',
        headers: { authorization: `Bearer ${account.apiKey}` },
      });
      assert.equal(exactMatchRes.statusCode, 200);
      const exactJson = exactMatchRes.json() as RequestHistoryResponse;
      assert.equal(exactJson.items.length, 3);
      assert.equal(
        exactJson.pagination.hasMore,
        false,
        'hasMore must be strictly false when results count equals limit exactly'
      );

      // د) تجاوز نهاية السجل (offset=100) -> يعيد قائمة فارغة مع hasMore: false
      const outOfBoundsRes = await app.inject({
        method: 'GET',
        url: '/requests?limit=10&offset=100',
        headers: { authorization: `Bearer ${account.apiKey}` },
      });
      assert.equal(outOfBoundsRes.statusCode, 200);
      const outOfBoundsJson = outOfBoundsRes.json() as RequestHistoryResponse;
      assert.deepEqual(outOfBoundsJson.items, []);
      assert.equal(outOfBoundsJson.pagination.hasMore, false);

      console.log('✔ Test 4: Pagination accuracy and exact count === limit boundary (hasMore: false) verified');
    }

    // =========================================================================
    // 5. الترتيب الحتمي وكسر التعادل بـ id DESC وبقاء id كنص وسلامة responseBody
    // =========================================================================
    {
      const account = await createTestAccount(pool, 'Tie Breaking Account');
      const user = await createTestUser(pool, account.accountId);

      const fixedTime = new Date('2026-10-18T12:00:00.000Z');

      // إرسال طلبين بنفس التوقيت المحقون تماماً
      const reqId1 = `req_tie_1_${crypto.randomUUID()}`;
      const reqId2 = `req_tie_2_${crypto.randomUUID()}`;

      await executeConsumption(
        pool,
        account.accountId,
        { userId: user.userId, units: 10, requestId: reqId1 },
        { clock: () => fixedTime }
      );

      await executeConsumption(
        pool,
        account.accountId,
        { userId: user.userId, units: 20, requestId: reqId2 },
        { clock: () => fixedTime }
      );

      const res = await app.inject({
        method: 'GET',
        url: '/requests',
        headers: { authorization: `Bearer ${account.apiKey}` },
      });

      assert.equal(res.statusCode, 200);
      const json = res.json() as RequestHistoryResponse;
      assert.equal(json.items.length, 2);

      // التحقق أن الطلب الثاني (الذي أُدخل لاحقاً وله id أكبر) يظهر أولاً بسبب كسر التعادل بـ id DESC
      assert.equal(json.items[0].requestId, reqId2);
      assert.equal(json.items[1].requestId, reqId1);

      // التأكد أن id نصي (String) للحفاظ على دقة BIGSERIAL
      assert.equal(typeof json.items[0].id, 'string');
      assert.equal(typeof json.items[1].id, 'string');
      assert.ok(BigInt(json.items[0].id) > BigInt(json.items[1].id), 'id DESC must break ties deterministically');

      // التأكد من استرجاع responseBody المحفوظ كما هو
      assert.equal(json.items[0].responseBody.accepted, true);
      assert.equal(json.items[0].responseBody.requestId, reqId2);

      console.log('✔ Test 5: Deterministic tie-breaking on identical timestamps by id DESC and string id verified');
    }

    // =========================================================================
    // 6. اختبارات المرشحات (Filters: userId, status, month)
    // =========================================================================
    {
      const account = await createTestAccount(pool, 'Filters Test Account');
      const user1 = await createTestUser(pool, account.accountId);
      const user2 = await createTestUser(pool, account.accountId);

      // أ) طلب مقبول للمستخدم 1 في شهر سبتمبر 2026-09
      await executeConsumption(
        pool,
        account.accountId,
        { userId: user1.userId, units: 10, requestId: `req_u1_sep_${crypto.randomUUID()}` },
        { clock: () => new Date('2026-09-15T10:00:00.000Z') }
      );

      // ب) طلب مرفوض للمستخدم 1 في شهر أكتوبر 2026-10 (تجاوز حد الطلب 500)
      await executeConsumption(
        pool,
        account.accountId,
        { userId: user1.userId, units: 600, requestId: `req_u1_oct_rej_${crypto.randomUUID()}` },
        { clock: () => new Date('2026-10-10T10:00:00.000Z') }
      );

      // ج) طلب مقبول للمستخدم 2 في شهر أكتوبر 2026-10
      await executeConsumption(
        pool,
        account.accountId,
        { userId: user2.userId, units: 15, requestId: `req_u2_oct_${crypto.randomUUID()}` },
        { clock: () => new Date('2026-10-12T10:00:00.000Z') }
      );

      // 1. تصفية بـ userId:
      const filterUser1Res = await app.inject({
        method: 'GET',
        url: `/requests?userId=${user1.userId}`,
        headers: { authorization: `Bearer ${account.apiKey}` },
      });
      assert.equal(filterUser1Res.statusCode, 200);
      const user1Items = (filterUser1Res.json() as RequestHistoryResponse).items;
      assert.equal(user1Items.length, 2);
      assert.ok(user1Items.every((it) => it.userId === user1.userId));

      // 2. تصفية بـ userId غير موجود -> يعيد قائمة فارغة 200 OK
      const filterUnknownUserRes = await app.inject({
        method: 'GET',
        url: '/requests?userId=usr_non_existent',
        headers: { authorization: `Bearer ${account.apiKey}` },
      });
      assert.equal(filterUnknownUserRes.statusCode, 200);
      assert.deepEqual((filterUnknownUserRes.json() as RequestHistoryResponse).items, []);

      // 3. تصفية بـ status = 'REJECTED':
      const filterRejectedRes = await app.inject({
        method: 'GET',
        url: '/requests?status=REJECTED',
        headers: { authorization: `Bearer ${account.apiKey}` },
      });
      assert.equal(filterRejectedRes.statusCode, 200);
      const rejectedItems = (filterRejectedRes.json() as RequestHistoryResponse).items;
      assert.equal(rejectedItems.length, 1);
      assert.equal(rejectedItems[0].status, 'REJECTED');
      assert.deepEqual(rejectedItems[0].rejectionReason, {
        scope: 'user',
        rule: 'max_per_request',
      });

      // 4. تصفية بـ status = 'ACCEPTED':
      const filterAcceptedRes = await app.inject({
        method: 'GET',
        url: '/requests?status=ACCEPTED',
        headers: { authorization: `Bearer ${account.apiKey}` },
      });
      assert.equal(filterAcceptedRes.statusCode, 200);
      const acceptedItems = (filterAcceptedRes.json() as RequestHistoryResponse).items;
      assert.equal(acceptedItems.length, 2);
      assert.ok(acceptedItems.every((it) => it.status === 'ACCEPTED' && it.rejectionReason === null));

      // 5. تصفية بـ month = '2026-09':
      const filterSepRes = await app.inject({
        method: 'GET',
        url: '/requests?month=2026-09',
        headers: { authorization: `Bearer ${account.apiKey}` },
      });
      assert.equal(filterSepRes.statusCode, 200);
      const sepItems = (filterSepRes.json() as RequestHistoryResponse).items;
      assert.equal(sepItems.length, 1);
      assert.equal(sepItems[0].userId, user1.userId);
      assert.equal(sepItems[0].requestedUnits, 10);

      // 6. تصفية بشهر مستقبلي ليس فيه طلبات (2027-05) -> يعيد قائمة فارغة 200 OK
      const filterFutureMonthRes = await app.inject({
        method: 'GET',
        url: '/requests?month=2027-05',
        headers: { authorization: `Bearer ${account.apiKey}` },
      });
      assert.equal(filterFutureMonthRes.statusCode, 200);
      assert.deepEqual((filterFutureMonthRes.json() as RequestHistoryResponse).items, []);

      // 7. تصفية مركبة (userId + status + month):
      const filterCombinedRes = await app.inject({
        method: 'GET',
        url: `/requests?userId=${user1.userId}&status=REJECTED&month=2026-10`,
        headers: { authorization: `Bearer ${account.apiKey}` },
      });
      assert.equal(filterCombinedRes.statusCode, 200);
      const combinedItems = (filterCombinedRes.json() as RequestHistoryResponse).items;
      assert.equal(combinedItems.length, 1);
      assert.equal(combinedItems[0].userId, user1.userId);
      assert.equal(combinedItems[0].status, 'REJECTED');

      console.log('✔ Test 6: Filtering by userId, status, month, and combined filters verified');
    }

    // =========================================================================
    // 7. عزل المستأجرين التام (Tenant Isolation)
    // =========================================================================
    {
      const tenantA = await createTestAccount(pool, 'Tenant A');
      const tenantB = await createTestAccount(pool, 'Tenant B');
      const userA = await createTestUser(pool, tenantA.accountId);
      const userB = await createTestUser(pool, tenantB.accountId);

      // تسجيل طلب لـ Tenant A
      await executeConsumption(pool, tenantA.accountId, {
        userId: userA.userId,
        units: 25,
        requestId: `req_tenant_a_${crypto.randomUUID()}`,
      });

      // تسجيل طلب لـ Tenant B
      await executeConsumption(pool, tenantB.accountId, {
        userId: userB.userId,
        units: 40,
        requestId: `req_tenant_b_${crypto.randomUUID()}`,
      });

      // استعلام Tenant A يجب ألا يرى أي سجل يخص Tenant B
      const resA = await app.inject({
        method: 'GET',
        url: '/requests',
        headers: { authorization: `Bearer ${tenantA.apiKey}` },
      });
      assert.equal(resA.statusCode, 200);
      const itemsA = (resA.json() as RequestHistoryResponse).items;
      assert.equal(itemsA.length, 1);
      assert.equal(itemsA[0].userId, userA.userId);
      assert.equal(itemsA[0].requestedUnits, 25);

      // محاولة Tenant A تصفية السجل بـ userId الخاص بـ Tenant B -> قائمة فارغة 200 OK
      const crossTenantFilterRes = await app.inject({
        method: 'GET',
        url: `/requests?userId=${userB.userId}`,
        headers: { authorization: `Bearer ${tenantA.apiKey}` },
      });
      assert.equal(crossTenantFilterRes.statusCode, 200);
      assert.deepEqual((crossTenantFilterRes.json() as RequestHistoryResponse).items, []);

      console.log('✔ Test 7: Strict multi-tenant isolation verified with zero leakage');
    }

  } finally {
    await pool.end();
  }

  console.log('--- All Request History & Pagination Tests (Part 25) Passed Successfully! ---');
}

runRequestsHistoryTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});

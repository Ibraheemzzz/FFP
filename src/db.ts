// src/db.ts
import pg from 'pg';

const { Pool } = pg;

export interface DatabasePoolOptions {
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  statementTimeoutMillis?: number;
  queryTimeoutMillis?: number;
}

/**
 * إنشاء مجموعة اتصالات PostgreSQL (Connection Pool) باستخدام مكتبة pg المستقلة الشائعة.
 * ملاحظة معمارية: الـ Pool لا يفتح جميع الاتصالات مسبقاً، بل ينشئ اتصالات جديدة
 * عند الحاجة ويعيد استخدامها لتفادي تكلفة فتح اتصال TCP جديد لكل طلب، حتى الحد الأقصى max.
 */
export function createPool(
  databaseUrl: string,
  options: DatabasePoolOptions = {}
): pg.Pool {
  const statementTimeout = options.statementTimeoutMillis ?? 3000;
  // مهلة استدعاء العميل تكون أطول قليلاً من مهلة تنفيذ الخادم لإتاحة الفرصة لمحرك PostgreSQL لإلغاء الاستعلام أولاً
  const queryTimeout = options.queryTimeoutMillis ?? (statementTimeout + 2000);

  const pool = new Pool({
    connectionString: databaseUrl,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 10000,
    statement_timeout: statementTimeout,
    query_timeout: queryTimeout,
  });

  // معالجة أخطاء الاتصالات الخاملة في الخلفية برسالة تشغيلية ثابتة لمنع تسريب أي بيانات حساسة
  pool.on('error', () => {
    console.error('Unexpected error on idle database client');
  });

  return pool;
}

/**
 * فحص استجابة قاعدة البيانات (Readiness Check):
 * يستعير اتصالاً صريحاً من الـ Pool وينفذ استعلام SELECT 1، مع ضمان تحرير الاتصال مرة واحدة فقط داخل finally.
 *
 * سياسة إدارة وتحرير الاتصال (Connection Recycling vs Discarding):
 * - في حالة النجاح: يعاد الاتصال سليماً إلى المجموعة عبر client.release(false) لإعادة استخدامه.
 * - في حالة الفشل أو تجاوز المهلة: يتم التخلص من الاتصال نهائياً وإغلاقه عبر client.release(true)
 *   لتفادي إعادة استخدام اتصال في حالة غير موثوقة أو غير مكتملة المعاملات.
 *
 * طبيعة المهلات:
 * 1. statement_timeout: مهلة التنفيذ داخل محرك PostgreSQL نفسه؛ عند تجاوزها يلغي المحرك الاستعلام ويحرر موارده.
 * 2. query_timeout: مهلة لاستدعاء الاستعلام عند العميل (Client-side Timeout)، وليست مهلة مقبس أو ضماناً لإلغاء الاستعلام في القاعدة.
 */
export async function checkDatabaseHealth(pool: pg.Pool): Promise<boolean> {
  let client: pg.PoolClient | undefined;
  let hasFailed = true;

  try {
    client = await pool.connect();
    const result = await client.query('SELECT 1');
    const isHealthy = (result.rowCount ?? 0) > 0;
    if (isHealthy) {
      hasFailed = false;
    }
    return isHealthy;
  } catch {
    return false;
  } finally {
    if (client) {
      // تحرير الاتصال مرة واحدة حصراً: إعادة تدوير عند النجاح، أو استبعاد وإتلاف عند الفشل
      client.release(hasFailed);
    }
  }
}

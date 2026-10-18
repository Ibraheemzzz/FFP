import pg from 'pg';
import { AccountNotFoundError } from './errors.js';

const { Pool } = pg;

export type DbExecutor = pg.Pool | pg.PoolClient;

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

/**
 * تنفيذ عملية داخل معاملة ذرية مع حجز قفل حصري لصف الحساب بمستوى عزل READ COMMITTED.
 *
 * الضمانات والحدود:
 * - القفل ينسق حصراً العمليات التي تلتزم بقفل الحساب نفسه (SELECT ... FOR UPDATE على الحساب).
 * - لا يمنع استعلامات القراءة العادية SELECT (وفق آلية MVCC).
 * - ترتيب الوصول عبر الشبكة لا يضمن أسبقية التنفيذ؛ العملية التي تحوز القفل أولاً هي التي تكتمل أولاً.
 * - تبدأ المعاملة بمستوى عزل صريح READ COMMITTED.
 * - جميع القراءات المؤثرة في القرار تُنفّذ داخل المعاملة بعد نيل القفل حصراً.
 * - في حالة النجاح: لا يُعاد النجاح إلا بعد اكتمال COMMIT بنجاح، ويُعاد الاتصال سليماً إلى المجموعة client.release(false).
 * - في حالة الفشل: تجري محاولة ROLLBACK؛ إذا نجحت يُعاد الاتصال سليماً للمجموعة client.release(false)، وإذا تعثر الالتزام أو التراجع يُهدم الاتصال client.release(true) لمنع إعادة استخدامه بحالة غير موثوقة.
 */
export async function withAccountLock<T>(
  pool: pg.Pool,
  accountId: string,
  operation: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  let shouldDiscard = false;

  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');

    const lockResult = await client.query(
      'SELECT id FROM accounts WHERE id = $1 FOR UPDATE',
      [accountId]
    );

    if ((lockResult.rowCount ?? 0) === 0) {
      throw new AccountNotFoundError('Account not found');
    }

    const result = await operation(client);

    try {
      await client.query('COMMIT');
    } catch (commitErr) {
      // فشل الالتزام يعني أن حالة الاتصال غير موثوقة أو غير معلومة، فيجب إتلافه
      shouldDiscard = true;
      throw commitErr;
    }

    return result;
  } catch (err) {
    // إذا لم يكن الفشل بسبب خطأ أثناء COMMIT، نحاول التراجع
    if (!shouldDiscard) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // فشل التراجع يعني أن الاتصال في حالة غير صالحة ويجب إتلافه
        shouldDiscard = true;
        console.error('Failed to rollback transaction; discarding connection');
      }
    }
    throw err;
  } finally {
    // إعادة الاتصال سليماً إلى المجموعة إذا كان صالحاً (false)، أو إتلافه إذا تعثر الالتزام أو التراجع (true)
    client.release(shouldDiscard);
  }
}

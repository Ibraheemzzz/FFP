// src/auth.ts
import type { preHandlerHookHandler } from 'fastify';
import type pg from 'pg';
import { hashApiKey } from './accounts.js';

export interface AuthenticatedAccount {
  id: string;
  name: string;
  planId: string;
  createdAt: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    account?: AuthenticatedAccount;
  }
}

/**
 * التعبير النمطي للتحقق الصارم من تنسيق مفتاح API:
 * يبدأ بـ ffp_live_ متبوعة بـ 64 محرفاً ست عشرياً (إجمالي 73 محرفاً)
 */
export const API_KEY_FORMAT_REGEX = /^ffp_live_[0-9a-fA-F]{64}$/;

/**
 * رسالة الخطأ الموحدة لحالات المصادقة المرفوضة
 */
export const AUTH_ERROR_MESSAGE = 'Invalid or missing API key';

/**
 * استخراج رمز Bearer من ترويسة Authorization
 * يدعم مقارنة اسم المخطط دون حساسية لحالة الأحرف (Bearer, bearer, BEARER)
 * مع الحفاظ التام على قيمة المفتاح كما هي دون أي تحويل
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null;
  }

  const token = parts[1];
  return token.length > 0 ? token : null;
}

/**
 * التحقق من سلامة تنسيق المفتاح قبل استعلام قاعدة البيانات (Fail-Fast)
 */
export function validateApiKeyFormat(apiKey: string): boolean {
  return API_KEY_FORMAT_REGEX.test(apiKey);
}

/**
 * استعلام قاعدة البيانات عن الحساب المرتبط بالمفتاح باستخدام بصمة SHA-256 للمفتاح
 */
export async function authenticateApiKey(
  pool: pg.Pool,
  rawKey: string
): Promise<AuthenticatedAccount | null> {
  const hash = hashApiKey(rawKey);

  const result = await pool.query<{
    id: string;
    name: string;
    plan_id: string;
    created_at: Date;
  }>(
    `SELECT id, name, plan_id, created_at
     FROM accounts
     WHERE api_key_hash = $1`,
    [hash]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    name: row.name,
    planId: row.plan_id,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * خطاف ما قبل المعالجة (preHandler hook) لمصادقة الطلبات على المسارات المحمية
 * يوقف تنفيذ الطلب ويرجع 401 مع ترويسة WWW-Authenticate عند غياب المفتاح أو عدم صلاحيته
 * ويرجع 500 برسالة عامة دون تحويل أعطال قاعدة البيانات إلى 401
 */
export function createAuthPreHandler(pool?: pg.Pool): preHandlerHookHandler {
  return async (request, reply) => {
    if (!pool) {
      return reply.code(500).send({ error: 'Database pool is not configured' });
    }

    const authHeader = request.headers.authorization;
    if (!authHeader) {
      return reply
        .header('WWW-Authenticate', 'Bearer')
        .code(401)
        .send({ error: AUTH_ERROR_MESSAGE });
    }

    const token = extractBearerToken(authHeader);
    if (!token || !validateApiKeyFormat(token)) {
      return reply
        .header('WWW-Authenticate', 'Bearer')
        .code(401)
        .send({ error: AUTH_ERROR_MESSAGE });
    }

    let account: AuthenticatedAccount | null;
    try {
      account = await authenticateApiKey(pool, token);
    } catch {
      console.error('Database authentication query error occurred');
      return reply.code(500).send({ error: 'Internal Server Error' });
    }

    if (!account) {
      return reply
        .header('WWW-Authenticate', 'Bearer')
        .code(401)
        .send({ error: AUTH_ERROR_MESSAGE });
    }

    request.account = account;
  };
}


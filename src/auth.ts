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
 * Strict regex pattern for API key format:
 * Starts with ffp_live_ followed by 64 hex characters (73 total characters)
 */
export const API_KEY_FORMAT_REGEX = /^ffp_live_[0-9a-fA-F]{64}$/;

/**
 * Unified error message for rejected authentication attempts
 */
export const AUTH_ERROR_MESSAGE = 'Invalid or missing API key';

/**
 * Extracts Bearer token from Authorization header.
 * Case-insensitive scheme comparison (Bearer, bearer, BEARER) while preserving raw key value.
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
 * Pre-query format validation for API key (Fail-Fast)
 */
export function validateApiKeyFormat(apiKey: string): boolean {
  return API_KEY_FORMAT_REGEX.test(apiKey);
}

/**
 * Queries database for account associated with SHA-256 hash of raw API key
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
 * PreHandler hook for authenticating requests on protected endpoints.
 * Aborts and returns 401 with WWW-Authenticate header on missing or invalid key.
 * Returns generic 500 on database failures without masking errors as 401.
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
      request.log.error(
        { event: 'auth_failed', requestId: request.id },
        'Database authentication query error occurred'
      );
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

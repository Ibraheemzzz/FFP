// src/config.ts
import { existsSync } from 'node:fs';

/**
 * Validated application configuration interface
 */
export interface AppConfig {
  PORT: number;
  HOST: string;
  DATABASE_URL: string;
}

/**
 * Loads variables from .env file into process.env using Node.js native support.
 * Requires Node.js 20.12.0+ or 21.7.0+ for process.loadEnvFile.
 * If file does not exist, step is skipped to rely directly on OS/container environment variables.
 */
export function initEnvironment(envFilePath: string = '.env'): void {
  if (existsSync(envFilePath)) {
    try {
      process.loadEnvFile(envFilePath);
    } catch {
      // Safe generic message preventing leakage of uninspected environment details
      throw new Error(`Failed to load environment file "${envFilePath}". Ensure the file is readable and formatted correctly.`);
    }
  }
}

/**
 * Reads and validates environment configuration (Fail-Fast Validation).
 * Accepts an optional env object for isolated unit testing.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  // 1. Validate PORT: integer between 1 and 65535
  const rawPort = env.PORT ?? '3000';
  const isStrictInteger = /^\d+$/.test(rawPort);
  const parsedPort = Number(rawPort);

  if (!isStrictInteger || parsedPort < 1 || parsedPort > 65535) {
    throw new Error('Invalid PORT: must be an integer between 1 and 65535');
  }

  // 2. Validate HOST: defaults to 127.0.0.1
  const host = env.HOST && env.HOST.trim().length > 0 ? env.HOST.trim() : '127.0.0.1';

  // 3. Validate DATABASE_URL:
  // Verifies format, supported protocol, and host presence.
  const rawDatabaseUrl = env.DATABASE_URL;

  if (!rawDatabaseUrl || rawDatabaseUrl.trim().length === 0) {
    throw new Error('Missing required configuration: DATABASE_URL');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawDatabaseUrl);
  } catch {
    // Avoid echoing raw connection string to prevent credential exposure
    throw new Error('Invalid DATABASE_URL: value is not a valid URL');
  }

  const validProtocols = ['postgres:', 'postgresql:'];
  if (!validProtocols.includes(parsedUrl.protocol)) {
    throw new Error('Invalid DATABASE_URL: protocol must be postgres: or postgresql:');
  }

  if (!parsedUrl.hostname) {
    throw new Error('Invalid DATABASE_URL: host is required');
  }

  return {
    PORT: parsedPort,
    HOST: host,
    DATABASE_URL: rawDatabaseUrl,
  };
}

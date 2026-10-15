// src/config.ts
import { existsSync } from 'node:fs';

/**
 * نوع كائن الإعدادات المعتمد في كامل الخدمة
 */
export interface AppConfig {
  PORT: number;
  HOST: string;
  DATABASE_URL: string;
}

/**
 * تحميل متغيرات ملف .env إلى process.env باستخدام دعم Node.js المدمج.
 * يتطلب هذا الدعم إصدار Node.js 20.12.0 أو 21.7.0 أو أحدث (حيث أُضيفت دالة process.loadEnvFile برمجياً، بينما علم --env-file أُضيف في 20.6.0). سنعتمد إصداراً متوافقاً في Docker لاحقاً.
 * إذا لم يكن الملف موجوداً، يتم تجاوز الخطوة للاعتماد على متغيرات نظام التشغيل أو Docker مباشرة.
 */
export function initEnvironment(envFilePath: string = '.env'): void {
  if (existsSync(envFilePath)) {
    try {
      process.loadEnvFile(envFilePath);
    } catch {
      // رسالة آمنة لا تسرب أي معلومات حساسة أو تفاصيل بيئية غير مفحوصة
      throw new Error(`Failed to load environment file "${envFilePath}". Ensure the file is readable and formatted correctly.`);
    }
  }
}

/**
 * قراءة وتدقيق إعدادات البيئة (Fail-Fast Validation).
 * تقبل كائن env اختياري لتسهيل اختبار الدالة بعزل كامل عن بيئة الجهاز.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  // 1. تدقيق المنفذ (PORT): عدد صحيح محصور بين 1 و 65535
  const rawPort = env.PORT ?? '3000';
  const isStrictInteger = /^\d+$/.test(rawPort);
  const parsedPort = Number(rawPort);

  if (!isStrictInteger || parsedPort < 1 || parsedPort > 65535) {
    throw new Error('Invalid PORT: must be an integer between 1 and 65535');
  }

  // 2. تدقيق المضيف (HOST): الافتراضي 127.0.0.1
  const host = env.HOST && env.HOST.trim().length > 0 ? env.HOST.trim() : '127.0.0.1';

  // 3. تدقيق رابط قاعدة البيانات (DATABASE_URL):
  // سياسة الرابط: هذا الفحص يتحقق من صحة شكل الرابط، والبروتوكول، ووجود المضيف فقط.
  // هذا الفحص لا يثبت إمكانية الاتصال أو وجود قاعدة البيانات؛ ذلك يخص الجزء الخامس.
  const rawDatabaseUrl = env.DATABASE_URL;

  if (!rawDatabaseUrl || rawDatabaseUrl.trim().length === 0) {
    throw new Error('Missing required configuration: DATABASE_URL');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawDatabaseUrl);
  } catch {
    // عدم طباعة الرابط لتجنب تسريب أي كلمات مرور
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

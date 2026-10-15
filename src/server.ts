// src/server.ts
import { buildApp } from './app.js';
import { initEnvironment, loadConfig, type AppConfig } from './config.js';
import { createPool, checkDatabaseHealth } from './db.js';
import { runMigrations } from './migrator.js';

// 1. تهيئة ملف البيئة وقراءة الإعدادات عند الإقلاع (Fail-Fast)
let config: AppConfig;
try {
  initEnvironment();
  config = loadConfig();
} catch (error) {
  console.error('Configuration error:', (error as Error).message);
  process.exit(1);
}

// 2. إنشاء مجموعة اتصالات قاعدة البيانات
const pool = createPool(config.DATABASE_URL);

// 3. فحص الاتصال بالقاعدة قبل بدء الخادم (Startup Pre-flight Check)
const isDbConnected = await checkDatabaseHealth(pool);
if (!isDbConnected) {
  console.error('Failed to connect to database during startup. Cleaning up pool and exiting...');
  await pool.end();
  process.exit(1);
}

// 4. تشغيل مهاجرات قاعدة البيانات قبل قبول أي طلبات (Schema Migration Runner)
try {
  await runMigrations(pool);
} catch (error) {
  console.error('Failed to run database migrations during startup:', (error as Error).message);
  await pool.end();
  process.exit(1);
}

// 5. إنشاء التطبيق مع تمرير دالة فحص الجاهزية ومجموعة اتصالات القاعدة
const app = buildApp({
  checkHealth: () => checkDatabaseHealth(pool),
  pool,
});

// 6. بدء الاستماع لطلبات الشبكة وتنظيف الموارد إذا فشل الاستماع
try {
  await app.listen({ port: config.PORT, host: config.HOST });
  console.log(`[Fastify + TypeScript] Server is running on http://${config.HOST}:${config.PORT}`);
} catch (error) {
  console.error('Failed to start server:', error);
  await pool.end();
  process.exit(1);
}

// 7. معالجة الإغلاق المنظم لمجموعة الاتصالات والخادم (Graceful Shutdown)
const handleShutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}. Shutting down server gracefully...`);
  let hasFailure = false;

  try {
    await app.close();
  } catch {
    hasFailure = true;
    console.error('Failed to close Fastify application server cleanly.');
  }

  try {
    await pool.end();
  } catch {
    hasFailure = true;
    console.error('Failed to close database connection pool cleanly.');
  }

  if (hasFailure) {
    console.error('Graceful shutdown completed with errors.');
    process.exit(1);
  }

  console.log('Server and database connections closed successfully.');
  process.exit(0);
};

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

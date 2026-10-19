// tests/health.test.ts
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

async function runHealthTests(): Promise<void> {
  // 1. Test application when database is healthy
  const healthyApp = buildApp({
    checkHealth: async () => true,
  });

  try {
    // a. Liveness probe: GET /health
    const livenessResponse = await healthyApp.inject({
      method: 'GET',
      url: '/health',
    });
    assert.equal(livenessResponse.statusCode, 200, 'Status code for /health should be 200');
    assert.deepEqual(livenessResponse.json(), { status: 'ok' });
    console.log('✔ Health check route test passed (GET /health)');

    // b. Connected readiness probe: GET /health/ready -> 200
    const readyResponse = await healthyApp.inject({
      method: 'GET',
      url: '/health/ready',
    });
    assert.equal(readyResponse.statusCode, 200, 'Status code for connected readiness should be 200');
    assert.deepEqual(readyResponse.json(), { ready: true, database: 'connected' });
    console.log('✔ Connected readiness route test passed (GET /health/ready -> 200)');
  } finally {
    await healthyApp.close();
  }

  // 2. Test application when database is unhealthy
  const disconnectedApp = buildApp({
    checkHealth: async () => false,
  });

  try {
    // Disconnected readiness probe: GET /health/ready -> 503
    const unreadyResponse = await disconnectedApp.inject({
      method: 'GET',
      url: '/health/ready',
    });
    assert.equal(unreadyResponse.statusCode, 503, 'Status code for disconnected readiness should be 503');
    assert.deepEqual(unreadyResponse.json(), { ready: false, database: 'disconnected' });
    console.log('✔ Disconnected readiness route test passed (GET /health/ready -> 503)');
  } finally {
    await disconnectedApp.close();
  }
}

try {
  await runHealthTests();
  console.log('\nAll health & readiness route tests passed successfully.');
} catch (err) {
  console.error('\nHealth test failed:', err);
  process.exit(1);
}

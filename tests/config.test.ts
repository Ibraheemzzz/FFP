// tests/config.test.ts
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

async function runConfigTests(): Promise<void> {
  const validDbUrl = 'postgres://user:secretpass@localhost:5432/mydb';

  // 1. Test default values with valid DATABASE_URL provided
  const defaultConfig = loadConfig({
    DATABASE_URL: validDbUrl,
  });
  assert.equal(defaultConfig.PORT, 3000, 'Default PORT should be 3000');
  assert.equal(defaultConfig.HOST, '127.0.0.1', 'Default HOST should be 127.0.0.1');
  assert.equal(defaultConfig.DATABASE_URL, validDbUrl);
  console.log('✔ Default configuration test passed');

  // 2. Test custom port and host configuration
  const customConfig = loadConfig({
    PORT: '8080',
    HOST: '0.0.0.0',
    DATABASE_URL: validDbUrl,
  });
  assert.equal(customConfig.PORT, 8080);
  assert.equal(customConfig.HOST, '0.0.0.0');
  console.log('✔ Custom configuration test passed');

  // 3. Test rejection of invalid ports (string, alphanumeric, out-of-range 1-65535, float)
  const invalidPorts = ['abc', '3000abc', '0', '-5', '65536', '3000.5'];
  for (const port of invalidPorts) {
    assert.throws(
      () => loadConfig({ PORT: port, DATABASE_URL: validDbUrl }),
      /Invalid PORT: must be an integer between 1 and 65535/,
      `Should reject invalid port "${port}"`
    );
  }
  console.log('✔ Invalid ports validation test passed');

  // 4. Test rejection when DATABASE_URL is missing
  assert.throws(
    () => loadConfig({}),
    /Missing required configuration: DATABASE_URL/,
    'Should throw error when DATABASE_URL is missing'
  );
  console.log('✔ Missing DATABASE_URL test passed');

  // 5. Test rejection of non-postgres protocols
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'mysql://user:secretpass@localhost:3306/mydb' }),
    /Invalid DATABASE_URL: protocol must be postgres: or postgresql:/,
    'Should reject non-postgres protocol'
  );
  console.log('✔ Non-postgres protocol rejection test passed');

  // 6. Security verification: Ensure password is never leaked in error messages
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'mysql://user:super_secret_password_123@localhost:3306/mydb' }),
    (error: unknown) => {
      assert.ok(error instanceof Error, 'Thrown error must be an instance of Error');
      assert.ok(
        !error.message.includes('super_secret_password_123'),
        'Error message must NOT leak password'
      );
      return true;
    },
    'Should throw error and not leak password'
  );
  console.log('✔ Invalid-protocol error does not expose the test password');
}

try {
  await runConfigTests();
  console.log('\nAll configuration tests passed successfully.');
} catch (err) {
  console.error('\nConfiguration test failed:', err);
  process.exit(1);
}

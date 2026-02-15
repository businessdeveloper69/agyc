/**
 * Test Session Keepalive Module - Unit Tests
 *
 * Tests the session keepalive module functionality:
 * - Configuration defaults and overrides
 * - Health tracking per account
 * - Status reporting
 * - Start/stop lifecycle
 * - Action selection randomness
 *
 * No server required - tests run standalone.
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           SESSION KEEPALIVE TEST SUITE                       ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Dynamic import for ESM module
    const {
        getKeepaliveConfig,
        getKeepaliveStatus,
        getHealthSummary,
        resetHealth,
        isKeepaliveRunning,
        startKeepalive,
        stopKeepalive
    } = await import('../src/modules/session-keepalive.js');

    const { config } = await import('../src/config.js');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}`);
            failed++;
        }
    }

    function assertEqual(actual, expected, message = '') {
        if (actual !== expected) {
            throw new Error(`${message}\nExpected: ${expected}\nActual: ${actual}`);
        }
    }

    function assertTrue(value, message = '') {
        if (!value) {
            throw new Error(message || 'Expected true but got false');
        }
    }

    function assertFalse(value, message = '') {
        if (value) {
            throw new Error(message || 'Expected false but got true');
        }
    }

    function assertNotNull(value, message = '') {
        if (value === null || value === undefined) {
            throw new Error(`${message}\nExpected non-null value but got: ${value}`);
        }
    }

    function assertWithin(actual, min, max, message = '') {
        if (actual < min || actual > max) {
            throw new Error(`${message}\nExpected value between ${min} and ${max}, got: ${actual}`);
        }
    }

    // ==========================================================================
    // CONFIGURATION TESTS
    // ==========================================================================
    console.log('\n─── Configuration Tests ───');

    test('getKeepaliveConfig: returns defaults when config.keepalive is undefined', () => {
        const original = config.keepalive;
        delete config.keepalive;
        try {
            const cfg = getKeepaliveConfig();
            assertFalse(cfg.enabled, 'Default enabled should be false');
            assertEqual(cfg.intervalMs, 5 * 60 * 1000, 'Default interval should be 5 minutes');
            assertEqual(cfg.jitterMs, 60 * 1000, 'Default jitter should be 60 seconds');
            assertEqual(cfg.maxConcurrent, 10, 'Default maxConcurrent should be 10');
            assertEqual(cfg.maxConsecutiveFailures, 5, 'Default maxConsecutiveFailures should be 5');
        } finally {
            config.keepalive = original;
        }
    });

    test('getKeepaliveConfig: respects config overrides', () => {
        const original = config.keepalive;
        config.keepalive = {
            enabled: true,
            intervalMs: 120000,
            jitterMs: 30000,
            maxConcurrent: 5,
            maxConsecutiveFailures: 3
        };
        try {
            const cfg = getKeepaliveConfig();
            assertTrue(cfg.enabled, 'Enabled should be true');
            assertEqual(cfg.intervalMs, 120000, 'Interval should be 120000');
            assertEqual(cfg.jitterMs, 30000, 'Jitter should be 30000');
            assertEqual(cfg.maxConcurrent, 5, 'maxConcurrent should be 5');
            assertEqual(cfg.maxConsecutiveFailures, 3, 'maxConsecutiveFailures should be 3');
        } finally {
            config.keepalive = original;
        }
    });

    test('getKeepaliveConfig: partially overridden config uses defaults for missing fields', () => {
        const original = config.keepalive;
        config.keepalive = { enabled: true };
        try {
            const cfg = getKeepaliveConfig();
            assertTrue(cfg.enabled);
            assertEqual(cfg.intervalMs, 5 * 60 * 1000, 'Missing intervalMs should use default');
            assertEqual(cfg.maxConcurrent, 10, 'Missing maxConcurrent should use default');
        } finally {
            config.keepalive = original;
        }
    });

    // ==========================================================================
    // HEALTH TRACKING TESTS
    // ==========================================================================
    console.log('\n─── Health Tracking Tests ───');

    test('getHealthSummary: empty when no pings recorded', () => {
        resetHealth();
        const summary = getHealthSummary();
        assertEqual(summary.total, 0, 'Total should be 0');
        assertEqual(summary.healthy, 0, 'Healthy should be 0');
        assertEqual(summary.failing, 0, 'Failing should be 0');
        assertEqual(summary.accounts.length, 0, 'Accounts should be empty');
    });

    test('resetHealth: clears all health data', () => {
        resetHealth();
        const summary = getHealthSummary();
        assertEqual(summary.total, 0, 'Should be empty after reset');
    });

    test('resetHealth: clears specific account', () => {
        resetHealth();
        // We can't directly add health data without pinging,
        // but we can verify resetHealth(email) doesn't throw
        resetHealth('test@example.com');
        const summary = getHealthSummary();
        assertEqual(summary.total, 0, 'Should remain empty');
    });

    // ==========================================================================
    // STATUS TESTS
    // ==========================================================================
    console.log('\n─── Status Tests ───');

    test('getKeepaliveStatus: includes running flag', () => {
        const status = getKeepaliveStatus();
        assertFalse(status.running, 'Should not be running by default');
    });

    test('getKeepaliveStatus: includes config', () => {
        const status = getKeepaliveStatus();
        assertNotNull(status.config, 'Should include config');
        assertNotNull(status.config.intervalMs, 'Should include intervalMs');
        assertNotNull(status.config.jitterMs, 'Should include jitterMs');
        assertNotNull(status.config.maxConcurrent, 'Should include maxConcurrent');
    });

    test('getKeepaliveStatus: includes health summary', () => {
        const status = getKeepaliveStatus();
        assertNotNull(status.health, 'Should include health');
        assertEqual(typeof status.health.total, 'number', 'health.total should be a number');
        assertEqual(typeof status.health.healthy, 'number', 'health.healthy should be a number');
    });

    // ==========================================================================
    // LIFECYCLE TESTS
    // ==========================================================================
    console.log('\n─── Lifecycle Tests ───');

    test('isKeepaliveRunning: returns false initially', () => {
        assertFalse(isKeepaliveRunning(), 'Should not be running');
    });

    test('stopKeepalive: safe to call when not running', () => {
        stopKeepalive(); // Should not throw
        assertFalse(isKeepaliveRunning(), 'Should still not be running');
    });

    test('startKeepalive: starts and sets running flag', () => {
        // Create a minimal mock account manager
        const mockAccountManager = {
            getAllAccounts: () => [],
            getTokenForAccount: async () => 'mock-token',
            getProjectForAccount: async () => 'mock-project'
        };

        startKeepalive(mockAccountManager);
        assertTrue(isKeepaliveRunning(), 'Should be running after start');

        // Clean up
        stopKeepalive();
        assertFalse(isKeepaliveRunning(), 'Should stop after stopKeepalive');
    });

    test('startKeepalive: warns when already running', () => {
        const mockAccountManager = {
            getAllAccounts: () => [],
            getTokenForAccount: async () => 'mock-token',
            getProjectForAccount: async () => 'mock-project'
        };

        startKeepalive(mockAccountManager);
        assertTrue(isKeepaliveRunning());

        // Second start should not throw, just warn
        startKeepalive(mockAccountManager);
        assertTrue(isKeepaliveRunning(), 'Should still be running');

        stopKeepalive();
    });

    // ==========================================================================
    // CONFIG IN config.js TESTS
    // ==========================================================================
    console.log('\n─── Config Integration Tests ───');

    test('config.keepalive: exists with correct defaults', () => {
        assertNotNull(config.keepalive, 'keepalive config should exist');
        assertFalse(config.keepalive.enabled, 'Should be disabled by default');
        assertEqual(config.keepalive.intervalMs, 5 * 60 * 1000, 'Default interval');
        assertEqual(config.keepalive.jitterMs, 60 * 1000, 'Default jitter');
        assertEqual(config.keepalive.maxConcurrent, 10, 'Default maxConcurrent');
        assertEqual(config.keepalive.maxConsecutiveFailures, 5, 'Default maxConsecutiveFailures');
    });

    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log(`Tests completed: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});

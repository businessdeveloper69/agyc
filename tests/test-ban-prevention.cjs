/**
 * Test Ban Prevention Measures - Unit Tests (Issue #277)
 *
 * Tests the ban prevention changes:
 * - Per-account session ID derivation (prevents cross-account correlation)
 * - TOS violation/ban detection in 403 errors
 * - buildCloudCodeRequest includes account email for session ID scoping
 *
 * No server required - these are pure unit tests.
 */

// Since we're in CommonJS and the module is ESM, we need to use dynamic import
async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           BAN PREVENTION TEST SUITE (Issue #277)             ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Dynamic imports for ESM modules
    const { deriveSessionId } = await import('../src/cloudcode/session-manager.js');
    const { isValidationRequired } = await import('../src/cloudcode/rate-limit-state.js');

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

    // ──────────────────────────────────────────────────────────────
    // Per-Account Session ID Tests
    // ──────────────────────────────────────────────────────────────
    console.log('\n─── Per-Account Session ID Tests ───');

    const sampleRequest = {
        messages: [{ role: 'user', content: 'Hello world' }]
    };

    const sampleRequestArray = {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello world' }] }]
    };

    test('deriveSessionId: same request without email is deterministic', () => {
        const id1 = deriveSessionId(sampleRequest);
        const id2 = deriveSessionId(sampleRequest);
        assertEqual(id1, id2, 'Same request should produce same session ID');
    });

    test('deriveSessionId: same request with same email is deterministic', () => {
        const id1 = deriveSessionId(sampleRequest, 'user@example.com');
        const id2 = deriveSessionId(sampleRequest, 'user@example.com');
        assertEqual(id1, id2, 'Same request + same email should produce same session ID');
    });

    test('deriveSessionId: different emails produce different session IDs', () => {
        const id1 = deriveSessionId(sampleRequest, 'user1@example.com');
        const id2 = deriveSessionId(sampleRequest, 'user2@example.com');
        assertTrue(id1 !== id2, 'Different emails should produce different session IDs');
    });

    test('deriveSessionId: with email differs from without email', () => {
        const idNoEmail = deriveSessionId(sampleRequest);
        const idWithEmail = deriveSessionId(sampleRequest, 'user@example.com');
        assertTrue(idNoEmail !== idWithEmail, 'With email should differ from without email');
    });

    test('deriveSessionId: empty email string matches no-email behavior', () => {
        const idNoEmail = deriveSessionId(sampleRequest);
        const idEmptyEmail = deriveSessionId(sampleRequest, '');
        assertEqual(idNoEmail, idEmptyEmail, 'Empty email should match no-email behavior');
    });

    test('deriveSessionId: returns 32-char hex string with email', () => {
        const id = deriveSessionId(sampleRequest, 'test@example.com');
        assertTrue(id.length === 32, 'Session ID should be 32 chars');
        assertTrue(/^[a-f0-9]+$/.test(id), 'Session ID should be hex');
    });

    test('deriveSessionId: works with array content blocks and email', () => {
        const id1 = deriveSessionId(sampleRequestArray, 'user@example.com');
        const id2 = deriveSessionId(sampleRequestArray, 'user@example.com');
        assertEqual(id1, id2, 'Array content with same email should be deterministic');

        const id3 = deriveSessionId(sampleRequestArray, 'other@example.com');
        assertTrue(id1 !== id3, 'Array content with different emails should differ');
    });

    test('deriveSessionId: no messages returns UUID regardless of email', () => {
        const emptyRequest = { messages: [] };
        const id1 = deriveSessionId(emptyRequest, 'user@example.com');
        const id2 = deriveSessionId(emptyRequest, 'user@example.com');
        // UUIDs are random, so they should be different
        assertTrue(id1 !== id2, 'No messages should return random UUID each time');
    });

    // ──────────────────────────────────────────────────────────────
    // TOS Violation / Ban Detection Tests
    // ──────────────────────────────────────────────────────────────
    console.log('\n─── TOS Violation / Ban Detection Tests ───');

    test('isValidationRequired: detects TOS ban message from issue #277', () => {
        const errorText = '{"error":{"code":403,"message":"Gemini has been disabled in this account for violation of Terms of Service","status":"PERMISSION_DENIED"}}';
        assertTrue(isValidationRequired(errorText), 'Should detect TOS violation ban');
    });

    test('isValidationRequired: detects "has been disabled" pattern', () => {
        assertTrue(isValidationRequired('The service has been disabled for this account'),
            'Should detect "has been disabled" pattern');
    });

    test('isValidationRequired: detects "violation of terms" pattern', () => {
        assertTrue(isValidationRequired('Blocked due to violation of terms'),
            'Should detect "violation of terms" pattern');
    });

    test('isValidationRequired: still detects VALIDATION_REQUIRED', () => {
        assertTrue(isValidationRequired('VALIDATION_REQUIRED'),
            'Should still detect VALIDATION_REQUIRED');
    });

    test('isValidationRequired: still detects ACCOUNT_DISABLED', () => {
        assertTrue(isValidationRequired('ACCOUNT_DISABLED'),
            'Should still detect ACCOUNT_DISABLED');
    });

    test('isValidationRequired: still detects USER_DISABLED', () => {
        assertTrue(isValidationRequired('USER_DISABLED'),
            'Should still detect USER_DISABLED');
    });

    test('isValidationRequired: does NOT match normal 403 permission denied', () => {
        assertFalse(isValidationRequired('The caller does not have permission'),
            'Should NOT match normal permission denied');
    });

    test('isValidationRequired: does NOT match IAM_PERMISSION_DENIED', () => {
        assertFalse(isValidationRequired('IAM_PERMISSION_DENIED: cloudaicompanion.companions.generateChat'),
            'Should NOT match IAM permission denied');
    });

    test('isValidationRequired: handles null/undefined/empty gracefully', () => {
        assertFalse(isValidationRequired(null), 'null should return false');
        assertFalse(isValidationRequired(undefined), 'undefined should return false');
        assertFalse(isValidationRequired(''), 'empty string should return false');
    });

    test('isValidationRequired: case insensitive matching', () => {
        assertTrue(isValidationRequired('HAS BEEN DISABLED'),
            'Should be case insensitive for "has been disabled"');
        assertTrue(isValidationRequired('VIOLATION OF TERMS'),
            'Should be case insensitive for "violation of terms"');
    });

    // ──────────────────────────────────────────────────────────────
    // Summary
    // ──────────────────────────────────────────────────────────────
    console.log(`\n════════════════════════════════════════════════════════════`);
    console.log(`Tests completed: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Test suite error:', err);
    process.exit(1);
});

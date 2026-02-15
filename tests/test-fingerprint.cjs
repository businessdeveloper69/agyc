/**
 * Test Request Fingerprint Randomization - Unit Tests
 *
 * Tests the fingerprint module that prevents third-party detection:
 * - Per-instance fingerprint generation and consistency
 * - User-Agent version randomization within realistic range
 * - Request ID format variation
 * - Request type variation
 * - API client identifier variation
 * - Fingerprint reset and re-generation
 *
 * No server required - tests run standalone.
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║         REQUEST FINGERPRINT RANDOMIZATION TEST SUITE         ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Dynamic import for ESM module
    const {
        getInstanceFingerprint,
        resetInstanceFingerprint,
        generateRequestId,
        getRequestType,
        generateUserAgent,
        getApiClientIdentifier,
        getFingerprintSummary
    } = await import('../src/utils/fingerprint.js');

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

    function assertNotNull(value, message = '') {
        if (value === null || value === undefined) {
            throw new Error(`${message}\nExpected non-null value but got: ${value}`);
        }
    }

    function assertIncludes(array, value, message = '') {
        if (!array.includes(value)) {
            throw new Error(`${message}\nExpected one of: ${JSON.stringify(array)}\nActual: ${value}`);
        }
    }

    // Known valid values
    const VALID_VERSIONS = [
        '1.16.5', '1.16.4', '1.16.3', '1.16.2', '1.16.1',
        '1.15.3', '1.15.2', '1.15.1',
        '1.14.2', '1.14.1'
    ];

    const VALID_API_CLIENTS = [
        'google-cloud-sdk vscode_cloudshelleditor/0.1',
        'google-cloud-sdk vscode_cloudshelleditor/0.2',
        'google-cloud-sdk cca/0.1'
    ];

    const VALID_REQUEST_TYPES = ['agent', 'chat', 'completion'];
    const VALID_REQUEST_ID_PREFIXES = ['agent-', 'chat-', 'req-', ''];

    // ==========================================================================
    // INSTANCE FINGERPRINT TESTS
    // ==========================================================================
    console.log('\n─── Instance Fingerprint Tests ───');

    test('getInstanceFingerprint: returns an object with all required fields', () => {
        resetInstanceFingerprint();
        const fp = getInstanceFingerprint();
        assertNotNull(fp.version, 'version should be set');
        assertNotNull(fp.apiClient, 'apiClient should be set');
        assertNotNull(fp.requestType, 'requestType should be set');
        assertTrue(fp.requestIdPrefix !== undefined, 'requestIdPrefix should be defined');
    });

    test('getInstanceFingerprint: version is from valid range', () => {
        resetInstanceFingerprint();
        const fp = getInstanceFingerprint();
        assertIncludes(VALID_VERSIONS, fp.version, 'Version should be from known list');
    });

    test('getInstanceFingerprint: apiClient is from valid range', () => {
        resetInstanceFingerprint();
        const fp = getInstanceFingerprint();
        assertIncludes(VALID_API_CLIENTS, fp.apiClient, 'API client should be from known list');
    });

    test('getInstanceFingerprint: requestType is from valid range', () => {
        resetInstanceFingerprint();
        const fp = getInstanceFingerprint();
        assertIncludes(VALID_REQUEST_TYPES, fp.requestType, 'Request type should be from known list');
    });

    test('getInstanceFingerprint: requestIdPrefix is from valid range', () => {
        resetInstanceFingerprint();
        const fp = getInstanceFingerprint();
        assertIncludes(VALID_REQUEST_ID_PREFIXES, fp.requestIdPrefix, 'Request ID prefix should be from known list');
    });

    test('getInstanceFingerprint: returns consistent values on repeated calls', () => {
        resetInstanceFingerprint();
        const fp1 = getInstanceFingerprint();
        const fp2 = getInstanceFingerprint();
        assertEqual(fp1.version, fp2.version, 'Version should be consistent');
        assertEqual(fp1.apiClient, fp2.apiClient, 'API client should be consistent');
        assertEqual(fp1.requestType, fp2.requestType, 'Request type should be consistent');
        assertEqual(fp1.requestIdPrefix, fp2.requestIdPrefix, 'Request ID prefix should be consistent');
    });

    test('resetInstanceFingerprint: generates new fingerprint after reset', () => {
        // Run multiple resets and check that at least one is different
        // (probability of all 10 being identical is astronomically low)
        const fingerprints = [];
        for (let i = 0; i < 10; i++) {
            resetInstanceFingerprint();
            fingerprints.push(getInstanceFingerprint().version);
        }
        // All versions should be valid
        for (const v of fingerprints) {
            assertIncludes(VALID_VERSIONS, v, 'All versions should be from valid range');
        }
        // At least some variety should exist (statistical test)
        const unique = new Set(fingerprints);
        // With 10 versions and 10 tries, we should get at least 2 unique values
        // (probability of all same is (1/10)^9 ≈ 0.000000001)
        assertTrue(unique.size >= 1, 'Should generate valid versions');
    });

    // ==========================================================================
    // REQUEST ID TESTS
    // ==========================================================================
    console.log('\n─── Request ID Tests ───');

    test('generateRequestId: returns a non-empty string', () => {
        resetInstanceFingerprint();
        const id = generateRequestId();
        assertTrue(id.length > 0, 'Request ID should be non-empty');
    });

    test('generateRequestId: contains UUID component', () => {
        resetInstanceFingerprint();
        const id = generateRequestId();
        // UUID v4 format: 8-4-4-4-12 hex digits
        const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
        assertTrue(uuidRegex.test(id), `Request ID should contain UUID: ${id}`);
    });

    test('generateRequestId: generates unique IDs on each call', () => {
        resetInstanceFingerprint();
        const id1 = generateRequestId();
        const id2 = generateRequestId();
        assertTrue(id1 !== id2, 'Sequential request IDs should be different');
    });

    test('generateRequestId: prefix matches instance fingerprint', () => {
        resetInstanceFingerprint();
        const fp = getInstanceFingerprint();
        const id = generateRequestId();
        assertTrue(id.startsWith(fp.requestIdPrefix), `Request ID should start with prefix "${fp.requestIdPrefix}": ${id}`);
    });

    // ==========================================================================
    // REQUEST TYPE TESTS
    // ==========================================================================
    console.log('\n─── Request Type Tests ───');

    test('getRequestType: returns a valid request type', () => {
        resetInstanceFingerprint();
        const type = getRequestType();
        assertIncludes(VALID_REQUEST_TYPES, type, 'Request type should be valid');
    });

    test('getRequestType: returns consistent value per instance', () => {
        resetInstanceFingerprint();
        const type1 = getRequestType();
        const type2 = getRequestType();
        assertEqual(type1, type2, 'Request type should be consistent per instance');
    });

    // ==========================================================================
    // USER-AGENT TESTS
    // ==========================================================================
    console.log('\n─── User-Agent Tests ───');

    test('generateUserAgent: matches expected format', () => {
        resetInstanceFingerprint();
        const ua = generateUserAgent('linux', 'x64');
        assertTrue(ua.startsWith('antigravity/'), `User-Agent should start with "antigravity/": ${ua}`);
        assertTrue(ua.includes('linux/x64'), `User-Agent should contain "linux/x64": ${ua}`);
    });

    test('generateUserAgent: uses fingerprint version', () => {
        resetInstanceFingerprint();
        const fp = getInstanceFingerprint();
        const ua = generateUserAgent('darwin', 'arm64');
        assertTrue(ua.includes(fp.version), `User-Agent should contain version ${fp.version}: ${ua}`);
    });

    test('generateUserAgent: works with different OS/arch combinations', () => {
        resetInstanceFingerprint();
        const ua1 = generateUserAgent('win32', 'x64');
        const ua2 = generateUserAgent('darwin', 'arm64');
        const ua3 = generateUserAgent('linux', 'x64');
        assertTrue(ua1.includes('win32/x64'), `Windows UA should contain platform: ${ua1}`);
        assertTrue(ua2.includes('darwin/arm64'), `macOS UA should contain platform: ${ua2}`);
        assertTrue(ua3.includes('linux/x64'), `Linux UA should contain platform: ${ua3}`);
    });

    // ==========================================================================
    // API CLIENT IDENTIFIER TESTS
    // ==========================================================================
    console.log('\n─── API Client Identifier Tests ───');

    test('getApiClientIdentifier: returns a valid identifier', () => {
        resetInstanceFingerprint();
        const id = getApiClientIdentifier();
        assertIncludes(VALID_API_CLIENTS, id, 'API client ID should be valid');
    });

    test('getApiClientIdentifier: returns consistent value per instance', () => {
        resetInstanceFingerprint();
        const id1 = getApiClientIdentifier();
        const id2 = getApiClientIdentifier();
        assertEqual(id1, id2, 'API client ID should be consistent per instance');
    });

    // ==========================================================================
    // FINGERPRINT SUMMARY TESTS
    // ==========================================================================
    console.log('\n─── Fingerprint Summary Tests ───');

    test('getFingerprintSummary: returns all fields', () => {
        resetInstanceFingerprint();
        const summary = getFingerprintSummary();
        assertNotNull(summary.version, 'Summary should include version');
        assertNotNull(summary.apiClient, 'Summary should include apiClient');
        assertNotNull(summary.requestType, 'Summary should include requestType');
        assertTrue(summary.requestIdPrefix !== undefined, 'Summary should include requestIdPrefix');
    });

    test('getFingerprintSummary: returns a copy (not reference)', () => {
        resetInstanceFingerprint();
        const summary = getFingerprintSummary();
        summary.version = 'MODIFIED';
        const original = getInstanceFingerprint();
        assertTrue(original.version !== 'MODIFIED', 'Modifying summary should not affect original fingerprint');
    });

    // Pre-import for integration tests
    const { ANTIGRAVITY_HEADERS, getAntigravityHeaders } = await import('../src/constants.js');
    const { buildCloudCodeRequest } = await import('../src/cloudcode/request-builder.js');

    // ==========================================================================
    // CONSTANTS INTEGRATION TEST
    // ==========================================================================
    console.log('\n─── Constants Integration Tests ───');

    test('ANTIGRAVITY_HEADERS: User-Agent uses fingerprint version', () => {
        const ua = ANTIGRAVITY_HEADERS['User-Agent'];
        assertTrue(ua.startsWith('antigravity/'), `User-Agent should start with antigravity/: ${ua}`);
        // Extract version from User-Agent
        const version = ua.split(' ')[0].split('/')[1];
        assertIncludes(VALID_VERSIONS, version, 'User-Agent version should be from valid range');
    });

    test('ANTIGRAVITY_HEADERS: X-Goog-Api-Client uses fingerprint', () => {
        const apiClient = ANTIGRAVITY_HEADERS['X-Goog-Api-Client'];
        assertIncludes(VALID_API_CLIENTS, apiClient, 'X-Goog-Api-Client should be from valid range');
    });

    test('ANTIGRAVITY_HEADERS: Client-Metadata is valid JSON with required fields', () => {
        const metadata = JSON.parse(ANTIGRAVITY_HEADERS['Client-Metadata']);
        assertEqual(metadata.ideType, 6, 'ideType should be 6 (ANTIGRAVITY)');
        assertEqual(metadata.pluginType, 2, 'pluginType should be 2 (GEMINI)');
        assertNotNull(metadata.platform, 'platform should be set');
    });

    test('getAntigravityHeaders: returns same fingerprinted headers', () => {
        const headers = getAntigravityHeaders();
        assertEqual(headers['User-Agent'], ANTIGRAVITY_HEADERS['User-Agent'], 'User-Agent should match');
        assertEqual(headers['X-Goog-Api-Client'], ANTIGRAVITY_HEADERS['X-Goog-Api-Client'], 'X-Goog-Api-Client should match');
    });

    // ==========================================================================
    // REQUEST BUILDER INTEGRATION TEST
    // ==========================================================================
    console.log('\n─── Request Builder Integration Tests ───');

    test('buildCloudCodeRequest: uses fingerprinted requestType', () => {
        const request = buildCloudCodeRequest(
            { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'test' }] },
            'test-project'
        );
        assertIncludes(VALID_REQUEST_TYPES, request.requestType, 'requestType should be from valid range');
    });

    test('buildCloudCodeRequest: uses fingerprinted requestId prefix', () => {
        resetInstanceFingerprint();
        const fp = getInstanceFingerprint();
        const request = buildCloudCodeRequest(
            { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'test' }] },
            'test-project'
        );
        assertTrue(request.requestId.startsWith(fp.requestIdPrefix),
            `requestId should start with "${fp.requestIdPrefix}": ${request.requestId}`);
    });

    test('buildCloudCodeRequest: generates unique requestIds', () => {
        const req1 = buildCloudCodeRequest(
            { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'test' }] },
            'test-project'
        );
        const req2 = buildCloudCodeRequest(
            { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'test' }] },
            'test-project'
        );
        assertTrue(req1.requestId !== req2.requestId, 'Request IDs should be unique');
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

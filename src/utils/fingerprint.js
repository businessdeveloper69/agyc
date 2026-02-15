/**
 * Request Fingerprint Randomization
 *
 * Generates realistic, varied request fingerprints that match natural
 * Antigravity IDE behavior patterns. This prevents third-party detection
 * by ensuring outgoing requests to Google's Cloud Code API are
 * indistinguishable from genuine IDE sessions.
 *
 * Detection vectors addressed:
 * - User-Agent version: randomized within realistic Antigravity release range
 * - X-Goog-Api-Client: varied API client identifiers matching real IDE patterns
 * - Request ID prefix: varied between realistic IDE request types
 * - Session ID format: matches IDE session ID patterns (random UUID per session)
 *
 * Per-proxy-instance fingerprints are generated at startup and remain consistent
 * for the lifetime of the process (like a real IDE session would).
 */

import crypto from 'crypto';

// Realistic Antigravity IDE version range (recent releases)
const ANTIGRAVITY_VERSIONS = [
    '1.16.5', '1.16.4', '1.16.3', '1.16.2', '1.16.1',
    '1.15.3', '1.15.2', '1.15.1',
    '1.14.2', '1.14.1'
];

// Realistic X-Goog-Api-Client values observed from actual IDE traffic
const API_CLIENT_IDENTIFIERS = [
    'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'google-cloud-sdk vscode_cloudshelleditor/0.2',
    'google-cloud-sdk cca/0.1'
];

// Realistic request type options (from Cloud Code API analysis)
const REQUEST_TYPES = ['agent', 'chat', 'completion'];

// Realistic request ID prefixes matching IDE patterns
const REQUEST_ID_PREFIXES = ['agent-', 'chat-', 'req-', ''];

// ---------- Per-instance fingerprint (generated once at startup) ----------

let instanceFingerprint = null;

/**
 * Get or create the per-instance fingerprint.
 * Generated once at proxy startup, remains consistent like a real IDE session.
 *
 * @returns {{ version: string, apiClient: string, requestType: string, requestIdPrefix: string }}
 */
export function getInstanceFingerprint() {
    if (!instanceFingerprint) {
        instanceFingerprint = {
            version: ANTIGRAVITY_VERSIONS[Math.floor(Math.random() * ANTIGRAVITY_VERSIONS.length)],
            apiClient: API_CLIENT_IDENTIFIERS[Math.floor(Math.random() * API_CLIENT_IDENTIFIERS.length)],
            requestType: REQUEST_TYPES[Math.floor(Math.random() * REQUEST_TYPES.length)],
            requestIdPrefix: REQUEST_ID_PREFIXES[Math.floor(Math.random() * REQUEST_ID_PREFIXES.length)]
        };
    }
    return instanceFingerprint;
}

/**
 * Reset the instance fingerprint (for testing or rotation).
 */
export function resetInstanceFingerprint() {
    instanceFingerprint = null;
}

/**
 * Generate a random request ID using the instance fingerprint prefix.
 *
 * @returns {string} A request ID like "agent-<uuid>" or "chat-<uuid>" or just "<uuid>"
 */
export function generateRequestId() {
    const fp = getInstanceFingerprint();
    return fp.requestIdPrefix + crypto.randomUUID();
}

/**
 * Get the request type for the current instance fingerprint.
 *
 * @returns {string} Request type (e.g., 'agent', 'chat', 'completion')
 */
export function getRequestType() {
    return getInstanceFingerprint().requestType;
}

/**
 * Generate a User-Agent string using the instance fingerprint version.
 *
 * @param {string} os - Operating system string (e.g., 'linux', 'darwin')
 * @param {string} architecture - Architecture string (e.g., 'x64', 'arm64')
 * @returns {string} User-Agent string like "antigravity/1.16.3 linux/x64"
 */
export function generateUserAgent(os, architecture) {
    const fp = getInstanceFingerprint();
    return `antigravity/${fp.version} ${os}/${architecture}`;
}

/**
 * Get the X-Goog-Api-Client value for the current instance fingerprint.
 *
 * @returns {string} API client identifier
 */
export function getApiClientIdentifier() {
    return getInstanceFingerprint().apiClient;
}

/**
 * Get the current fingerprint summary for logging/status.
 *
 * @returns {{ version: string, apiClient: string, requestType: string, requestIdPrefix: string }}
 */
export function getFingerprintSummary() {
    return { ...getInstanceFingerprint() };
}

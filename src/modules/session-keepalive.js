/**
 * Session Keepalive Module
 *
 * Maintains active sessions for all configured accounts by performing
 * lightweight background API calls (fetchAvailableModels, loadCodeAssist)
 * that mimic normal Antigravity IDE activity.
 *
 * Features:
 * - Non-deterministic scheduling with configurable jitter
 * - Concurrent execution across all enabled accounts
 * - Uses native Antigravity API headers/endpoints (same as real IDE)
 * - Purely background activity - does not interfere with actual proxy requests
 * - Per-account health tracking and logging
 * - Modular start/stop lifecycle
 */

import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    LOAD_CODE_ASSIST_ENDPOINTS,
    LOAD_CODE_ASSIST_HEADERS,
    CLIENT_METADATA,
    DEFAULT_PROJECT_ID
} from '../constants.js';
import { logger } from '../utils/logger.js';
import { sleep, throttledFetch } from '../utils/helpers.js';
import { config } from '../config.js';

// ---------- Action types ----------

/**
 * Ping action: fetchAvailableModels
 * Lightweight model listing - mimics IDE polling for quota/model updates
 *
 * @param {string} token - OAuth access token
 * @param {string|null} projectId - Project ID for accurate quota
 * @returns {Promise<{success: boolean, action: string, details: string}>}
 */
async function actionFetchModels(token, projectId) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
    };
    const body = projectId ? { project: projectId } : {};

    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const url = `${endpoint}/v1internal:fetchAvailableModels`;
            const response = await throttledFetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            if (response.ok) {
                const data = await response.json();
                const modelCount = data.models ? Object.keys(data.models).length : 0;
                return { success: true, action: 'fetchModels', details: `${modelCount} models` };
            }
        } catch {
            // Try next endpoint
        }
    }
    return { success: false, action: 'fetchModels', details: 'all endpoints failed' };
}

/**
 * Ping action: loadCodeAssist
 * Session validation call - mimics IDE startup/reconnection
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{success: boolean, action: string, details: string}>}
 */
async function actionLoadCodeAssist(token) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...LOAD_CODE_ASSIST_HEADERS
    };

    for (const endpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
        try {
            const url = `${endpoint}/v1internal:loadCodeAssist`;
            const response = await throttledFetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    metadata: {
                        ...CLIENT_METADATA,
                        duetProject: DEFAULT_PROJECT_ID
                    }
                })
            });

            if (response.ok) {
                return { success: true, action: 'loadCodeAssist', details: 'session valid' };
            }
        } catch {
            // Try next endpoint
        }
    }
    return { success: false, action: 'loadCodeAssist', details: 'all endpoints failed' };
}

// Available keepalive actions with relative weights
const KEEPALIVE_ACTIONS = [
    { fn: actionFetchModels, name: 'fetchModels', weight: 3, needsProject: true },
    { fn: actionLoadCodeAssist, name: 'loadCodeAssist', weight: 2, needsProject: false }
];

/**
 * Select a random action based on weights
 * @returns {{ fn: Function, name: string, needsProject: boolean }}
 */
function selectAction() {
    const totalWeight = KEEPALIVE_ACTIONS.reduce((sum, a) => sum + a.weight, 0);
    let rand = Math.random() * totalWeight;
    for (const action of KEEPALIVE_ACTIONS) {
        rand -= action.weight;
        if (rand <= 0) return action;
    }
    return KEEPALIVE_ACTIONS[0];
}

// ---------- Per-account health ----------

/** @type {Map<string, { lastPing: number|null, lastSuccess: boolean, consecutiveFailures: number, totalPings: number, totalSuccesses: number }>} */
const accountHealth = new Map();

function getOrCreateHealth(email) {
    if (!accountHealth.has(email)) {
        accountHealth.set(email, {
            lastPing: null,
            lastSuccess: true,
            consecutiveFailures: 0,
            totalPings: 0,
            totalSuccesses: 0
        });
    }
    return accountHealth.get(email);
}

function recordPing(email, success) {
    const h = getOrCreateHealth(email);
    h.lastPing = Date.now();
    h.lastSuccess = success;
    h.totalPings++;
    if (success) {
        h.totalSuccesses++;
        h.consecutiveFailures = 0;
    } else {
        h.consecutiveFailures++;
    }
}

// ---------- Keepalive scheduler ----------

let schedulerTimer = null;
let isRunning = false;
/** @type {import('../account-manager/index.js').AccountManager|null} */
let accountManagerRef = null;

/**
 * Get keepalive config with defaults
 * @returns {{ enabled: boolean, intervalMs: number, jitterMs: number, maxConcurrent: number, maxConsecutiveFailures: number }}
 */
export function getKeepaliveConfig() {
    const ka = config.keepalive || {};
    return {
        enabled: ka.enabled !== undefined ? ka.enabled : false,
        intervalMs: ka.intervalMs || 5 * 60 * 1000,      // 5 minutes
        jitterMs: ka.jitterMs || 60 * 1000,               // ±60 seconds
        maxConcurrent: ka.maxConcurrent || 10,             // Max parallel pings
        maxConsecutiveFailures: ka.maxConsecutiveFailures || 5
    };
}

/**
 * Compute the next delay with jitter
 * @param {number} intervalMs - Base interval
 * @param {number} jitterMs - Max jitter (+/-)
 * @returns {number} Delay in ms
 */
function nextDelay(intervalMs, jitterMs) {
    const jitter = (Math.random() * 2 - 1) * jitterMs; // ±jitterMs
    return Math.max(30000, intervalMs + jitter);        // At least 30 seconds
}

/**
 * Ping a single account
 *
 * @param {Object} account - Account object from AccountManager
 * @returns {Promise<void>}
 */
async function pingAccount(account) {
    const email = account.email;

    // Skip disabled or invalid accounts
    if (account.enabled === false || account.isInvalid) return;

    // Skip accounts with too many consecutive failures
    const health = getOrCreateHealth(email);
    const cfg = getKeepaliveConfig();
    if (health.consecutiveFailures >= cfg.maxConsecutiveFailures) {
        logger.debug(`[Keepalive] Skipping ${email} - ${health.consecutiveFailures} consecutive failures`);
        return;
    }

    try {
        // Get token via AccountManager (reuses cached tokens)
        const token = await accountManagerRef.getTokenForAccount(account);

        // Select a random action
        const action = selectAction();

        // Get project if needed
        let projectId = null;
        if (action.needsProject) {
            try {
                projectId = await accountManagerRef.getProjectForAccount(account, token);
            } catch {
                // Project discovery can fail for some accounts; proceed without it
            }
        }

        // Execute the action
        const result = action.needsProject
            ? await action.fn(token, projectId)
            : await action.fn(token);

        recordPing(email, result.success);

        if (result.success) {
            logger.debug(`[Keepalive] ✓ ${email} - ${result.action} (${result.details})`);
        } else {
            logger.warn(`[Keepalive] ✗ ${email} - ${result.action} failed: ${result.details}`);
        }
    } catch (error) {
        recordPing(email, false);

        // Auth errors are expected for invalid accounts; don't spam logs
        if (error.message?.startsWith('AUTH_INVALID')) {
            logger.debug(`[Keepalive] ${email} - auth invalid, skipping`);
        } else {
            logger.warn(`[Keepalive] ${email} - error: ${error.message}`);
        }
    }
}

/**
 * Execute one keepalive cycle across all accounts
 * Processes accounts in randomized order with concurrency limit
 */
async function runCycle() {
    if (!accountManagerRef) return;

    const accounts = accountManagerRef.getAllAccounts();
    if (!accounts || accounts.length === 0) return;

    const cfg = getKeepaliveConfig();

    // Shuffle accounts for non-deterministic ordering
    const shuffled = [...accounts].sort(() => Math.random() - 0.5);

    // Process in batches to limit concurrency
    for (let i = 0; i < shuffled.length; i += cfg.maxConcurrent) {
        if (!isRunning) break; // Respect stop signal mid-cycle

        const batch = shuffled.slice(i, i + cfg.maxConcurrent);

        // Add small random stagger between accounts in batch (0-2s each)
        const promises = batch.map((account, idx) =>
            sleep(idx * Math.random() * 2000).then(() => pingAccount(account))
        );

        await Promise.allSettled(promises);

        // Brief pause between batches
        if (i + cfg.maxConcurrent < shuffled.length) {
            await sleep(1000 + Math.random() * 2000);
        }
    }

    const healthySummary = getHealthSummary();
    logger.debug(`[Keepalive] Cycle complete: ${healthySummary.healthy}/${healthySummary.total} accounts healthy`);
}

/**
 * Schedule the next keepalive cycle
 */
function scheduleNext() {
    if (!isRunning) return;
    const cfg = getKeepaliveConfig();
    const delay = nextDelay(cfg.intervalMs, cfg.jitterMs);
    logger.debug(`[Keepalive] Next cycle in ${Math.round(delay / 1000)}s`);
    schedulerTimer = setTimeout(async () => {
        try {
            await runCycle();
        } catch (error) {
            logger.error(`[Keepalive] Cycle error: ${error.message}`);
        }
        scheduleNext();
    }, delay);
}

// ---------- Public API ----------

/**
 * Start the keepalive scheduler
 *
 * @param {import('../account-manager/index.js').AccountManager} accountManager
 */
export function startKeepalive(accountManager) {
    if (isRunning) {
        logger.warn('[Keepalive] Already running');
        return;
    }

    accountManagerRef = accountManager;
    isRunning = true;

    const cfg = getKeepaliveConfig();
    logger.info(`[Keepalive] Started - interval: ${Math.round(cfg.intervalMs / 1000)}s, jitter: ±${Math.round(cfg.jitterMs / 1000)}s`);

    // Run first cycle after a short delay (let server finish starting)
    const initialDelay = 10000 + Math.random() * 20000; // 10-30s
    schedulerTimer = setTimeout(async () => {
        try {
            await runCycle();
        } catch (error) {
            logger.error(`[Keepalive] Initial cycle error: ${error.message}`);
        }
        scheduleNext();
    }, initialDelay);
}

/**
 * Stop the keepalive scheduler
 */
export function stopKeepalive() {
    if (!isRunning) return;
    isRunning = false;
    if (schedulerTimer) {
        clearTimeout(schedulerTimer);
        schedulerTimer = null;
    }
    logger.info('[Keepalive] Stopped');
}

/**
 * Check if keepalive is running
 * @returns {boolean}
 */
export function isKeepaliveRunning() {
    return isRunning;
}

/**
 * Get health summary for all tracked accounts
 * @returns {{ total: number, healthy: number, failing: number, accounts: Array }}
 */
export function getHealthSummary() {
    const entries = Array.from(accountHealth.entries()).map(([email, h]) => ({
        email,
        lastPing: h.lastPing,
        lastSuccess: h.lastSuccess,
        consecutiveFailures: h.consecutiveFailures,
        totalPings: h.totalPings,
        totalSuccesses: h.totalSuccesses,
        successRate: h.totalPings > 0 ? Math.round((h.totalSuccesses / h.totalPings) * 100) : null
    }));

    return {
        total: entries.length,
        healthy: entries.filter(e => e.lastSuccess).length,
        failing: entries.filter(e => !e.lastSuccess && e.totalPings > 0).length,
        accounts: entries
    };
}

/**
 * Get keepalive status for API/WebUI
 * @returns {Object} Status object
 */
export function getKeepaliveStatus() {
    const cfg = getKeepaliveConfig();
    const health = getHealthSummary();

    return {
        running: isRunning,
        config: {
            enabled: cfg.enabled,
            intervalMs: cfg.intervalMs,
            jitterMs: cfg.jitterMs,
            maxConcurrent: cfg.maxConcurrent,
            maxConsecutiveFailures: cfg.maxConsecutiveFailures
        },
        health
    };
}

/**
 * Reset health tracking for a specific account or all accounts
 * @param {string|null} email - Account email, or null to reset all
 */
export function resetHealth(email = null) {
    if (email) {
        accountHealth.delete(email);
    } else {
        accountHealth.clear();
    }
}

export default {
    startKeepalive,
    stopKeepalive,
    isKeepaliveRunning,
    getKeepaliveConfig,
    getKeepaliveStatus,
    getHealthSummary,
    resetHealth
};

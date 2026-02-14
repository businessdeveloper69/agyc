/**
 * Session Management for Cloud Code
 *
 * Handles session ID derivation for prompt caching continuity.
 * Session IDs are derived from the first user message to ensure
 * the same conversation uses the same session across turns.
 */

import crypto from 'crypto';

/**
 * Derive a stable session ID from the first user message in the conversation.
 * This ensures the same conversation uses the same session ID across turns,
 * enabling prompt caching (cache is scoped to session + organization).
 *
 * The account email is included in the hash so that different accounts produce
 * different session IDs for the same conversation. This prevents Google from
 * seeing identical session identifiers across multiple accounts, which could
 * be flagged as abuse / ToS violation (see GitHub issue #277).
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {string} [accountEmail] - Account email to scope session ID per-account
 * @returns {string} A stable session ID (32 hex characters) or random UUID if no user message
 */
export function deriveSessionId(anthropicRequest, accountEmail = '') {
    const messages = anthropicRequest.messages || [];

    // Find the first user message
    for (const msg of messages) {
        if (msg.role === 'user') {
            let content = '';

            if (typeof msg.content === 'string') {
                content = msg.content;
            } else if (Array.isArray(msg.content)) {
                // Extract text from content blocks
                content = msg.content
                    .filter(block => block.type === 'text' && block.text)
                    .map(block => block.text)
                    .join('\n');
            }

            if (content) {
                // Include account email in hash so each account gets a unique session ID
                const hashInput = accountEmail ? `${accountEmail}:${content}` : content;
                const hash = crypto.createHash('sha256').update(hashInput).digest('hex');
                return hash.substring(0, 32);
            }
        }
    }

    // Fallback to random UUID if no user message found
    return crypto.randomUUID();
}

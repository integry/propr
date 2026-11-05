import { redactVisualPreviewPaths } from '../services/visualPreviewPaths.js';
import { PROPR_MCP_BEARER_TOKEN_ENV } from '../agents/agentToolPolicy.js';

// Free of service dependencies so lightweight modules can redact without loading log or pricing services.
interface SecretPattern {
    pattern: RegExp;
    replacement: string;
    /** When set, the replacement callback is used instead of a literal string substitution. */
    dynamicReplacement?: 'bearer';
}

/** Container env vars that carry per-run MCP bearer tokens. */
const TOOL_POLICY_BEARER_ENV_NAMES = [PROPR_MCP_BEARER_TOKEN_ENV];

const SECRET_PATTERNS: SecretPattern[] = [
    // =====================================================================
    // Strict provider patterns — these have distinctive, well-known prefixes
    // and are safe to match with high confidence.
    // =====================================================================

    // --- GitHub ---
    { pattern: /ghp_[A-Za-z0-9_]{36,}/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
    { pattern: /gho_[A-Za-z0-9_]{36,}/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
    { pattern: /ghu_[A-Za-z0-9_]{36,}/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
    { pattern: /ghs_[A-Za-z0-9_.-]{36,}/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
    { pattern: /github_pat_[A-Za-z0-9_]{22,}/g, replacement: '[REDACTED_GITHUB_TOKEN]' },

    // --- AWS ---
    { pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/g, replacement: '[REDACTED_AWS_ACCESS_KEY]' },
    { pattern: /(?<=(?:aws_secret_access_key|aws_secret_key|AWS_SECRET_ACCESS_KEY|AWS_SECRET_KEY|secret_access_key)\s*[=:]\s*['"]?)[A-Za-z0-9/+=]{40}/g, replacement: '[REDACTED_AWS_SECRET_KEY]' },
    { pattern: /(?<=["'](?:aws_secret_access_key|aws_secret_key|SecretAccessKey|secretAccessKey)["']\s*[=:]\s*['"]?)[A-Za-z0-9/+=]{40}/g, replacement: '[REDACTED_AWS_SECRET_KEY]' },

    // --- OpenRouter ---
    { pattern: /sk-or-v1-[A-Za-z0-9]{64}/g, replacement: '[REDACTED_OPENROUTER_KEY]' },

    // --- Stripe ---
    { pattern: /sk_live_[A-Za-z0-9]{24,}/g, replacement: '[REDACTED_STRIPE_SECRET_KEY]' },
    { pattern: /sk_test_[A-Za-z0-9]{24,}/g, replacement: '[REDACTED_STRIPE_SECRET_KEY]' },
    { pattern: /rk_live_[A-Za-z0-9]{24,}/g, replacement: '[REDACTED_STRIPE_RESTRICTED_KEY]' },
    { pattern: /rk_test_[A-Za-z0-9]{24,}/g, replacement: '[REDACTED_STRIPE_RESTRICTED_KEY]' },
    { pattern: /pk_live_[A-Za-z0-9]{24,}/g, replacement: '[REDACTED_STRIPE_PUBLISHABLE_KEY]' },
    { pattern: /pk_test_[A-Za-z0-9]{24,}/g, replacement: '[REDACTED_STRIPE_PUBLISHABLE_KEY]' },

    // --- OpenAI --- (legacy keys contain "T3BlbkFJ"; project keys start with "sk-proj-")
    { pattern: /sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/g, replacement: '[REDACTED_OPENAI_KEY]' },
    { pattern: /sk-proj-[A-Za-z0-9_-]{40,}/g, replacement: '[REDACTED_OPENAI_KEY]' },

    // --- Anthropic ---
    { pattern: /sk-ant-[A-Za-z0-9-]{32,}/g, replacement: '[REDACTED_ANTHROPIC_KEY]' },

    // --- Slack ---
    { pattern: /xoxb-[0-9]{10,}-[A-Za-z0-9]{10,}/g, replacement: '[REDACTED_SLACK_TOKEN]' },
    { pattern: /xoxp-[0-9]{10,}-[A-Za-z0-9]{10,}/g, replacement: '[REDACTED_SLACK_TOKEN]' },
    { pattern: /xapp-[0-9]{1,}-[A-Za-z0-9]{10,}/g, replacement: '[REDACTED_SLACK_TOKEN]' },
    { pattern: /xoxa-[0-9]{10,}-[A-Za-z0-9]{10,}/g, replacement: '[REDACTED_SLACK_TOKEN]' },

    // --- SendGrid ---
    { pattern: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g, replacement: '[REDACTED_SENDGRID_KEY]' },

    // --- Twilio ---
    { pattern: /SK[0-9a-fA-F]{32}/g, replacement: '[REDACTED_TWILIO_KEY]' },

    // --- Mailgun ---
    { pattern: /key-[A-Za-z0-9]{32}/g, replacement: '[REDACTED_MAILGUN_KEY]' },

    // --- Google ---
    { pattern: /AIza[A-Za-z0-9_-]{35}/g, replacement: '[REDACTED_GOOGLE_API_KEY]' },

    // =====================================================================
    // Heuristic / generic patterns — these rely on contextual signals (e.g.
    // assignment syntax, "Bearer" scheme) and use broader matching.  Order
    // matters: provider-specific rules above take precedence.
    // =====================================================================

    // Authorization headers — the header name is signal enough to redact a token of any length.
    { pattern: /(?<=\bAuthorization['"]?\s*[:=]\s*['"]?Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, replacement: '[REDACTED_BEARER_TOKEN]' },
    // Per-run MCP bearer token env vars, e.g. PROPR_MCP_BEARER_TOKEN=...
    { pattern: new RegExp(`(?<=\\b(?:${TOOL_POLICY_BEARER_ENV_NAMES.join('|')})\\s*[=:]\\s*['"]?)[^\\s'"]+`, 'g'), replacement: '[REDACTED_SECRET]' },
    // Bearer tokens — require at least 20 chars to avoid matching prose
    { pattern: /Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi, replacement: '', dynamicReplacement: 'bearer' },
    // Secret/token assignment patterns (catches env vars like SECRET_KEY=..., GITHUB_TOKEN=..., NPM_TOKEN=..., etc.)
    { pattern: /(?<=(?:^|[_A-Z])(?:SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|SECRET_KEY|SECRET_TOKEN|API_TOKEN|AUTH_TOKEN|TOKEN|GITHUB_TOKEN|NPM_TOKEN|SLACK_TOKEN|CI_JOB_TOKEN|CI_TOKEN|DEPLOY_TOKEN|SERVICE_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|APP_SECRET|WEBHOOK_SECRET)\s*[=:]\s*['"]?)[A-Za-z0-9/+=_-]{20,}(?=['"]?)/gim, replacement: '[REDACTED_SECRET]' },
];

export function redactSecrets(input: string): string {
    let result = redactVisualPreviewPaths(input);
    for (const { pattern, replacement, dynamicReplacement } of SECRET_PATTERNS) {
        if (dynamicReplacement === 'bearer') {
            // Preserve the original casing of "Bearer" / "bearer" / "BEARER"
            result = result.replace(pattern, (match) => {
                const scheme = match.split(/\s/)[0];
                return `${scheme} [REDACTED_BEARER_TOKEN]`;
            });
        } else {
            result = result.replace(pattern, replacement);
        }
    }
    return result;
}

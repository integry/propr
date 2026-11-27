/**
 * Guidance for `agy` logins that ProPR containers cannot read.
 *
 * On desktops with a Secret Service keyring (gnome-keyring, KWallet) and on
 * macOS, `agy` 1.5.x keeps its sign-in token in the OS keyring and writes only
 * a marker file. Containers have no keyring, so a mounted `~/.gemini` without
 * the file token fails every task even though the host is signed in. Forcing
 * file storage on one sign-in writes the token next to the keyring login.
 *
 * Diagnostics only: nothing here reads keyring contents or changes how tokens
 * are stored or copied.
 */

/** Environment variable that makes `agy` write its token to a file. */
export const ANTIGRAVITY_FILE_TOKEN_ENV = 'AGY_CLI_FORCE_FILE_TOKEN_STORAGE';

/** Host command that signs in with a file token ProPR containers can read. */
export const ANTIGRAVITY_FILE_TOKEN_SIGN_IN_COMMAND = `${ANTIGRAVITY_FILE_TOKEN_ENV}=1 agy`;

/** File token path relative to the Antigravity config directory (`~/.gemini`). */
export const ANTIGRAVITY_TOKEN_FILE = 'antigravity-cli/antigravity-oauth-token';

/** Marker `agy` writes, relative to the home directory, when the login lives in the OS keyring. */
export const ANTIGRAVITY_KEYRING_MARKER_FILE = '.config/antigravity/credential-user-scope';

/** Actionable reason shown when the configured directory has no readable login. */
export const ANTIGRAVITY_KEYRING_LOGIN_GUIDANCE = "agy stores its login in the OS keyring on desktops, which ProPR containers can't read. "
    + `Sign in once with \`${ANTIGRAVITY_FILE_TOKEN_SIGN_IN_COMMAND}\`, or use ProPR's managed login.`;

/** Short hint for setup flows that point ProPR at an existing `~/.gemini`. */
export const ANTIGRAVITY_EXISTING_LOGIN_HINT = `If agy keeps its login in the OS keyring (macOS, or a Linux desktop with gnome-keyring or KWallet), sign in once with \`${ANTIGRAVITY_FILE_TOKEN_SIGN_IN_COMMAND}\` so \`~/.gemini/${ANTIGRAVITY_TOKEN_FILE}\` exists. Your keyring login keeps working.`;

/** Help text for ProPR's managed login, which runs `agy` in a keyring-less container. */
export const ANTIGRAVITY_MANAGED_LOGIN_HINT = "The managed login runs agy inside a container with no OS keyring, so it always saves a file token ProPR can use.";

export interface AntigravityMissingLoginOptions {
    /** The host home shows `agy`'s keyring marker but the config directory has no file token. */
    keyringMarkerDetected?: boolean;
}

/** The actionable not-ready / failure reason for an unreadable Antigravity login. */
export function antigravityMissingLoginReason(options: AntigravityMissingLoginOptions = {}): string {
    if (!options.keyringMarkerDetected) return ANTIGRAVITY_KEYRING_LOGIN_GUIDANCE;
    return `Found ~/${ANTIGRAVITY_KEYRING_MARKER_FILE} but no ~/.gemini/${ANTIGRAVITY_TOKEN_FILE}: agy saved this login in the OS keyring, which ProPR containers can't read. `
        + `Sign in once with \`${ANTIGRAVITY_FILE_TOKEN_SIGN_IN_COMMAND}\`, or use ProPR's managed login.`;
}

// The entrypoint warning, and agy's own error at the start of a line
// ("Error: authentication required. Run 'agy' to log in, then retry.").
const MISSING_LOGIN_OUTPUT = /no obvious Antigravity authentication files|(?:^|\n)[ \t]*(?:error:[ \t]*)?authentication required\b/i;

/** Whether Antigravity container output shows the run had no usable login. */
export function isAntigravityMissingLoginOutput(output: string | undefined | null): boolean {
    return !!output && MISSING_LOGIN_OUTPUT.test(output);
}

/** The actionable failure reason for Antigravity output, or `undefined` when the output shows another failure. */
export function antigravityLoginFailureReason(output: string | undefined | null, options: AntigravityMissingLoginOptions = {}): string | undefined {
    return isAntigravityMissingLoginOutput(output) ? antigravityMissingLoginReason(options) : undefined;
}

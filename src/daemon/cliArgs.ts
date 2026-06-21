export interface ParsedArgs {
    reset?: boolean;
}

export function parseArgs(): ParsedArgs {
    const args = process.argv.slice(2);
    const options: ParsedArgs = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--reset' || arg === '-r') {
            options.reset = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log(`
GitHub Issue Detection Daemon

Usage: node src/daemon.js [options]

Options:
  --reset, -r    Clear all queue data and remove processing labels from issues
  --help, -h     Show this help message

Environment Variables:
  GITHUB_REPOS_TO_MONITOR    Comma-separated list of repositories to monitor
  GITHUB_EVENT_INTAKE_MODE   How GitHub events are received: routing_websocket
                             (default), polling, or direct_webhook
  POLLING_INTERVAL_MS        Polling interval in milliseconds (default: 60000)
  AI_PRIMARY_TAG             Primary tag to look for (default: AI)
  MODEL_LABEL_PATTERN        Regex pattern for model labels (default: ^llm-(.+)$)
  DEFAULT_CLAUDE_MODEL       Default model when no model labels found
  GITHUB_BOT_USERNAME        Bot username to exclude from PR comment monitoring
  GITHUB_USER_WHITELIST      Comma-separated list of allowed users for PR comments
  GITHUB_USER_BLACKLIST      Comma-separated list of excluded users for PR comments
  PR_FOLLOWUP_TRIGGER_KEYWORDS  Comma-separated list of trigger keywords

Examples:
  node src/daemon.js                Start the daemon normally
  node src/daemon.js --reset        Reset all queues and issue labels, then start
  npm run daemon:dev -- --reset     Reset using npm script
            `);
            process.exit(0);
        } else {
            console.error(`Unknown argument: ${arg}`);
            console.error('Use --help for usage information');
            process.exit(1);
        }
    }

    return options;
}

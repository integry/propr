import { isGithubUserWhitelisted } from '../utils/userWhitelist.js';

function configuredBotUsername(): string {
    return (process.env.GITHUB_BOT_USERNAME || 'propr-dev[bot]').trim();
}

export function isAuthorizedIssueTriggerActor(triggeredBy: string | undefined | null): boolean {
    if (isGithubUserWhitelisted(triggeredBy)) {
        return true;
    }

    if (!triggeredBy) {
        return false;
    }

    const botUsername = configuredBotUsername();
    return botUsername.length > 0 && triggeredBy.toLowerCase() === botUsername.toLowerCase();
}

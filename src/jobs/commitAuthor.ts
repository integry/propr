export const AI_COMMIT_AUTHOR = {
    name: process.env.PROPR_AGENT_COMMIT_AUTHOR_NAME || 'propr-dev[bot]',
    email: process.env.PROPR_AGENT_COMMIT_AUTHOR_EMAIL || `${process.env.GH_APP_ID || '1316198'}+propr-dev[bot]@users.noreply.github.com`,
};

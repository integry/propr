export async function safeRemoveLabel(context, labelName) {
    const { octokit, owner, repo, issueNumber, logger } = context;
    try {
        await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
            owner,
            repo,
            issue_number: issueNumber,
            name: labelName
        });
        logger.debug(`Successfully removed label '${labelName}' from issue #${issueNumber}`);
        return true;
    } catch (error) {
        if (error.status === 404) {
            logger.debug(`Label '${labelName}' not found on issue #${issueNumber}, skipping removal`);
            return true;
        }
        logger.warn({
            error: error.message,
            labelName,
            issueNumber,
            status: error.status
        }, `Failed to remove label '${labelName}' from issue #${issueNumber}`);
        return false;
    }
}

export async function safeAddLabel(context, labelName) {
    const { octokit, owner, repo, issueNumber, logger } = context;
    try {
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner,
            repo,
            issue_number: issueNumber,
            labels: [labelName]
        });
        logger.debug(`Successfully added label '${labelName}' to issue #${issueNumber}`);
        return true;
    } catch (error) {
        if (error.status === 422 && error.message?.includes('already exists')) {
            logger.debug(`Label '${labelName}' already exists on issue #${issueNumber}`);
            return true;
        }
        logger.warn({
            error: error.message,
            labelName,
            issueNumber,
            status: error.status
        }, `Failed to add label '${labelName}' to issue #${issueNumber}`);
        return false;
    }
}

export async function safeUpdateLabels(context, labelsToRemove = [], labelsToAdd = []) {
    const { issueNumber, logger } = context;
    const results = {
        success: true,
        removed: [],
        added: [],
        errors: []
    };

    for (const labelName of labelsToRemove) {
        const removed = await safeRemoveLabel(context, labelName);
        if (removed) {
            results.removed.push(labelName);
        } else {
            results.success = false;
            results.errors.push(`Failed to remove '${labelName}'`);
        }
    }

    for (const labelName of labelsToAdd) {
        const added = await safeAddLabel(context, labelName);
        if (added) {
            results.added.push(labelName);
        } else {
            results.success = false;
            results.errors.push(`Failed to add '${labelName}'`);
        }
    }

    logger.info({
        issueNumber,
        removed: results.removed,
        added: results.added,
        errors: results.errors.length > 0 ? results.errors : undefined
    }, 'Label update completed');

    return results;
}

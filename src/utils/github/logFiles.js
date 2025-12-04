import Redis from 'ioredis';
import logger from '../logger.js';
import { getUsageStats } from '../tokenCalculation.js'; 

export async function createLogFiles(claudeResult, issueRef) {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    
    const logDir = path.join(os.tmpdir(), 'claude-logs');
    await fs.promises.mkdir(logDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePrefix = `issue-${issueRef.number}-${timestamp}`;
    
    const files = {};
    
    if (claudeResult?.conversationLog && claudeResult.conversationLog.length > 0) {
        const conversationPath = path.join(logDir, `${filePrefix}-conversation.json`);
        const conversationData = {
            sessionId: claudeResult.sessionId,
            conversationId: claudeResult.conversationId,
            model: claudeResult.model,
            timestamp: new Date().toISOString(),
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            messages: claudeResult.conversationLog
        };
        await fs.promises.writeFile(conversationPath, JSON.stringify(conversationData, null, 2));
        files.conversation = conversationPath;
        logger.info({ conversationPath, messageCount: claudeResult.conversationLog.length }, 'Created conversation log file');
    }
    
    if (claudeResult?.rawOutput) {
        const outputPath = path.join(logDir, `${filePrefix}-output.txt`);
        await fs.promises.writeFile(outputPath, claudeResult.rawOutput);
        files.output = outputPath;
        logger.info({ outputPath, size: claudeResult.rawOutput.length }, 'Created raw output log file');
    }
    
    if (Object.keys(files).length > 0 && (claudeResult.sessionId || claudeResult.conversationId)) {
        try {
            const redis = new Redis({
                host: process.env.REDIS_HOST || 'redis',
                port: process.env.REDIS_PORT || 6379
            });
            
            const logData = {
                files: files,
                issueNumber: issueRef.number,
                repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                timestamp: timestamp,
                sessionId: claudeResult.sessionId,
                conversationId: claudeResult.conversationId
            };
            
            if (claudeResult.sessionId) {
                const sessionKey = `execution:logs:session:${claudeResult.sessionId}`;
                await redis.set(sessionKey, JSON.stringify(logData), 'EX', 86400 * 30);
            }
            
            if (claudeResult.conversationId) {
                const conversationKey = `execution:logs:conversation:${claudeResult.conversationId}`;
                await redis.set(conversationKey, JSON.stringify(logData), 'EX', 86400 * 30);
            }
            
            const issueKey = `execution:logs:issue:${issueRef.repoOwner}:${issueRef.repoName}:${issueRef.number}:${timestamp}`;
            await redis.set(issueKey, JSON.stringify(logData), 'EX', 86400 * 30);
            
            logger.info({
                issueNumber: issueRef.number,
                sessionId: claudeResult.sessionId,
                conversationId: claudeResult.conversationId,
                logFiles: Object.keys(files)
            }, 'Stored log file paths in Redis');
            
            await redis.quit();
        } catch (redisError) {
            logger.warn({
                issueNumber: issueRef.number,
                error: redisError.message
            }, 'Failed to store log file paths in Redis');
        }
    }
    
    return files;
}

export async function generateCompletionComment(claudeResult, issueRef) {
    const timestamp = new Date().toISOString();
    const isSuccess = claudeResult?.success || false;
    const executionTime = Math.round((claudeResult?.executionTime || 0) / 1000);
    const { inputTokens, outputTokens, totalTokens } = getUsageStats(claudeResult);
    const cost = claudeResult?.finalResult?.cost_usd || 0;
    
    let comment = `🤖 **AI Processing ${isSuccess ? 'Completed' : 'Failed'}**\n\n`;
    comment += `**Execution Details:**\n`;
    comment += `- Issue: #${issueRef.number}\n`;
    comment += `- Repository: ${issueRef.repoOwner}/${issueRef.repoName}\n`;
    comment += `- Status: ${isSuccess ? '✅ Success' : '❌ Failed'}\n`;
    comment += `- Execution Time: ${executionTime}s\n`;
    comment += `- Tokens used: ${totalTokens.toLocaleString()} tokens [${inputTokens.toLocaleString()} input + ${outputTokens.toLocaleString()} output]\n`;
    comment += `- API cost: $${cost}\n`;
    comment += `- Timestamp: ${timestamp}\n`;
    
    if (claudeResult?.conversationId) {
        comment += `- Conversation ID: \`${claudeResult.conversationId}\`\n`;
    }
    
    if (claudeResult?.model) {
        comment += `- LLM Model: ${claudeResult.model}\n`;
    }
    
    comment += `\n`;
    
    if (claudeResult?.summary) {
        comment += `**Summary:**\n${claudeResult.summary}\n\n`;
    }
    
    if (claudeResult?.finalResult) {
        const result = claudeResult.finalResult;
        
        if (result.subtype === 'error_max_turns') {
            comment += `⚠️ **Max Turns Reached**: Claude reached the maximum number of conversation turns (${result.num_turns}) before completing all tasks. Consider increasing the turn limit or breaking down the task into smaller parts.\n\n`;
        }
    }
    
    try {
        const logFiles = await createLogFiles(claudeResult, issueRef);
        
        if (Object.keys(logFiles).length > 0) {
            comment += `**📁 Detailed Logs:**\n`;
            
            if (logFiles.conversation && claudeResult.conversationLog?.length > 0) {
                comment += `- Conversation: ${claudeResult.conversationLog.length} messages\n`;
                comment += `- Session: \`${claudeResult.sessionId}\`\n`;
            }
            
            comment += `\nLog files stored at:\n`;
            Object.entries(logFiles).forEach(([type, path]) => {
                comment += `- ${type}: \`${path}\`\n`;
            });
            
            comment += `\n<details>\n<summary>💬 Latest Conversation Messages</summary>\n\n`;
            if (claudeResult.conversationLog && claudeResult.conversationLog.length > 0) {
                const lastMessages = claudeResult.conversationLog.slice(-3);
                comment += `\`\`\`\n`;
                lastMessages.forEach(msg => {
                    if (msg.type === 'assistant') {
                        const content = msg.message?.content?.[0]?.text || '[content unavailable]';
                        const preview = content.substring(0, 200);
                        comment += `ASSISTANT: ${preview}${content.length > 200 ? '...' : ''}\n\n`;
                    }
                });
                comment += `\`\`\`\n`;
            }
            comment += `</details>\n\n`;
        }
    } catch (logError) {
        logger.warn({
            issueNumber: issueRef.number,
            error: logError.message
        }, 'Failed to create log files');
    }
    
    comment += `---\n*Powered by Claude Code v${process.env.npm_package_version || 'unknown'}*`;
    
    return comment;
}

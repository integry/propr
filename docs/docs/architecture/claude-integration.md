---
sidebar_position: 4
---

# Claude Integration

The Claude integration (`src/claude/claudeService.js`) handles secure execution of Claude Code for issue analysis and implementation.

## Overview

ProPR uses Anthropic's Claude Code CLI to:
- Analyze GitHub issues and comments
- Search and understand codebases
- Implement solutions to problems
- Generate code changes

The integration is designed to keep Claude focused on implementation while the system handles all git operations.

## Architecture

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   Worker    │────────▶│   Claude    │────────▶│   Docker    │
│             │         │   Service   │         │  Container  │
└─────────────┘         └─────────────┘         └─────────────┘
      │                       │                        │
      │ Prompt + Context      │ Execute CLI            │ Isolated
      ▼                       ▼                        ▼ Environment
```

## Claude Code CLI

### Installation

The Claude Code CLI must be installed globally:

```bash
npm install -g @anthropic-ai/claude-code
```

### Authentication

Authentication is required before use:

```bash
claude login
```

This prepares the host Claude configuration directory used by ProPR. The default Claude agent config path is `~/.claude`.

### Non-Interactive Execution

ProPR runs Claude Code in non-interactive mode:
- No terminal UI
- Automatic execution
- Programmatic result parsing

## Docker Isolation

### Why Docker?

Claude Code runs in Docker containers for:
- **Security**: Isolated execution environment
- **Network control**: Restrict external connections
- **Resource limits**: Prevent runaway processes
- **Consistency**: Same environment across workers

### Docker Image

The custom Docker image (`Dockerfile.claude`) includes:
- Claude Code CLI
- Git tools
- Node.js runtime
- Security restrictions

Build the image:

```bash
docker build -f Dockerfile.claude -t claude-code-processor:latest .
```

### Container Configuration

Containers are configured with:

```javascript
{
  // Mount worktree as workspace
  volumes: [
    `${worktreePath}:/home/node/workspace:rw`,
    `${claudeConfigPath}:/home/node/.claude:rw`
  ],
  
  // Network restrictions
  network: 'none', // or 'bridge' if API access needed
  
  // Resource limits
  memory: '4g',
  cpus: '2',
  
  // Security
  readOnly: false, // Needs write for code changes
  user: 'root'
}
```

### Entrypoint Script

The Docker entrypoint (`scripts/claude-entrypoint.sh`) handles:
- Environment setup
- Claude CLI execution
- Output capture
- Error handling

## Prompt Engineering

### Prompt Structure

Prompts are carefully crafted to focus Claude on implementation:

```javascript
const prompt = `
Please analyze and implement a solution for GitHub issue #${issueNumber}.

**REPOSITORY INFORMATION:**
- Repository: ${repoOwner}/${repoName}
- Branch: ${branchName}
- Model: ${modelName}

**ISSUE DETAILS:**
Title: ${issueTitle}
Description:
${issueBody}

**COMMENTS (${commentCount} total):**
${comments.map(formatComment).join('\n\n')}

**YOUR FOCUS: IMPLEMENTATION ONLY**

The git workflow is handled automatically. Your job is to:
1. Understand the problem from the issue and comments
2. Search the codebase to understand the implementation
3. Implement the necessary changes
4. Test your implementation if possible

Do NOT:
- Worry about git operations (add, commit, push, PR)
- Use git commands or GitHub CLI for workflow
- Create documentation unless explicitly requested

The system will automatically:
- Commit your changes
- Push to GitHub  
- Create a pull request
- Link to the original issue

Focus solely on solving the problem with code.
`;
```

### Key Principles

1. **Clear context**: Provide complete issue information
2. **Focus directive**: Emphasize implementation, not git
3. **Boundaries**: Explicitly state what Claude should NOT do
4. **Assurance**: Explain what the system handles automatically

### Anti-Hallucination Measures

To prevent Claude from making incorrect assumptions:

- Include full issue description and all comments
- Provide repository context
- Encourage codebase search before implementation
- Request testing when possible

## Execution Flow

### 1. Preparation

```javascript
const execution = await claudeService.execute({
  prompt: prompt,
  workspacePath: worktreePath,
  model: modelId,
  timeout: CLAUDE_TIMEOUT_MS,
  maxTurns: CLAUDE_MAX_TURNS
});
```

### 2. Docker Container Launch

```bash
docker run \
  --rm \
  --network none \
  -v /path/to/worktree:/home/node/workspace:rw \
  -v ~/.claude:/home/node/.claude:rw \
  claude-code-processor:latest \
  claude chat --no-tui --max-turns 1000 "Your prompt here"
```

### 3. Claude Processing

Inside the container, Claude:
1. Receives the prompt
2. Analyzes the issue
3. Searches the codebase
4. Plans the implementation
5. Makes code changes
6. Reports completion

### 4. Output Capture

The service captures:
- Standard output (Claude's responses)
- Standard error (error messages)
- Exit code (success/failure)
- Duration (execution time)

### 5. Result Parsing

Parse Claude's output to extract:
- Implementation summary
- Files modified
- Any warnings or errors
- Commit message suggestions

## Model Selection

### Available Models

ProPR's shared model definitions include the Claude models available to the Claude agent. The active list is managed in code and surfaced through AI Agents in the Web UI.

```javascript
const MODELS = {
  sonnet46: 'claude-sonnet-4-6',
  opus46: 'claude-opus-4-6',
  sonnet45: 'claude-sonnet-4-5-20250929',
  opus45: 'claude-opus-4-5-20251101'
};
```

### Model Configuration

Models are specified via issue labels:
- `llm-claude-sonnet46` → Claude Sonnet 4.6
- `llm-claude-opus46` → Claude Opus 4.6

Older aliases such as `llm-claude-sonnet` and `llm-claude-opus` may resolve for backward compatibility, but new documentation and labels should use the canonical labels exposed by model definitions and agent settings.

### Model Characteristics

**Sonnet:**
- Faster processing
- Lower cost
- Good for most issues

**Opus:**
- More thorough analysis
- Better for complex problems
- Higher cost

## Error Handling

### Timeout Handling

If Claude exceeds the timeout:

```javascript
if (duration > CLAUDE_TIMEOUT_MS) {
  throw new Error('Claude execution timed out');
}
```

### Max Turns

Limit the number of conversation turns:

```bash
claude chat --max-turns 1000
```

Prevents infinite loops and runaway costs.

### Docker Errors

Handle Docker-specific errors:
- Container creation failures
- Volume mount issues
- Network problems
- Resource exhaustion

### Claude Errors

Handle Claude-specific errors:
- Authentication failures
- Model unavailability
- Rate limiting
- Invalid responses

## Security Considerations

### Network Isolation

By default, containers have no network access:

```javascript
network: 'none'
```

This prevents:
- Unauthorized API calls
- Data exfiltration
- Downloading malicious code

Enable network only if Claude needs external API access:

```javascript
network: 'bridge'
```

### Filesystem Isolation

Containers have restricted filesystem access:
- Read-only config directory
- Read-write workspace only
- No access to host filesystem

### Authentication Security

Claude authentication is mounted into the agent container:

```bash
-v ~/.claude:/home/node/.claude:rw
```

This gives Claude Code access to the host login state expected by the configured agent.

### Resource Limits

Containers have resource limits:
- Memory limit prevents exhaustion
- CPU limit prevents monopolization
- Timeout prevents indefinite execution

## Configuration

### Environment Variables

```bash
# Claude Code Configuration
CLAUDE_DOCKER_IMAGE=claude-code-processor:latest
CLAUDE_CONFIG_PATH=~/.claude
CLAUDE_MAX_TURNS=1000
CLAUDE_TIMEOUT_MS=300000
```

### Docker Configuration

Create `~/.docker/config.json` if needed:

```json
{
  "detachKeys": "ctrl-p,ctrl-q"
}
```

## Performance Optimization

### Response Streaming

Claude Code streams responses in real-time:
- Early visibility into progress
- Ability to detect issues quickly
- Better user experience for interactive use

### Caching

Docker image layers are cached:
- Base image cached after first pull
- Only changed layers rebuilt
- Faster container startup

### Parallel Execution

Multiple workers can run Claude simultaneously:
- Each worker has independent container
- No interference between executions
- Limited only by system resources

## Monitoring and Debugging

### Logging

The service logs important events:

```javascript
logger.info('Starting Claude execution', {
  model: modelId,
  issueNumber: issueNumber,
  timeout: CLAUDE_TIMEOUT_MS
});

logger.info('Claude execution complete', {
  duration: duration,
  exitCode: exitCode,
  outputLength: output.length
});
```

### Debug Mode

Enable debug logging for troubleshooting:

```bash
LOG_LEVEL=debug npm run worker
```

This shows:
- Full prompts sent to Claude
- Complete Claude responses
- Docker command details
- Timing information

### Container Inspection

Inspect running containers:

```bash
# List running containers
docker ps

# View logs
docker logs <container-id>

# Inspect container
docker inspect <container-id>
```

## Best Practices

1. **Authenticate properly** - Run `claude login` before deploying
2. **Mount correct paths** - Verify worktree and config paths
3. **Set appropriate timeouts** - Based on issue complexity
4. **Limit turns** - Prevent infinite loops
5. **Use network isolation** - Unless external APIs needed
6. **Monitor execution time** - Detect performance issues
7. **Review prompts** - Ensure clear, focused instructions
8. **Test with both models** - Understand cost/performance tradeoffs
9. **Handle errors gracefully** - Provide useful feedback
10. **Clean up containers** - Use `--rm` flag for automatic cleanup

## Troubleshooting

### Authentication Issues

```
Error: Not authenticated with Claude
```

**Solution**: Run `claude login` and verify the configured Claude directory, usually `~/.claude`, exists and is mounted into the worker.

### Docker Permission Issues

```
Error: Permission denied
```

**Solution**: Add user to docker group:
```bash
sudo usermod -aG docker $USER
```

### Network Issues

```
Error: Could not connect to Claude API
```

**Solution**: Enable network if needed:
```javascript
network: 'bridge'
```

### Timeout Issues

```
Error: Claude execution timed out
```

**Solution**: Increase timeout or reduce issue complexity:
```bash
CLAUDE_TIMEOUT_MS=600000
```

---
sidebar_position: 2
---

# Features

ProPR provides a comprehensive set of features for automated issue processing with AI-powered solutions.

## Complete End-to-End Automation

### Issue Detection
Automatic monitoring of GitHub repositories for AI-eligible issues with configurable polling intervals.

### Multiple Primary Labels
Support for multiple trigger labels (e.g., 'AI', 'propr') with dynamic state label generation. Each label triggers its own processing workflow with dedicated state tracking.

### Model-Specific Processing
Support for multiple Claude models (Sonnet, Opus) with dedicated job queues. Issues can be processed by one or multiple models simultaneously.

### Deterministic Git Workflow
Reliable 3-phase workflow that separates AI implementation from git operations:
1. Pre-Claude setup phase
2. AI implementation phase
3. Post-Claude finalization phase

### Automatic PR Creation
Direct GitHub API integration with proper issue linking using keywords like `Closes #123` or `Addresses #123`.

### Quality Assurance
Comprehensive validation and retry mechanisms ensure reliable operation even in edge cases.

## Advanced Multi-Model Support

### Model-Specific Enqueueing
Separate job queues for different Claude models based on issue labels (`llm-claude-sonnet`, `llm-claude-opus`).

### Concurrent Processing
Multiple workers can process different models simultaneously without conflicts.

### Model-Specific Branch Naming
Unique branch names include model identifier for traceability:
```
ai-fix/{issueId}-{title}-{timestamp}-{model}-{random}
```

### Model Selection
Automatic model detection from issue labels with support for multi-model processing on the same issue.

## PR Slash Commands

### AI Code Review (`/review`)
Request AI code reviews directly from PR comments. Each requested model posts its own review comment without modifying code. Supports model selection and multiline focus instructions.

### Automated Fixes (`/fix`)
Gathers unprocessed AI review comments and applies suggested changes in a single pass. Users can edit or delete review comments before running `/fix` to control which suggestions are implemented.

### Base Branch Merge (`/merge`)
Merges the target base branch into the PR branch with automatic conflict resolution.

### Model Switch (`/switch`)
Permanently changes the AI model for the PR by updating its labels. All subsequent commands use the new model. Supports optional follow-up instructions.

### One-Time Model Override (`/use`)
Overrides the AI model for a single follow-up run without changing the PR's labels. Useful for getting a second opinion from a different model.

### Expandable Command Reference
Every PR created or completed by ProPR includes a collapsible slash command reference table, making commands easily discoverable without leaving the PR.

See the [PR Slash Commands](./pr-commands.md) documentation for full usage details and examples.

## Robust Git Management

### Isolated Worktrees
Each issue is processed in a separate git worktree for complete conflict prevention. Multiple issues can be processed simultaneously without interference.

### Repository-Specific Configuration
Support for different default branches per repository. Configure custom branches using environment variables:
```bash
GIT_DEFAULT_BRANCH_owner_repo=development
```

### Authentication Handling
Seamless private repository access with token-based authentication through GitHub App integration.

### Branch Management
Automatic creation, pushing, and cleanup of feature branches with descriptive naming conventions.

## Intelligent Claude Integration

### Implementation-Focused Prompts
Claude receives focused prompts that emphasize code implementation while git operations are handled externally.

### Context-Aware Processing
Reads both issue descriptions and all comments to ensure complete context for problem-solving.

### Docker Isolation
Secure containerized execution environment with network restrictions for safe code execution.

### Output Parsing
Intelligent extraction of implementation details and commit messages from Claude's responses.

## Production-Ready Reliability

### Deterministic 3-Phase Workflow
- **Phase 1 (Pre-Claude)**: Repository setup, branch creation, initial push
- **Phase 2 (AI)**: Claude analyzes and implements solution
- **Phase 3 (Post-Claude)**: Commit changes, push, create PR

### Error Recovery
Comprehensive retry mechanisms with exponential backoff for:
- GitHub API operations
- Git operations
- Network requests

### GitHub API Integration
Direct API calls with proper timing and error handling. Eliminates race conditions through pre-branch creation.

### State Management
Redis-based job state tracking with correlation IDs for debugging and monitoring.

## Dynamic Label System

### Multiple Primary Labels
Configure multiple labels to trigger processing:
```bash
PRIMARY_PROCESSING_LABELS=AI,propr,automation
```

### Automatic State Labels
State labels are dynamically generated based on the triggering label:
- Issue with 'AI' label → Uses 'AI-processing', 'AI-done', 'AI-failed-*'
- Issue with 'propr' label → Uses 'propr-processing', 'propr-done', 'propr-failed-*'

### Correct Label Attribution
Each issue is tracked with labels specific to its trigger, avoiding conflicts in multi-label scenarios.

### Flexible Configuration
Add or remove primary labels via environment variables or UI without code changes.

## Prerequisites

To use ProPR, you'll need:

- **Node.js 18+** - Runtime environment
- **GitHub App** - With appropriate permissions
- **Claude Subscription** - Anthropic Claude account with API access
- **Redis Server** - For task queue management (v6.0+ recommended)
- **Git 2.25+** - For worktree support
- **Docker** - For secure Claude Code execution
- **Disk Space** - Minimum 10GB recommended for repository operations

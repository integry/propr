---
sidebar_position: 5
---

# Git Management

The git management system (`src/git/repoManager.js`) handles repository operations, worktree management, and branch handling.

## Overview

GitFix uses advanced git features to enable safe, concurrent processing of multiple issues:

- **Repository cloning** with authentication
- **Worktree isolation** for conflict-free processing
- **Branch management** with unique naming
- **Repository-specific configuration** for default branches

## Repository Manager

The `repoManager.js` module provides a comprehensive API for git operations.

### Core Responsibilities

1. Clone and update repositories
2. Create and manage worktrees
3. Generate and push branches
4. Handle authentication
5. Clean up resources

## Repository Cloning

### Initial Clone

When a repository is first encountered:

```javascript
await repoManager.cloneRepository({
  owner: 'integry',
  repo: 'gitfix',
  targetPath: '/tmp/git-processor/clones/integry-gitfix'
});
```

This creates a bare clone with all branches.

### Authentication

For private repositories, authentication is handled automatically using the GitHub App token:

```bash
git clone https://x-access-token:${token}@github.com/owner/repo.git
```

### Shallow Cloning

For large repositories, use shallow clones:

```bash
GIT_SHALLOW_CLONE_DEPTH=50
```

This limits history and speeds up cloning:

```bash
git clone --depth 50 <url>
```

### Repository Updates

Before creating worktrees, update the repository:

```javascript
await repoManager.updateRepository(repoPath);
```

This runs:

```bash
git fetch --all --prune
```

Updates all branches and removes deleted remote branches.

## Worktree Management

### What are Worktrees?

Git worktrees allow multiple working directories from a single repository:
- Each worktree has independent working files
- All worktrees share the same git database
- Changes in one worktree don't affect others

### Benefits for GitFix

1. **Isolation**: Multiple issues processed simultaneously without conflicts
2. **Efficiency**: Shared git database saves disk space
3. **Safety**: No risk of branch confusion or accidental commits
4. **Performance**: Faster than full clones for each job

### Worktree Creation

Create an isolated worktree for an issue:

```javascript
const worktreePath = await repoManager.createWorktree({
  repoPath: '/tmp/git-processor/clones/integry-gitfix',
  branchName: 'ai-fix/123-implement-feature-sonnet-3he',
  baseBranch: 'main'
});
```

This:
1. Creates a new branch from `baseBranch`
2. Creates a worktree at `/tmp/git-processor/worktrees/unique-id`
3. Checks out the new branch in the worktree
4. Returns the worktree path

### Worktree Paths

Worktrees are created with unique paths:

```
/tmp/git-processor/worktrees/integry-gitfix-123-sonnet-1234567890
```

Format: `{owner}-{repo}-{issueNumber}-{model}-{timestamp}`

### Worktree Cleanup

After processing, remove worktrees:

```javascript
await repoManager.removeWorktree(worktreePath);
```

This:
1. Removes the worktree directory
2. Cleans up git worktree references
3. Frees disk space

## Branch Management

### Branch Naming Convention

Branches use a descriptive, unique naming pattern:

```
ai-fix/{issueId}-{title}-{timestamp}-{model}-{random}
```

**Example:**
```
ai-fix/349-feat-implement-onboarding-20250529-1506-sonnet-3he
```

**Components:**
- `ai-fix/` - Prefix for all AI-generated branches
- `349` - Issue number
- `feat-implement-onboarding` - Sanitized issue title
- `20250529-1506` - Timestamp (YYYYMMDD-HHMM)
- `sonnet` - Model identifier
- `3he` - Random 3-character suffix for uniqueness

### Branch Generation

```javascript
const branchName = generateBranchName({
  issueId: 349,
  title: 'Feature: Implement onboarding flow',
  model: 'claude-sonnet-4-5-20250929',
  timestamp: 1748531160000
});
```

### Title Sanitization

Issue titles are sanitized for branch names:
- Convert to lowercase
- Replace spaces with hyphens
- Remove special characters
- Truncate to reasonable length
- Prefix with issue type if detected (feat, fix, docs, etc.)

### Branch Pushing

Branches are pushed to GitHub in Phase 1:

```javascript
await repoManager.pushBranch({
  worktreePath: worktreePath,
  branchName: branchName,
  remote: 'origin'
});
```

This establishes the branch on GitHub before Claude runs, preventing timing issues with PR creation.

## Repository-Specific Configuration

### Default Branch Configuration

Different repositories may use different default branches:

```bash
# Global default
GIT_DEFAULT_BRANCH=main

# Repository-specific override
GIT_DEFAULT_BRANCH_integry_gitfix=develop
GIT_DEFAULT_BRANCH_integry_other=master
```

### Configuration Resolution

The system resolves default branches in this order:

1. Repository-specific environment variable
2. Global default from `GIT_DEFAULT_BRANCH`
3. Fallback to 'main'

### Format

Repository-specific variables use underscores:

```bash
GIT_DEFAULT_BRANCH_{owner}_{repo}=branch_name
```

**Example:**
```bash
GIT_DEFAULT_BRANCH_facebook_react=main
GIT_DEFAULT_BRANCH_vercel_next=canary
```

## Authentication

### GitHub App Authentication

GitFix uses GitHub App installation tokens:

```javascript
const token = await getInstallationToken();
```

Tokens are:
- Short-lived (1 hour)
- Automatically refreshed
- Scoped to installed repositories
- More secure than personal access tokens

### Git Credential Helper

For git operations, credentials are provided inline:

```bash
git clone https://x-access-token:${token}@github.com/owner/repo.git
```

This avoids:
- Credential storage on disk
- Credential helper configuration
- Security risks

### Private Repository Access

Private repositories work seamlessly with GitHub App authentication:
- App must be installed on the repository
- App must have Contents: Read & Write permission
- Token is automatically used for all git operations

## Error Handling

### Retry Logic

Git operations use retry with exponential backoff:

```javascript
await retryWithBackoff(
  () => gitOperation(),
  {
    maxRetries: 3,
    backoff: 'exponential',
    baseDelay: 1000
  }
);
```

### Common Errors

#### Clone Failures

```
Error: Repository not found or permission denied
```

**Causes:**
- Repository doesn't exist
- App not installed on repository
- Insufficient permissions

**Recovery:**
- Verify repository exists
- Check GitHub App installation
- Validate permissions

#### Worktree Failures

```
Error: Cannot create worktree
```

**Causes:**
- Base branch doesn't exist
- Insufficient disk space
- Permission issues

**Recovery:**
- Verify base branch
- Check disk space
- Validate filesystem permissions

#### Push Failures

```
Error: Failed to push branch
```

**Causes:**
- Network issues
- Authentication expired
- Branch protection rules
- Conflicts

**Recovery:**
- Retry with fresh token
- Check network connectivity
- Verify branch protection settings

## Configuration

### Environment Variables

```bash
# Git paths
GIT_CLONES_BASE_PATH=/tmp/git-processor/clones
GIT_WORKTREES_BASE_PATH=/tmp/git-processor/worktrees

# Default branch
GIT_DEFAULT_BRANCH=main

# Repository-specific branches
GIT_DEFAULT_BRANCH_integry_gitfix=develop

# Clone options
GIT_SHALLOW_CLONE_DEPTH=

# Retry configuration
GIT_OPERATION_MAX_RETRIES=3
```

### Directory Setup

Create required directories:

```bash
sudo mkdir -p /tmp/git-processor/{clones,worktrees}
sudo chown -R $(whoami) /tmp/git-processor
chmod 755 /tmp/git-processor
```

## Performance Optimization

### Repository Reuse

Repositories are cloned once and reused:
- Multiple worktrees from single clone
- Shared git object database
- Reduced network traffic
- Faster worktree creation

### Parallel Operations

Multiple worktrees can be created simultaneously:
- Independent worktree directories
- Shared git database
- No locking conflicts
- Maximum parallelism

### Disk Space Management

Monitor disk usage:
- Clones: ~100-500MB per repository
- Worktrees: Size of working directory per issue
- Shared objects: Deduplicated across worktrees

Clean up periodically:
```bash
# Remove old worktrees
find /tmp/git-processor/worktrees -mtime +7 -delete

# Remove unused clones
find /tmp/git-processor/clones -mtime +30 -delete
```

## Git Version Requirements

### Minimum Version

Git 2.25+ required for:
- Worktree improvements
- Better isolation
- Enhanced performance

### Recommended Version

Git 2.30+ recommended for:
- Additional worktree features
- Better error messages
- Performance improvements

### Version Check

Verify git installation:

```bash
git --version
git worktree --help
```

## Advanced Features

### Worktree Listing

List all worktrees:

```bash
git worktree list
```

Shows:
- Worktree paths
- Associated branches
- Current HEAD

### Worktree Repair

If worktree references become corrupted:

```bash
git worktree repair
```

Fixes:
- Broken symlinks
- Missing references
- Path issues

### Worktree Pruning

Remove stale worktree references:

```bash
git worktree prune
```

Cleans up:
- Deleted worktree directories
- Orphaned references
- Invalid entries

## Best Practices

1. **Clean up worktrees** after job completion
2. **Update repositories** before creating worktrees
3. **Use unique branch names** to prevent conflicts
4. **Monitor disk space** for clones and worktrees
5. **Validate authentication** before git operations
6. **Retry failed operations** with backoff
7. **Log all git operations** for debugging
8. **Use shallow clones** for large repositories
9. **Configure default branches** per repository
10. **Test git version** before deployment

## Troubleshooting

### Worktree Creation Fails

**Symptoms:**
```
fatal: 'branch-name' is already checked out at '/path/to/worktree'
```

**Solution:**
Remove the existing worktree or use a different branch name.

### Push Fails with Authentication Error

**Symptoms:**
```
remote: Permission denied
fatal: Authentication failed
```

**Solution:**
Refresh GitHub App installation token and retry.

### Disk Space Issues

**Symptoms:**
```
fatal: No space left on device
```

**Solution:**
Clean up old worktrees and clones, or increase disk space.

### Corrupted Worktree

**Symptoms:**
```
fatal: Unable to create worktree
```

**Solution:**
```bash
git worktree prune
git worktree repair
```

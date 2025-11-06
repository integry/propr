# Repository-Specific Default Branch Configuration

The GitFix system supports repository-specific default branch configuration through environment variables. This allows you to override the automatic branch detection for specific repositories.

## Configuration Format

Set environment variables using the pattern:
```bash
GIT_DEFAULT_BRANCH_<OWNER>_<REPO>=<branch_name>
```

Where:
- `<OWNER>` is the repository owner (converted to uppercase, special chars become underscores)
- `<REPO>` is the repository name (converted to uppercase, special chars become underscores)  
- `<branch_name>` is the desired default branch

## Examples

### Basic Configuration
```bash
# For repository integry/forex, use 'dev' as default branch
GIT_DEFAULT_BRANCH_INTEGRY_FOREX=dev

# For repository myorg/myrepo, use 'develop' as default branch  
GIT_DEFAULT_BRANCH_MYORG_MYREPO=develop
```

### Repositories with Special Characters
```bash
# For repository my-org/my-repo.com, use 'main' as default branch
GIT_DEFAULT_BRANCH_MY_ORG_MY_REPO_COM=main

# For repository user123/project-v2, use 'master' as default branch
GIT_DEFAULT_BRANCH_USER123_PROJECT_V2=master
```

### Multiple Repository Configuration
```bash
# Configure multiple repositories
GIT_DEFAULT_BRANCH_INTEGRY_FOREX=dev
GIT_DEFAULT_BRANCH_INTEGRY_SNAKE_GAME=main
GIT_DEFAULT_BRANCH_COMPANY_BACKEND_API=develop
GIT_DEFAULT_BRANCH_COMPANY_FRONTEND_APP=staging
```

## Priority Order

The system uses the following priority order for determining default branches:

1. **Repository-specific configuration** (highest priority) - `.env` file configuration
2. **GitHub API detection** - Uses repository metadata from GitHub
3. **Git remote HEAD detection** - Automatic detection from Git remote
4. **Git symbolic-ref detection** - Git's symbolic reference resolution  
5. **Common branch fallback** - Searches: [GIT_FALLBACK_BRANCH, main, master, develop, dev, trunk]
6. **Available branch fallback** - Uses any available remote branch

## Environment File Setup

Add these configurations to your `.env` file:

```bash
# Global fallback branch (optional)
GIT_FALLBACK_BRANCH=main

# Repository-specific configurations (optional)
GIT_DEFAULT_BRANCH_INTEGRY_FOREX=dev
GIT_DEFAULT_BRANCH_INTEGRY_BACKEND=develop
GIT_DEFAULT_BRANCH_MYORG_FRONTEND=staging

# Other GitFix configuration...
GITHUB_REPOS_TO_MONITOR=integry/forex,integry/backend,myorg/frontend
```

## Verification

You can verify your configuration by checking the logs when the system processes issues. Look for messages like:

```
[INFO] Using repository-specific default branch from environment configuration
  repo: "integry/forex"
  defaultBranch: "dev"
  configKey: "GIT_DEFAULT_BRANCH_INTEGRY_FOREX"
```

## Benefits

- **Fine-grained control**: Configure each repository individually
- **Override GitHub settings**: Use different branches than GitHub's default
- **Development workflow support**: Use development branches instead of main/master
- **Legacy repository support**: Handle repositories with non-standard branch names
- **Zero downtime changes**: Update configurations without restarting the system

## Troubleshooting

### Branch Not Found
If a configured branch doesn't exist in the repository, the system will:
1. Log a warning about the missing branch
2. Fall back to automatic detection methods
3. Continue processing with the detected branch

### Invalid Configuration
- Environment variable names are case-sensitive
- Special characters in owner/repo names are converted to underscores
- Branch names are used exactly as configured (case-sensitive)

### Debug Configuration
To see all configured repository branches, you can use the `listRepositoryBranchConfigurations()` function in the code or check the logs during startup.
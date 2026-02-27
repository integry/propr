---
sidebar_position: 1
---

# Introduction

Welcome to ProPR - an automated GitHub issue processor that leverages AI to solve problems in your repositories.

## What is ProPR?

ProPR is a production-ready automated system that monitors GitHub issues, uses Anthropic's Claude Code to generate solutions, and provides a complete end-to-end workflow from issue detection to pull request creation.

## Key Capabilities

- **Automatic Issue Detection**: Continuously monitors your GitHub repositories for issues labeled for AI processing
- **AI-Powered Solutions**: Uses Claude Code to analyze issues and implement solutions
- **Complete Automation**: From issue detection through code implementation to pull request creation
- **Multi-Model Support**: Process issues with different Claude models (Sonnet, Opus) simultaneously
- **Production-Ready**: Built with reliability, error recovery, and comprehensive validation

## How It Works

1. **Detection**: The daemon monitors configured repositories for issues with specific labels
2. **Queuing**: Eligible issues are added to a task queue for processing
3. **Processing**: Workers pull jobs from the queue and execute a 3-phase workflow:
   - Pre-Claude setup (git operations, branch creation)
   - AI implementation (Claude analyzes and implements solutions)
   - Post-Claude finalization (commit, push, PR creation)
4. **Completion**: Pull requests are automatically created and linked to the original issues

## Quick Start

Ready to get started? Check out our [Setup Guide](./getting-started/setup.md) to configure ProPR for your repositories.

## Documentation Structure

- **[Features](./features.md)**: Complete feature overview
- **Getting Started**: Setup and usage guides
- **Architecture**: Deep dive into system components and design

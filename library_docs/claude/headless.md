## 

[​

](#overview)

Overview

The headless mode allows you to run Claude Code programmatically from command line scripts and automation tools without any interactive UI.

## 

[​

](#basic-usage)

Basic usage

The primary command-line interface to Claude Code is the `claude` command. Use the `--print` (or `-p`) flag to run in non-interactive mode and print the final result:

Copy

Ask AI

```
claude -p "Stage my changes and write a set of commits for them" \
  --allowedTools "Bash,Read" \
  --permission-mode acceptEdits
```

## 

[​

](#configuration-options)

Configuration Options

Headless mode leverages all the CLI options available in Claude Code. Here are the key ones for automation and scripting:

Flag

Description

Example

`--print`, `-p`

Run in non-interactive mode

`claude -p "query"`

`--output-format`

Specify output format (`text`, `json`, `stream-json`)

`claude -p --output-format json`

`--resume`, `-r`

Resume a conversation by session ID

`claude --resume abc123`

`--continue`, `-c`

Continue the most recent conversation

`claude --continue`

`--verbose`

Enable verbose logging

`claude --verbose`

`--append-system-prompt`

Append to system prompt (only with `--print`)

`claude --append-system-prompt "Custom instruction"`

`--allowedTools`

Space-separated list of allowed tools, or  
  
string of comma-separated list of allowed tools

`claude --allowedTools mcp__slack mcp__filesystem`  
  
`claude --allowedTools "Bash(npm install),mcp__filesystem"`

`--disallowedTools`

Space-separated list of denied tools, or  
  
string of comma-separated list of denied tools

`claude --disallowedTools mcp__splunk mcp__github`  
  
`claude --disallowedTools "Bash(git commit),mcp__github"`

`--mcp-config`

Load MCP servers from a JSON file

`claude --mcp-config servers.json`

`--permission-prompt-tool`

MCP tool for handling permission prompts (only with `--print`)

`claude --permission-prompt-tool mcp__auth__prompt`

For a complete list of CLI options and features, see the [CLI reference](/docs/en/cli-reference) documentation.

## 

[​

](#multi-turn-conversations)

Multi-turn conversations

For multi-turn conversations, you can resume conversations or continue from the most recent session:

Copy

Ask AI

```
# Continue the most recent conversation
claude --continue "Now refactor this for better performance"

# Resume a specific conversation by session ID
claude --resume 550e8400-e29b-41d4-a716-446655440000 "Update the tests"

# Resume in non-interactive mode
claude --resume 550e8400-e29b-41d4-a716-446655440000 "Fix all linting issues" --no-interactive
```

## 

[​

](#output-formats)

Output Formats

### 

[​

](#text-output-default)

Text Output (Default)

Copy

Ask AI

```
claude -p "Explain file src/components/Header.tsx"
# Output: This is a React component showing...
```

### 

[​

](#json-output)

JSON Output

Returns structured data including metadata:

Copy

Ask AI

```
claude -p "How does the data layer work?" --output-format json
```

Response format:

Copy

Ask AI

```
{
  "type": "result",
  "subtype": "success",
  "total_cost_usd": 0.003,
  "is_error": false,
  "duration_ms": 1234,
  "duration_api_ms": 800,
  "num_turns": 6,
  "result": "The response text here...",
  "session_id": "abc123"
}
```

### 

[​

](#streaming-json-output)

Streaming JSON Output

Streams each message as it is received:

Copy

Ask AI

```
claude -p "Build an application" --output-format stream-json
```

Each conversation begins with an initial `init` system message, followed by a list of user and assistant messages, followed by a final `result` system message with stats. Each message is emitted as a separate JSON object.

## 

[​

](#input-formats)

Input Formats

### 

[​

](#text-input-default)

Text Input (Default)

Copy

Ask AI

```
# Direct argument
claude -p "Explain this code"

# From stdin
echo "Explain this code" | claude -p
```

### 

[​

](#streaming-json-input)

Streaming JSON Input

A stream of messages provided via `stdin` where each message represents a user turn. This allows multiple turns of a conversation without re-launching the `claude` binary and allows providing guidance to the model while it is processing a request. Each message is a JSON ‘User message’ object, following the same format as the output message schema. Messages are formatted using the [`jsonl`](https://jsonlines.org/) format where each line of input is a complete JSON object. Streaming JSON input requires `-p` and `--output-format stream-json`.

Copy

Ask AI

```
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Explain this code"}]}}' | claude -p --output-format=stream-json --input-format=stream-json --verbose
```

## 

[​

](#agent-integration-examples)

Agent Integration Examples

### 

[​

](#sre-incident-response-bot)

SRE Incident Response Bot

Copy

Ask AI

```
#!/bin/bash

# Automated incident response agent
investigate_incident() {
    local incident_description="$1"
    local severity="${2:-medium}"

    claude -p "Incident: $incident_description (Severity: $severity)" \
      --append-system-prompt "You are an SRE expert. Diagnose the issue, assess impact, and provide immediate action items." \
      --output-format json \
      --allowedTools "Bash,Read,WebSearch,mcp__datadog" \
      --mcp-config monitoring-tools.json
}

# Usage
investigate_incident "Payment API returning 500 errors" "high"
```

### 

[​

](#automated-security-review)

Automated Security Review

Copy

Ask AI

```
# Security audit agent for pull requests
audit_pr() {
    local pr_number="$1"

    gh pr diff "$pr_number" | claude -p \
      --append-system-prompt "You are a security engineer. Review this PR for vulnerabilities, insecure patterns, and compliance issues." \
      --output-format json \
      --allowedTools "Read,Grep,WebSearch"
}

# Usage and save to file
audit_pr 123 > security-report.json
```

### 

[​

](#multi-turn-legal-assistant)

Multi-turn Legal Assistant

Copy

Ask AI

```
# Legal document review with session persistence
session_id=$(claude -p "Start legal review session" --output-format json | jq -r '.session_id')

# Review contract in multiple steps
claude -p --resume "$session_id" "Review contract.pdf for liability clauses"
claude -p --resume "$session_id" "Check compliance with GDPR requirements"
claude -p --resume "$session_id" "Generate executive summary of risks"
```

## 

[​

](#best-practices)

Best Practices

*   **Use JSON output format** for programmatic parsing of responses:
    
    Copy
    
    Ask AI
    
    ```
    # Parse JSON response with jq
    result=$(claude -p "Generate code" --output-format json)
    code=$(echo "$result" | jq -r '.result')
    cost=$(echo "$result" | jq -r '.cost_usd')
    ```
    
*   **Handle errors gracefully** - check exit codes and stderr:
    
    Copy
    
    Ask AI
    
    ```
    if ! claude -p "$prompt" 2>error.log; then
        echo "Error occurred:" >&2
        cat error.log >&2
        exit 1
    fi
    ```
    
*   **Use session management** for maintaining context in multi-turn conversations
*   **Consider timeouts** for long-running operations:
    
    Copy
    
    Ask AI
    
    ```
    timeout 300 claude -p "$complex_prompt" || echo "Timed out after 5 minutes"
    ```
    
*   **Respect rate limits** when making multiple requests by adding delays between calls

## 

[​

](#related-resources)

Related Resources

*   [CLI usage and controls](/docs/en/cli-reference) - Complete CLI documentation
*   [Common workflows](/docs/en/common-workflows) - Step-by-step guides for common use cases

Was this page helpful?

YesNo

[Hooks](/docs/en/hooks-guide)[Model Context Protocol (MCP)](/docs/en/mcp)

⌘I
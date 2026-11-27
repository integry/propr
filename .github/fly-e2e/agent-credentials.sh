# Source this file. The smoke configures each agent the way an operator does: one file of the
# agent configuration's credential store, carried in FLY_E2E_APP_ENV as single-line base64 and
# installed into the agent's managed credential directory on the volume (see setup-fly.md).
#
#   claude    CLAUDE_SETTINGS_B64   settings.json  (an `env` object with ANTHROPIC_API_KEY)
#   codex     CODEX_AUTH_B64        auth.json      (Codex's login, e.g. {"OPENAI_API_KEY": "..."})
#   vibe      VIBE_ENV_B64          .env           (MISTRAL_API_KEY=...)
#   opencode  OPENCODE_CONFIG_B64   opencode.json  (a provider with options.apiKey; set "model" too)
#
# The run's agent and model come from the input; PROPR_E2E_<AGENT>_MODEL in the env file overrides
# the agent's default model (OpenCode's must name the configured provider, e.g. openrouter/...).

agent_credential_key() {
  case $1 in
    claude) echo CLAUDE_SETTINGS_B64 ;;
    codex) echo CODEX_AUTH_B64 ;;
    vibe) echo VIBE_ENV_B64 ;;
    opencode) echo OPENCODE_CONFIG_B64 ;;
    *) return 1 ;;
  esac
}

agent_credential_file() {
  case $1 in
    claude) echo settings.json ;;
    codex) echo auth.json ;;
    vibe) echo .env ;;
    opencode) echo opencode.json ;;
    *) return 1 ;;
  esac
}

# Prints each credential value (12+ characters) in the decoded file $1, one per line: JSON string
# values under key-, token-, secret- or password-like names, and dotenv values. These are what
# must never appear in the worker log or an image.
agent_credential_values() {
  local file=$1
  if jq -e . "$file" > /dev/null 2>&1; then
    jq -r '.. | objects | to_entries[]
      | select(.key | test("(key|token|secret|password|access|refresh)$"; "i"))
      | .value | strings | select(length >= 12)' "$file"
  else
    sed -nE 's/^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=//p' "$file" |
      sed -E "s/^[\"'](.*)[\"']\$/\\1/" | awk 'length >= 12'
  fi | sort -u
}

#!/bin/sh
set -eu

# Regenerate the runtime config served to the browser from the environment so a
# single prebuilt image can point at any per-instance proxy URL. This runs at
# container start, before the static server, overwriting the empty default in
# public/config.js. PROPR_UI_PUBLIC_API_URL is used for both REST and Socket.IO;
# an empty/unset value keeps same-origin behavior.
API_BASE_URL="${PROPR_UI_PUBLIC_API_URL:-}"

# JSON-escape the value so an arbitrary/malformed URL can't break out of the
# string literal (or inject script into the served config.js). Order matters:
# backslashes first, then double quotes, then control characters that would
# otherwise terminate the line or the heredoc — carriage return, then newline
# (the gsub over the whole buffer must run last).
ESCAPED_API_BASE_URL=$(printf '%s' "$API_BASE_URL" \
  | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\r/\\r/g' \
  | sed -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g')

cat > /app/dist/config.js <<EOF
window.__PROPR_CONFIG__ = {
  apiBaseUrl: "${ESCAPED_API_BASE_URL}"
};
EOF

exec "$@"

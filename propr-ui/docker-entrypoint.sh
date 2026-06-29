#!/bin/sh
set -eu

# Regenerate the runtime config served to the browser from the environment so a
# single prebuilt image can point at any per-instance proxy URL. This runs at
# container start, before the static server, overwriting the empty default in
# public/config.js. PROPR_UI_PUBLIC_API_URL is used for both REST and Socket.IO;
# an empty/unset value keeps same-origin behavior.
#
# config.js MUST stay a real file in dist/ so the static server (serve.json)
# returns it directly and the SPA `"**" -> /index.html` rewrite never catches it
# — serve-handler serves existing files before applying rewrites. If a future
# serve.json change ever routes /config.js to index.html, window.__PROPR_CONFIG__
# would silently never load and the hosted UI would fall back to same-origin.
#
# Generate config.js with Node's JSON serializer rather than hand-rolled shell
# escaping. JSON.stringify safely handles every string hazard (quotes,
# backslashes, control characters, NUL) for an arbitrary env value. The two
# exceptions are U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR): they
# are valid in JSON but terminate a line inside a JS string literal, so we escape
# them explicitly afterward. The value is read from the environment (not argv) so
# it is never word-split or re-interpreted by the shell.
PROPR_UI_PUBLIC_API_URL="${PROPR_UI_PUBLIC_API_URL:-}" node <<'NODE' > /app/dist/config.js
const apiBaseUrl = process.env.PROPR_UI_PUBLIC_API_URL || '';
const json = JSON.stringify({ apiBaseUrl }).replace(
  /[\u2028\u2029]/g,
  (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
);
process.stdout.write(`window.__PROPR_CONFIG__ = ${json};\n`);
NODE

exec "$@"

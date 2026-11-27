# Source this file; it defines mask_fly_token. Never source an env file that holds a token.
#
# A Fly token is "FlyV1 fm2_…[,fm2_…]": a scheme, a space, and comma-separated macaroons.
# ::add-mask:: only hides an exact match, so mask the whole token, the body after the scheme
# and every space- or comma-separated part. Then a fragment quoted in an error stays hidden.
mask_fly_token() {
  local token=$1 part
  local -a parts
  [[ -n $token ]] || return 0
  echo "::add-mask::$token"
  [[ $token != *' '* ]] || echo "::add-mask::${token#* }"
  IFS=$' ,\t' read -ra parts <<< "$token"
  for part in "${parts[@]}"; do
    [[ -z $part ]] || echo "::add-mask::$part"
  done
}

# Filter for step output: redacts any fm2_ fragment that masking missed, then fails the step
# if one appeared. Use as `cmd 2>&1 | redact_fly_tokens` under `set -o pipefail`.
redact_fly_tokens() {
  awk '{ if (gsub(/fm2_[^[:space:]"'"'"']*/, "[redacted Fly token]")) leaked++; print; fflush() }
    END { if (leaked) { print "::error::" leaked " output line(s) held a Fly token fragment (redacted above)"; exit 3 } }'
}

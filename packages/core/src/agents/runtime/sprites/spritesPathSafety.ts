/**
 * Root scripts on a Sprite act on paths the agent user can reach (log and
 * scratch directories, credential targets, the workspace). See
 * `SPRITES_LAUNCHER_SCRIPT` in `spritesCommand.ts`.
 */

/**
 * `secure_path <absolute path>`, for the root scripts that create, own, install
 * or remove a path the agent user can reach: with the checkpoint restore
 * disabled, what a run left (a log directory replaced by a symlink to
 * `/opt/propr/bin`, say) is still there for the next run, and `mkdir -p`,
 * `chown`, `install` and `rm -rf` follow a symlink on the path. It removes
 * whatever the agent could have planted on the path below its top-level
 * directory (which it cannot replace in root-owned `/`): the first component
 * that is a symlink, or a non-directory where a directory belongs, goes, and
 * with it everything that was reached through it. Afterwards every existing
 * directory above the path is a real one and the path itself is no symlink.
 * That holds while root acts on it only because no process of the agent user
 * is left to plant another (the launcher kills them all first, and cleanup
 * runs once the run was verifiably stopped). Status 1 for a path that is not
 * absolute and plain (no empty, `.` or `..` component), or whose top-level
 * directory is not a real directory.
 */
export const SPRITES_SECURE_PATH_FUNCTION = `
secure_path() {
    local current="" index last
    local -a parts
    case "$1" in /*/*) ;; *) return 1 ;; esac
    case "$1" in */|*$'\\n'*) return 1 ;; esac
    IFS=/ read -r -a parts <<< "\${1#/}"
    last=$((\${#parts[@]} - 1))
    for index in "\${!parts[@]}"; do
        case "\${parts[$index]}" in ''|.|..) return 1 ;; esac
        current="$current/\${parts[$index]}"
        if [ "$index" = 0 ]; then
            { [ -d "$current" ] && [ ! -L "$current" ]; } || return 1
        elif [ -L "$current" ] || { [ "$index" -lt "$last" ] && [ -e "$current" ] && [ ! -d "$current" ]; }; then
            rm -f -- "$current" || return 1
            return 0
        elif [ ! -e "$current" ]; then
            return 0
        fi
    done
}
`.trim();

/** Removes the given paths as root, never through a symlink the run planted: `bash -c <script> propr-scrub <path>...`. */
export const SPRITES_SCRUB_SCRIPT = `
${SPRITES_SECURE_PATH_FUNCTION}
status=0
for target in "$@"; do { secure_path "$target" && rm -rf -- "$target"; } || { echo "cannot remove $target" >&2; status=1; }; done
exit "$status"
`.trim();

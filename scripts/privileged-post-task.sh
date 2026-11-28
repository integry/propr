# shellcheck shell=bash
# Shared rules for the privileged steps an agent entrypoint runs after the
# unprivileged task returns. Installed root-owned at
# /opt/propr/privileged-post-task.sh next to task-file-transfer.py; entrypoints
# source it by that absolute path while still root and before the task starts.
#
# The task runs as node and can change everything node owns: /home/node
# (including /home/node/bin and /home/node/.local/bin, which lead PATH), the
# runtime homes, the workspace and its /tmp files. Background processes it
# started may even still be running. So every step after the task returns
# that keeps the entrypoint's privileges must:
#   - run through run_privileged_post_task: a subshell with PATH fixed to
#     /usr/sbin:/usr/bin:/sbin:/bin, an emptied exported environment (only
#     the NAME=VALUE pairs the step passes are exported), / as its working
#     directory and umask 077;
#   - name every binary by absolute path (/bin/rm, /usr/bin/python3, ...);
#   - never source or execute anything from a task-writable location;
#   - treat task files as data: copy them back only with
#     propr_copy_task_file_back, which reads them as node (O_NOFOLLOW, regular
#     single-link files, size-limited) and writes them with the entrypoint's
#     privileges through fd-relative, symlink-refusing operations.
# Steps that run as node (propr_as_node, or the propr_node_exec prefix) need no
# further care: node can only do what the task already could.
#
# The entrypoint script itself must not be writable by node either: bash reads
# a script as it executes it, so the image installs entrypoints root-owned.

propr_post_task_lib_dir="${BASH_SOURCE[0]%/*}"
propr_task_file_transfer="$propr_post_task_lib_dir/task-file-transfer.py"
readonly propr_post_task_lib_dir propr_task_file_transfer

# The command prefix that drops to node, or nothing when already unprivileged.
# Fixed now, while the environment is still the launcher's.
if [ "$EUID" = "0" ]; then
    propr_node_exec=(/usr/local/bin/su-exec node)
else
    propr_node_exec=()
fi
readonly propr_node_exec

# run_privileged_post_task [NAME=VALUE ...] [--] COMMAND [ARG ...]
# COMMAND may be a shell function defined by the entrypoint; it still sees the
# entrypoint's shell variables, but no child process inherits them.
run_privileged_post_task() {
    (
        local name
        for name in $(compgen -e); do
            export -n "$name" 2>/dev/null || true
        done
        unset -v BASH_ENV ENV CDPATH GLOBIGNORE BASH_XTRACEFD PROMPT_COMMAND 2>/dev/null || true
        IFS=$' \t\n'
        PATH=/usr/sbin:/usr/bin:/sbin:/bin
        export PATH
        export LC_ALL=C
        hash -r
        umask 077
        cd / || exit 1
        unset -v OLDPWD
        while [ $# -gt 0 ]; do
            case "$1" in
                --) shift; break ;;
                [A-Za-z_]*=*) export "${1?}"; shift ;;
                *) break ;;
            esac
        done
        "$@"
    )
}

# propr_as_node COMMAND [ARG ...]: COMMAND must be an absolute path.
propr_as_node() {
    "${propr_node_exec[@]}" "$@"
}

# propr_copy_task_file_back SOURCE_ROOT SOURCE_RELPATH DEST_ROOT DEST_RELPATH MAX_BYTES MODE [--parents] [--force-mode]
# SOURCE_RELPATH may instead be match:SUFFIX for the first file under
# SOURCE_ROOT whose path ends in /SUFFIX. Returns 0 when copied, 3 when there
# is no source file, and 2 (after a diagnostic on stderr) otherwise. Call it
# through run_privileged_post_task.
propr_copy_task_file_back() {
    local source_root="$1" source_path="$2" dest_root="$3" dest_path="$4" max_bytes="$5" mode="$6"
    shift 6
    local read_action=read
    if [ "${source_path#match:}" != "$source_path" ]; then
        read_action=read-match
        source_path="${source_path#match:}"
    fi
    local statuses
    propr_as_node /usr/bin/python3 -I "$propr_task_file_transfer" "$read_action" "$source_root" "$source_path" "$max_bytes" \
        | /usr/bin/python3 -I "$propr_task_file_transfer" write "$dest_root" "$dest_path" "$max_bytes" "$mode" "$@"
    statuses=("${PIPESTATUS[@]}")
    if [ "${statuses[0]}" = "3" ] && [ "${statuses[1]}" = "3" ]; then
        return 3
    fi
    if [ "${statuses[0]}" != "0" ] || [ "${statuses[1]}" != "0" ]; then
        return 2
    fi
    return 0
}

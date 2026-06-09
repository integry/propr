#!/opt/uv/tools/mistral-vibe/bin/python
from __future__ import annotations

import os
from pathlib import Path
import sys

from rich import print as rprint

from vibe.cli.entrypoint import parse_arguments
from vibe.core.config.harness_files import init_harness_files_manager
from vibe.core.trusted_folders import trusted_folders_manager


def main() -> None:
    prompt_file = os.environ.get("PROPR_VIBE_PROMPT_FILE")
    if not prompt_file:
        print("PROPR_VIBE_PROMPT_FILE is required", file=sys.stderr)
        sys.exit(2)

    try:
        prompt = Path(prompt_file).read_text(encoding="utf-8")
    except OSError as exc:
        print(f"Failed to read prompt file {prompt_file}: {exc}", file=sys.stderr)
        sys.exit(2)

    args = parse_arguments()
    args.prompt = prompt
    args.initial_prompt = None

    if args.workdir:
        workdir = args.workdir.expanduser().resolve()
        if not workdir.is_dir():
            rprint(f"[red]Error: --workdir does not exist or is not a directory: {workdir}[/]")
            sys.exit(1)
        os.chdir(workdir)

    try:
        cwd = Path.cwd()
    except FileNotFoundError:
        rprint(
            "[red]Error: Current working directory no longer exists.[/]\n"
            "[yellow]The directory you started vibe from has been deleted. "
            "Please change to an existing directory and try again, "
            "or use --workdir to specify a working directory.[/]"
        )
        sys.exit(1)

    if args.trust:
        trusted_folders_manager.trust_for_session(cwd)

    additional_dirs: list[Path] = []
    for directory in args.add_dir:
        resolved = Path(directory).expanduser().resolve()
        if not resolved.is_dir():
            rprint(
                f"[red]Error: --add-dir path does not exist "
                f"or is not a directory: {directory}[/]"
            )
            sys.exit(1)
        additional_dirs.append(resolved)
        trusted_folders_manager.trust_for_session(resolved)

    init_harness_files_manager("user", "project", additional_dirs=additional_dirs)

    from vibe.cli.cli import run_cli

    run_cli(args)


if __name__ == "__main__":
    main()

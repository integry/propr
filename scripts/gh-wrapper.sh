#!/bin/bash
# Wrapper script for GitHub CLI that filters out proprio bot comments
# This script intercepts `gh issue view --comments` commands and removes operational bot comments

# Check if this is an issue view command with comments
if [[ "$1" == "issue" && "$2" == "view" && "${@}" == *"--comments"* ]]; then
    # Extract issue number from arguments
    issue_number=""
    for arg in "${@:3}"; do
        if [[ "$arg" =~ ^[0-9]+$ ]]; then
            issue_number="$arg"
            break
        fi
    done
    
    # Run the original gh command and filter output
    if [ -n "$issue_number" ]; then
        # Execute gh command and capture output
        output=$(gh "$@" 2>&1)
        exit_code=$?
        
        if [ $exit_code -eq 0 ]; then
            # Filter out proprio bot comments
            # The gh output format shows comments with author names
            # We'll remove entire comment blocks from proprio bot
            echo "$output" | awk '
                BEGIN { print_line = 1; in_proprio_comment = 0 }

                # Detect start of a proprio comment
                /^[[:space:]]*proprio[[:space:]]+commented/ {
                    in_proprio_comment = 1
                    print_line = 0
                    next
                }

                # Detect start of any new comment (ends proprio comment block)
                /^[[:space:]]*[^[:space:]]+[[:space:]]+commented/ {
                    if (in_proprio_comment) {
                        in_proprio_comment = 0
                        print_line = 1
                    }
                }

                # Print lines that are not part of proprio comments
                {
                    if (print_line && !in_proprio_comment) {
                        print
                    }
                }
            '
            exit 0
        else
            # If gh command failed, output error as-is
            echo "$output"
            exit $exit_code
        fi
    else
        # No issue number found, run command as-is
        exec gh "$@"
    fi
else
    # Not an issue view command with comments, run as-is
    exec gh "$@"
fi
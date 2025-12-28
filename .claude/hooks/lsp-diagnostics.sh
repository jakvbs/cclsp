#!/bin/bash
# LSP Diagnostics Hook for Claude Code
# Uses mcporter to call cclsp's get_diagnostics tool after file edits
# Exit code 2 blocks the tool and feeds errors back to Claude
#
# Setup:
# 1. Ensure mcporter is available (pnpm add -g mcporter or use local)
# 2. Configure cclsp in mcporter config or set CCLSP_CONFIG_PATH
# 3. Add this hook to .claude/settings.json PostToolUse
#
# Environment variables:
# - CCLSP_CONFIG_PATH: Path to cclsp.json config (auto-detected from project if not set)
# - MCPORTER_DIR: Path to mcporter installation (default: ~/repos/mcporter)

set -euo pipefail

# Configuration
MCPORTER_DIR="${MCPORTER_DIR:-$HOME/repos/mcporter}"

# Read hook input from stdin
INPUT=$(cat)

# Extract file_path from tool_input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [[ -z "$FILE_PATH" ]]; then
  exit 0  # No file path, skip
fi

# Only check supported file types (matching cclsp server extensions)
EXT="${FILE_PATH##*.}"
case "$EXT" in
  ts|tsx|js|jsx|py|go|vue|svelte)
    ;;
  *)
    exit 0  # Unsupported extension, skip
    ;;
esac

# Ensure file exists
if [[ ! -f "$FILE_PATH" ]]; then
  exit 0
fi

# Auto-detect CCLSP_CONFIG_PATH from project if not set
if [[ -z "${CCLSP_CONFIG_PATH:-}" ]]; then
  # Try project-local cclsp.json
  if [[ -n "${CLAUDE_PROJECT_DIR:-}" && -f "$CLAUDE_PROJECT_DIR/cclsp.json" ]]; then
    export CCLSP_CONFIG_PATH="$CLAUDE_PROJECT_DIR/cclsp.json"
  fi
fi

# Skip if no config found
if [[ -z "${CCLSP_CONFIG_PATH:-}" ]]; then
  exit 0
fi

# Call cclsp via mcporter with timeout to prevent hanging
if ! RESULT=$(cd "$MCPORTER_DIR" && timeout 10s pnpm --silent mcporter call cclsp.get_diagnostics "file_path=$FILE_PATH" 2>&1); then
  # mcporter/cclsp failed or timed out - don't block, just continue
  exit 0
fi

# Check if there are diagnostics (handle empty output or "No diagnostics found")
if [[ -z "$RESULT" ]] || echo "$RESULT" | grep -q "No diagnostics"; then
  exit 0  # All good
fi

# Block only on LSP errors (not warnings/hints)
if echo "$RESULT" | grep -qE "^• Error"; then
  # Output full diagnostics to stderr (hints included for context)
  echo "LSP Diagnostics:" >&2
  echo "$RESULT" >&2
  exit 2  # Block and inform Claude
fi

exit 0

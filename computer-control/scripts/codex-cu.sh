#!/usr/bin/env bash
# codex-cu.sh — Bridge Claude Code to Codex Computer Use (and the in-app Browser).
#
# The Codex wrapper is adapted from tomc98/claude-code-codex-skill by Thomas Csere (MIT).
# https://github.com/tomc98/claude-code-codex-skill
#
# Codex (GPT-5.x) can drive a UI three ways via bundled plugins:
#   - gui   → full macOS desktop control (computer-use@openai-bundled, the Sky CUA MCP server)
#   - web   → the in-app Browser for local/dev pages (browser@openai-bundled)
#   - check → report which plugins/permissions are ready, optionally install computer-use
#
# All UI runs go through `codex exec` (non-interactive), mirroring the sibling `codex` skill:
# build a CMD array, capture the session id + final message, emit a clean SESSION/--- block.
#
# IMPORTANT: `gui` controls the REAL Mac desktop session — it moves the cursor, types, and
# screenshots the actual screen. It is not headless from macOS's point of view. Fire it only
# on explicit user intent. The on-screen overlay supports Esc-to-cancel.
#
# Usage:
#   codex-cu.sh check [--install]
#   codex-cu.sh gui  "task" [--dir PATH] [--model M] [--effort LEVEL] [--image FILE] [--dry-run]
#   codex-cu.sh web  "task" [--dir PATH] [--model M] [--effort LEVEL] [--image FILE] [--dry-run]
#   codex-cu.sh resume [--last | --session ID] "follow-up" [--dir PATH]

set -eo pipefail

CODEX_BIN="${CODEX_BIN:-/Applications/Codex.app/Contents/Resources/codex}"
CUA_APP="${CUA_APP:-$HOME/.codex/computer-use/Codex Computer Use.app}"
OUTPUT_FILE=$(mktemp "${TMPDIR:-/tmp}/codex-cu-output.XXXXXX")
STDERR_FILE=$(mktemp "${TMPDIR:-/tmp}/codex-cu-stderr.XXXXXX")

cleanup() { rm -f "$OUTPUT_FILE" "$STDERR_FILE"; }
trap cleanup EXIT

# ── Helpers ──────────────────────────────────────────────────────────

usage() {
    cat <<'EOF'
codex-cu.sh — Bridge to Codex Computer Use / in-app Browser

Commands:
  check [--install]               Report readiness; --install adds computer-use@openai-bundled
  gui   "task"                    Control macOS desktop apps (real screen) via Computer Use
  web   "task"                    Drive the in-app Browser for localhost / file:// targets
  resume --last "follow-up"       Resume the most recent session
  resume --session ID "follow-up" Resume a specific session

Options (gui / web / resume):
  --dir PATH        Working directory (default: current)
  --model MODEL     Override model (default: ~/.codex/config.toml)
  --effort LEVEL    Reasoning effort: minimal|low|medium|high|xhigh
  --image FILE      Attach an image to the prompt (repeatable)
  --dry-run         Print the codex command without executing it (gui/web)

Notes:
  * gui requires the computer-use plugin installed (run: codex-cu.sh check --install)
    and macOS Accessibility + Screen Recording granted to "Codex Computer Use".
  * gui drives the real desktop. Only run it on explicit user intent. Esc cancels on screen.
EOF
    exit 1
}

extract_session_id() {
    grep -m1 'session id:' "$1" 2>/dev/null | sed 's/.*session id: //' || echo "unknown"
}

emit_result() {
    local session_id
    session_id=$(extract_session_id "$STDERR_FILE")
    echo "SESSION: $session_id"
    echo "---"
    if [[ -s "$OUTPUT_FILE" ]]; then
        cat "$OUTPUT_FILE"
    else
        echo "(No output captured — check stderr below)"
        echo ""
        grep -E '(ERROR|error|Error|Warning|panic|not available|unavailable)' "$STDERR_FILE" 2>/dev/null | head -20 || true
    fi
}

# plugin_status NAME@MARKETPLACE → echoes: enabled | disabled | not-installed | unknown
plugin_status() {
    local sel="$1" line
    line=$("$CODEX_BIN" plugin list 2>/dev/null | grep -F "$sel" | head -1 || true)
    if [[ -z "$line" ]]; then echo "unknown"; return; fi
    if grep -q "not installed" <<<"$line"; then echo "not-installed"
    elif grep -q "installed, enabled" <<<"$line"; then echo "enabled"
    elif grep -q "installed" <<<"$line"; then echo "disabled"
    else echo "unknown"; fi
}

# ── Shared flag parser ───────────────────────────────────────────────

parse_common_flags() {
    # Sets globals: PROMPT, DIR, MODEL, EFFORT, IMAGES[], DRYRUN
    PROMPT=""; DIR=""; MODEL=""; EFFORT=""; IMAGES=(); DRYRUN=false
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dir)     DIR="$2"; shift 2 ;;
            --model)   MODEL="$2"; shift 2 ;;
            --effort)  EFFORT="$2"; shift 2 ;;
            --image)   IMAGES+=("$2"); shift 2 ;;
            --dry-run) DRYRUN=true; shift ;;
            --*)       shift ;;
            *) [[ -z "$PROMPT" ]] && PROMPT="$1"; shift ;;
        esac
    done
}

# Builds CMD array. Args: FEATURE (e.g. computer_use) SANDBOX (e.g. danger-full-access)
build_cmd() {
    local feature="$1" sandbox="$2"
    # Default to the agentic tier for screen-driving work. Do NOT inherit config.toml's
    # model here: that pin is for interactive coding sessions, and a model the account
    # cannot serve fails as a 400 mid-run ("model is not supported when using Codex with
    # a ChatGPT account") AFTER the CU app has already opened — which reads like a
    # capture/permissions failure rather than a model error.
    [[ -z "$MODEL" ]] && MODEL="gpt-5.6-terra"
    CMD=("$CODEX_BIN" exec --skip-git-repo-check)
    [[ -n "$DIR" ]]    && CMD+=(-C "$DIR")
    [[ -n "$MODEL" ]]  && CMD+=(-m "$MODEL")
    [[ -n "$EFFORT" ]] && CMD+=(-c "model_reasoning_effort=\"$EFFORT\"")
    CMD+=(--enable "$feature")
    CMD+=(-s "$sandbox")
    CMD+=(-c 'approval_policy="never"')   # exec is non-interactive: never block on approvals
    for img in "${IMAGES[@]}"; do CMD+=(-i "$img"); done
    CMD+=(-o "$OUTPUT_FILE")
    CMD+=("$PROMPT")
}

run_cmd() {
    if $DRYRUN; then
        echo "DRY RUN — would execute:"
        printf '%q ' "${CMD[@]}"; echo
        exit 0
    fi
    "${CMD[@]}" </dev/null >/dev/null 2>"$STDERR_FILE" || true
    emit_result
}

# ── gui: full macOS desktop control ──────────────────────────────────

gui_codex() {
    parse_common_flags "$@"
    [[ -z "$PROMPT" ]] && { echo "ERROR: No task provided" >&2; exit 1; }

    if [[ "$(plugin_status computer-use@openai-bundled)" != "enabled" ]]; then
        cat >&2 <<EOF
ERROR: Computer Use is not ready.
  Status: $(plugin_status computer-use@openai-bundled)
  Fix:    $0 check --install
          then grant macOS Accessibility + Screen Recording to "Codex Computer Use",
          and run an interactive 'codex' session once to complete first-run consent.
EOF
        exit 2
    fi

    PROMPT="You have the macOS Computer Use capability (the computer-use plugin / SkyComputerUseClient MCP server). Use it to view the screen and control macOS applications — mouse, keyboard, screenshots — to accomplish the task. Work step by step, verify each step from what you observe on screen, and stop when the task is complete or genuinely blocked (report why). Do NOT improvise with shell commands in place of the Computer Use tool. If the Computer Use tool is NOT available to you in this session, reply with exactly COMPUTER_USE_UNAVAILABLE on its own line and stop.

TASK:
$PROMPT"

    # GUI loops are step-heavy; default to 'high' rather than the config's xhigh for responsiveness.
    [[ -z "$EFFORT" ]] && EFFORT="high"
    build_cmd computer_use danger-full-access
    run_cmd
}

# ── web: in-app Browser for local/dev targets ────────────────────────

web_codex() {
    parse_common_flags "$@"
    [[ -z "$PROMPT" ]] && { echo "ERROR: No task provided" >&2; exit 1; }

    if [[ "$(plugin_status browser@openai-bundled)" != "enabled" ]]; then
        cat >&2 <<EOF
ERROR: Browser plugin is not ready.
  Status: $(plugin_status browser@openai-bundled)
  Fix:    $CODEX_BIN plugin add browser@openai-bundled
EOF
        exit 2
    fi

    PROMPT="Use the in-app Browser (browser_use) to accomplish this task against local/dev targets such as localhost, 127.0.0.1, ::1, or file:// URLs. Navigate, inspect, click, type, and screenshot as needed; verify outcomes from what the page actually shows. If the Browser tool is NOT available to you in this session, reply with exactly BROWSER_UNAVAILABLE on its own line and stop.

TASK:
$PROMPT"

    [[ -z "$EFFORT" ]] && EFFORT="high"
    build_cmd browser_use workspace-write
    run_cmd
}

# ── resume ───────────────────────────────────────────────────────────

resume_codex() {
    local prompt="" session_id="" use_last=false dir=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --session) session_id="$2"; shift 2 ;;
            --last)    use_last=true; shift ;;
            --dir)     dir="$2"; shift 2 ;;
            --*)       shift ;;
            *) [[ -z "$prompt" ]] && prompt="$1"; shift ;;
        esac
    done
    [[ -n "$dir" ]] && cd "$dir"

    local -a cmd=("$CODEX_BIN" exec resume --skip-git-repo-check)
    if [[ -n "$session_id" ]]; then cmd+=("$session_id")
    elif $use_last; then cmd+=(--last)
    else echo "ERROR: Specify --session ID or --last" >&2; exit 1; fi
    [[ -n "$prompt" ]] && cmd+=("$prompt")
    cmd+=(-o "$OUTPUT_FILE")

    "${cmd[@]}" </dev/null >/dev/null 2>"$STDERR_FILE" || true
    emit_result
}

# ── check: readiness report ──────────────────────────────────────────

check_codex() {
    local do_install=false
    [[ "$1" == "--install" ]] && do_install=true

    echo "Codex Computer Use — readiness"
    echo "------------------------------"
    if [[ -x "$CODEX_BIN" ]]; then
        echo "codex binary   : $("$CODEX_BIN" --version 2>/dev/null)"
    else
        echo "codex binary   : NOT FOUND at $CODEX_BIN"; exit 2
    fi
    [[ -d "$CUA_APP" ]] && echo "CUA app        : present ($CUA_APP)" \
                        || echo "CUA app        : MISSING ($CUA_APP)"
    echo "browser plugin : $(plugin_status browser@openai-bundled)"
    echo "chrome plugin  : $(plugin_status chrome@openai-bundled)   (optional — real Chrome profile)"
    echo "computer-use   : $(plugin_status computer-use@openai-bundled)"
    echo

    if $do_install; then
        echo "Installing computer-use@openai-bundled (may open a consent dialog)…"
        "$CODEX_BIN" plugin add computer-use@openai-bundled || true
        echo
        echo "New status     : $(plugin_status computer-use@openai-bundled)"
        echo
        echo "Next: grant macOS Accessibility + Screen Recording to \"Codex Computer Use\""
        echo "      (System Settings → Privacy & Security), then run one interactive 'codex'"
        echo "      session to clear first-run consent before using gui in the background."
    else
        local st; st=$(plugin_status computer-use@openai-bundled)
        if [[ "$st" != "enabled" ]]; then
            echo "To enable desktop control:  $0 check --install"
        else
            echo "Ready for: $0 gui \"<task>\""
        fi
    fi
}

# ── Main ─────────────────────────────────────────────────────────────

[[ $# -lt 1 ]] && usage
case "$1" in
    check)  shift; check_codex "$@" ;;
    gui)    shift; gui_codex "$@" ;;
    web)    shift; web_codex "$@" ;;
    resume) shift; resume_codex "$@" ;;
    help|--help|-h) usage ;;
    *) echo "ERROR: Unknown command '$1'. Use: check, gui, web, resume" >&2; exit 1 ;;
esac

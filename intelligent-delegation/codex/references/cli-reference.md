# Codex CLI Quick Reference

## Commands

| Command | Description |
|---------|-------------|
| `codex exec "prompt"` | Run non-interactively (headless) |
| `codex exec review` | Run code review non-interactively |
| `codex exec resume` | Resume a previous session non-interactively |
| `codex resume` | Resume interactively (TUI) |
| `codex fork` | Fork/branch a previous session |

## Key Flags for `codex exec`

| Flag | Description |
|------|-------------|
| `-o FILE` | Write final message to file |
| `--json` | Output JSONL event stream |
| `-m MODEL` | Override model |
| `-C DIR` | Set working directory |
| `-s MODE` | Sandbox: `read-only`, `workspace-write`, `danger-full-access` |
| `-i FILE` | Attach image(s) to prompt (repeatable) |
| `--full-auto` | workspace-write + relaxed approvals |
| `--ephemeral` | Don't persist session to disk |
| `--output-schema FILE` | Validate output against JSON Schema |
| `--add-dir DIR` | Grant write access to additional directory |
| `--skip-git-repo-check` | Run outside git repos |
| `--color never` | Disable ANSI colors |

## Key Flags for `codex exec review`

| Flag | Description |
|------|-------------|
| `--uncommitted` | Review staged + unstaged + untracked |
| `--base BRANCH` | Review against base branch |
| `--commit SHA` | Review a specific commit |
| `--title TEXT` | Add commit title to summary |

## Key Flags for `codex exec resume`

| Flag | Description |
|------|-------------|
| `SESSION_ID` | Resume specific session |
| `--last` | Resume most recent session |
| `--all` | Show sessions from all directories |
| `PROMPT` | Send follow-up prompt after resume |

## Config Overrides (`-c`)

```bash
# Model and reasoning
-c model="gpt-5.5"
-c model_reasoning_effort="high"       # low|medium|high|xhigh|max|ultra (5.6 ladder)
-c model_reasoning_summary="detailed"   # auto|concise|detailed|none

# Web search (for exec mode — --search flag is interactive-only)
-c features.search_tool=true

# Sandbox
-c sandbox_mode="workspace-write"

# Behavior
-c approval_policy="never"              # untrusted|on-failure|on-request|never
```

## Models

| Model | Use Case |
|-------|----------|
| `gpt-5.6-sol` | ⛔ **Not servable on ChatGPT-account auth since 12 Aug 2026** — calls 400 with "not supported when using Codex with a ChatGPT account". Historical: GPT-5.6 flagship (2026-07-09), led terminal/tool-loop agentic work, near-Fable depth (AA II 59 vs 60). |
| `gpt-5.5` | **The default here.** Frontier tier still on the account — complex coding, research, adversarial review. |
| `gpt-5.6-terra` | Balanced agentic model — the target for screen-driving / Computer Use (`codex-cu.sh` defaults to it). Not for adversarial review (measured recall regression). |
| `gpt-5.6-luna` / `gpt-5.4-mini` | Fast/cheap tiers. Duplicate Claude lanes; not quality-first targets. |
| `gpt-5.6-terra` | 5.6 mid-tier — do NOT use for adversarial review (measured −8.6pp recall regression) or long-horizon work (verbose) |
| `gpt-5.6-luna` | 5.6 efficient tier — duplicates Haiku's lane; unused in this skill |
| `gpt-5.5` | Previous flagship, still available (not deprecated) — fallback if 5.6 misbehaves |
| `gpt-5.4` | Older generation |

## Reasoning Effort (GPT-5.6 ladder)

| Level | Use Case |
|-------|----------|
| `low` | Quick edits |
| `medium` | Daily driver (CLI default) |
| `high` | Complex tasks, adversarial review |
| `xhigh` | Maximum single-agent accuracy |
| `max` | Above xhigh — rare, concrete-signal-only |
| `ultra` | Codex spawns its own subagent fan-out — never inside a delegate run (double-orchestration) |

## Sandbox Modes

| Mode | Behavior |
|------|----------|
| `read-only` | Can read files, run read-only commands. Cannot write. Used by `think`. |
| `workspace-write` | Can read + write within the project directory only. Sandboxed. |
| `danger-full-access` | Full system access. No sandbox. Used by `run`. |

## Web Search in Exec Mode

The `--search` flag only works in interactive mode. For `codex exec`, enable web search via config override:

```bash
codex exec -c 'features.search_tool=true' "Search the web for..."
```

This is handled automatically by `codex.sh` — both `think` and `run` commands enable web search by default.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `CODEX_API_KEY` / `OPENAI_API_KEY` | Authentication |
| `CODEX_HOME` | Override config dir (default: `~/.codex`) |

## Session Storage

Sessions stored at `~/.codex/sessions/` as JSONL files, organized by date. Use `--ephemeral` to skip persistence.

## Output Modes

- **Default**: Progress on stderr, final message on stdout
- **`--json`**: JSONL event stream on stdout
- **`-o FILE`**: Final message written to file
- **`--output-schema`**: Final message validated against JSON Schema

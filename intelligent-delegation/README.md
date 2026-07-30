<h1 align="center">claude-intelligent-delegation</h1>

<p align="center">
  A <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> skill that orchestrates complex builds by decomposing tasks, fanning work out to Sonnet sub-sessions and Codex in parallel, running QA, and presenting a unified diff — all without bloating the main session's context.
</p>

---

## One-shot install (in Claude Code)

Paste this into a Claude Code session and let Claude do the install:

```
Install the intelligent-delegation skill: clone https://github.com/justinwilliames/skills, copy its intelligent-delegation/ directory to ~/.claude/skills/intelligent-delegation, then verify by listing ~/.claude/skills/intelligent-delegation/SKILL.md. The Codex wrapper is bundled — no separate install needed. Confirm jq is on PATH; if not, install it via brew install jq.
```

Or in a terminal:

```bash
git clone https://github.com/justinwilliames/skills /tmp/claude-skills
cp -R /tmp/claude-skills/intelligent-delegation ~/.claude/skills/intelligent-delegation

# dependency
brew install jq   # or: apt install jq
```

Then start a Claude Code session and ask it to "delegate" or "fan out" a multi-part task. The skill loads automatically.

## Why

Long main sessions degrade reasoning quality and burn prompt cache. This skill keeps the orchestrator lean: it plans, delegates, verifies, and reports. Sonnet sub-sessions do the implementation; Codex provides second opinions or handles deep precision work.

**No git required.** State lives in `$TMPDIR/delegate/<run-id>/` — works in any directory.

## Upfront triage — the load-bearing behaviour

The skill is designed to fire **at the start of every non-trivial task**, before the main session reads files or spawns Explore subagents. Claude runs a 5-second, 6-question check:

1. **Scope** — does this touch 2+ independent files/features/deliverables?
2. **Context** — would in-session execution burn >30% of remaining context?
3. **Fresh-window** — would a single deep task benefit from a fresh prompt cache + clean reasoning surface?
4. **Parallelism** — are there 2+ independent units that could run concurrently?
5. **Large surface** — does the chunk's read surface exceed ~150K tokens? If so, route it to a 1M Opus 5 subprocess (never the orchestrator seat).
6. **Model fit** (only if 1–5 are all no) — does the task genuinely need Opus-level reasoning? If not, route to a 1-chunk Sonnet or Codex run for efficiency. If it sits in one of Fable 5's two narrow lanes (multi-day-autonomy stamina, hardest-repo judgment) *and* Opus 5 has visibly plateaued, escalate that sub-problem to a Fable delegate — a target, never the orchestrator seat. Since Opus 5, that escalation is a lateral trade, not an upgrade.

If any of 1–4 is yes, delegate. Even a 1-chunk run is worth it for fresh-window value alone — parallelism is one optimisation; fresh-context and model-fit are equally valid reasons to delegate. The Q6 check stops the main session burning Opus on mechanical work (renames, boilerplate, pattern-mirroring, lint/format fixes) that Sonnet handles better and cheaper.

Claude states the call in a single line so you can redirect early:

> `Delegation triage: fan-out — 4 independent feature chunks, would burn ~50% main-session context.`
> `Delegation triage: 1-chunk Sonnet run — mechanical rename across 3 files, no Opus reasoning required.`
> `Delegation triage: in-session on Opus — multi-file architectural decision, reasoning needed here.`

Skip the triage for conversational replies, status questions, single-line edits, or one-file one-read lookups.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- `jq` on PATH

The Codex wrapper is bundled under [`codex/`](codex/) — vendored from [tomc98/claude-code-codex-skill](https://github.com/tomc98/claude-code-codex-skill) (Thomas Csere, MIT). No separate install required.

## Updating

```bash
cd /tmp/claude-skills && git pull && cp -R intelligent-delegation ~/.claude/skills/
```

## Usage

Claude Code loads the skill automatically when you ask it to delegate or decompose work. You can also invoke directly:

```
/delegate plan "<task>"          # decompose only
/delegate run "<task>"           # decompose → confirm → fan out → audit → apply → QA → present
/delegate review "<draft>"       # 1-chunk Codex run — adversarial second opinion (review.md, no apply)
/delegate resume [run-id]        # re-fan only pending/failed chunks (defaults to last run)
/delegate qa <run-id>            # re-run QA on an existing run
/delegate abort <run-id>         # mark all running chunks failed; write ABORTED marker (blocks apply)
/delegate watch [run-id]         # compact one-shot snapshot of state.tsv (used for in-chat progress)
```

## How it works

1. **Init** — fresh run dir at `$TMPDIR/delegate/<run-id>/`, with a compact `state.tsv` the orchestrator re-reads on demand.
2. **Decompose** — Opus writes a manifest describing each chunk: id, intent, files_touched, runner, verification. On high-stakes cuts (ambiguous boundaries, large fan-out, tangled project), the orchestrator engages **ultrathink** before committing the manifest — a bad cut is the one error no downstream verification catches. Escalates to a Fable 5 Plan delegate only if ultrathink-on-Opus plateaus.
3. **Validate + preflight** — schema check, file-collision check across chunks, and a guard against overwriting existing project files.
4. **Confirm** — manifest shown; you approve.
5. **Prepare workspaces** — each chunk gets a private `<chunk-id>/workspace/` directory to write into.
6. **Fan out** — subagents and Codex run in parallel, each constrained to their own workspace, each briefed on one standard spine rather than ad-hoc prompts.
7. **Liveness gate** — `delegate.sh liveness` checks two signals per running chunk (its spawn stamp, and the newest artifact mtime anywhere under the chunk dir) and reports `ALIVE` / `BOOTING` / `SILENT` / `STALLED`. A missing completion notification is not evidence of progress; no chunk is reported as "running" without this observation. Fails closed — exit 3 rather than OK when the run has been aborted or lost its state file.
8. **Audit** — verifies each chunk only produced its declared files and no two chunks emitted the same file.
9. **Apply** — copies workspace outputs into the project, preserving relative paths.
10. **QA gate** — per-chunk verification + project-wide test suite, run against the integrated project.
11. **Dual-model review** (major runs) — a cold Opus 5 subagent and Codex Sol review the applied code independently and in parallel; the orchestrator reconciles into one punch list.
12. **Present** — table of chunks, files, tokens, durations, pass/fail. Plus the `run_id` for resume.

Audit and QA failures are always surfaced to you — never auto-resolved.

## Model routing

Every figure behind these calls lives in one dated block in `SKILL.md` → **Model Facts**; nothing else in the skill restates a number.

| Tier | Model | Used for |
|------|-------|---------|
| Orchestrator | Opus 5 (main session) | Planning, reviewing, QA, reporting |
| Apex reasoning | Fable 5 (delegate target) | Fable's two surviving lanes — multi-day-autonomy stamina, hardest-repo judgment — never the orchestrator seat |
| Planning | Opus 5 (Plan subagent) | Manifest authoring for non-trivial decompositions |
| Build | Opus 5 (Agent) — Sonnet 5 for wide fan-outs | Parallel implementation chunks |
| Cheap parallel | Haiku 4.5 (Agent) | High-volume narrow text/data chunks (classify, convert, bulk edits) — a volume-and-latency play, never a cost one |
| Large-context | Opus 5 1M (CLI subprocess) | A single chunk with a >150K read surface — never the seat |
| Integration | Opus 5 (main, in-line) | `runner: main` chunks — glue, cross-cutting edits |
| Precision | Codex GPT-5.6 Sol | Deep work, adversarial review, second opinions |
| Lookup | Haiku 4.5 (Explore subagent) | File search, symbol lookup |

Full decision tree and the seat-topology argument: [`references/routing.md`](references/routing.md)

## State model

```
$TMPDIR/delegate/<run-id>/
├── manifest.json             # immutable plan
├── state.tsv                 # compact orchestrator state (one row per chunk)
├── chunk-1/workspace/        # chunk writes here, relative paths
├── chunk-2/workspace/
└── …
```

`state.tsv` is ~80 chars per chunk — designed so the orchestrator can re-read it for under 250 tokens between turns.

## Engine commands

`scripts/delegate.sh` exposes the full lifecycle:

```
init / write-manifest / validate / preflight / prepare /
set / get / state / workspace / pending / resume /
diff / audit / apply / qa / summary / handoff / watch /
liveness / abort / clean / last / autodetect / codex
```

`DELEGATE_DEBUG=1` enables an ERR trap that prints failing line + command + exit code.

## Repository layout

```
intelligent-delegation/
├── SKILL.md                      # Skill definition (loaded by Claude Code)
├── README.md                     # This file
├── LICENSE                       # MIT
├── scripts/
│   ├── delegate.sh               # Full orchestrator engine (git-free)
│   └── detect-verification.sh    # Auto-detect test/typecheck commands
├── references/
│   ├── routing.md                # Model-routing decision tree
│   ├── manifest-schema.md        # Manifest schema + examples
│   ├── orchestration-patterns.md # Sequencing, audit, resume, anti-patterns
│   └── prompt-templates.md       # Chunk prompt templates (Sonnet, Codex, Review)
└── codex/                        # Vendored Codex wrapper — tomc98/claude-code-codex-skill (MIT)
    ├── scripts/codex.sh          # The Codex CLI wrapper the orchestrator calls
    ├── LICENSE                   # Thomas Csere's original MIT licence (unmodified)
    └── VENDORED-FROM.md          # Provenance + attribution
```

## Credits

The bundled Codex wrapper under [`codex/`](codex/) is vendored from [tomc98/claude-code-codex-skill](https://github.com/tomc98/claude-code-codex-skill) by Thomas Csere, used under the MIT License (his original licence is preserved at [`codex/LICENSE`](codex/LICENSE)).

## License

MIT © Justin Williames 2026

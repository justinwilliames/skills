# Orchestration Patterns

Patterns the orchestrator should reach for, and anti-patterns to avoid. Assume the git-free, workspace + state.tsv engine.

## The canonical run

```
init → write-manifest → validate → preflight → user confirms
     → prepare → fan-out (parallel) → collect → audit → apply → qa → summary
```

Each arrow corresponds to one `delegate.sh` subcommand. The orchestrator does not invent intermediate steps. If you find yourself reaching for `git`, `mv`, or `rsync` directly, stop — the engine already covers it.

## Parallelism

**Default**: every chunk with `depends_on: []` is launched in a single tool-call batch (`Agent` for sonnet/haiku/fable subagents, `Bash` background for codex and `opus-1m-cli` subprocesses). The orchestrator then waits on `TaskOutput` / task-notification for each.

**With dependencies**: topologically sort. Launch all chunks whose deps are satisfied in one batch. When a wave returns, mark `status=done`, then launch the next wave.

**Hard ordering constraint**: chunks that overlap in `files_touched` MUST have a `depends_on` edge between them. `validate` enforces this; the engine refuses to run a manifest where two siblings claim the same file.

## State updates

Set state at the natural transitions, not on every internal event:

| Event | State update |
|---|---|
| Chunk launched | `set status=running` |
| Chunk completes successfully | `set status=done tokens=… duration_ms=… result=pass:N/M` |
| Chunk completes with verification failing | `set status=failed result="<one-line summary>"` |
| Chunk crashes / hits ceiling / cancelled | `set status=failed result="<reason>"` |
| User skips a chunk on resume | `set status=skipped` |

Never write to `state.tsv` directly — always via `delegate.sh set`. The schema may evolve.

## Collecting telemetry

`tokens` and `duration_ms` come from the runner:
- Sonnet `Agent` `task-notification` includes `<usage><total_tokens>` and `<duration_ms>` fields. Parse them from the notification block and store via `delegate.sh set` (the orchestrator must call this — the engine doesn't auto-capture for sonnet).
- Codex: the engine's `cmd_codex` parses JSONL `turn.completed` events for `usage.input_tokens + usage.output_tokens` and auto-stores the sum.
- Haiku and Fable subagents report via the same `task-notification` fields as Sonnet — parse and `delegate.sh set` them. `opus-1m-cli` subprocesses have no task-notification; scrape the final stdout line or parse `--output-format json` for token counts.

This data is the whole point of doing the orchestration in the first place — it tells the user whether codex was cheaper than sonnet for this chunk class.

## Retry policy — transient vs hard failure

A chunk failure is either transient (recoverable on retry) or hard (needs user intervention). The orchestrator decides which by parsing the failure message.

**Transient markers** (keywords in the failure message): `timeout`, `rate limit`, `connection reset`, `daemon`, `503`, `429`, `ECONNRESET`, `temporary failure`.

**On transient failure:**
1. Set `result=transient:<reason>`.
2. Wait 30 seconds.
3. Re-fan the chunk once with the same prompt.
4. If the retry succeeds, mark `done` as normal. If it fails again, treat as hard.

**On hard failure:**
1. Set `result=hard:<reason>`.
2. Surface to the user immediately — chunk id, intent, error, suggested fix.
3. Do NOT auto-retry.

Hard rule: at most one transient retry per chunk per run. Anything beyond that is hard.

## While the fan-out runs

Background subagents take 30s–5min to complete. Use that window productively in the main session:

- Draft the user-facing summary skeleton (chunks done, files changed, QA status — leave numbers blank).
- Pre-load any project conventions the audit step will need (style guide, lint config, naming patterns).
- Write the QA edge-case checklist (which verifications to scrutinise, which file overlaps to watch).
- Prep the apply-stage summary template.

Do NOT idle. The prompt cache TTL is 5 minutes. Letting the main session sit silent for 4 minutes means a cold-cache penalty when you resume for QA. Either work the in-flight time productively, or accept a long pause (>=1200s) and commit to a cold restart.

## Orchestrator-initiated abort

The orchestrator should call `{base}/scripts/delegate.sh abort <run-id>` when it detects a runaway chunk. Triggers:

- **Confirmed stall.** `delegate.sh liveness <run-id>` returns `STALLED` for the same chunk twice, with a re-spawn in between. Never abort off a hunch — the liveness read is the evidence.
- **Contradictory state.** The chunk reports `done` but its workspace is empty, or vice versa.
- **Infinite loop in stdout.** Repeated phrases, ballooning output size, the chunk is clearly stuck.
- **User signal.** The user says "stop", "abort", "kill the run".

Do NOT abort off a single `SILENT` or `STALLED` reading. `BOOTING` is normal for the first 90 seconds, and a chunk that reasons for minutes before its first write is working, not hung — that false-alarm is exactly what the grace window exists to prevent.

Behaviour: `abort` marks all `running` chunks `failed` with `result=aborted:<reason>`, writes an `ABORTED` marker file to the run dir, and prevents the `apply` step from running. Re-fan via `/delegate resume` after the root cause is identified and fixed.

Do NOT call abort for a chunk that's merely slow — only when it's demonstrably stuck. A 4-minute Sonnet subagent is fine; a 30-minute one is not.

## Audit failures

`delegate.sh audit` halts on two conditions:

1. **Undeclared file in a workspace.** The chunk produced something its manifest didn't claim. Either the prompt was under-specified (chunk made a reasonable inference) or the chunk went rogue. Show the user the file and its content. Options: add the file to `files_touched` and re-audit (if intentional), or `clean` the run and re-fan (if accidental).
2. **Same file emitted by two chunks.** Shouldn't happen if `validate` passed — implies a chunk wrote outside its declared paths. Treat as a bug; surface both workspaces' versions and ask the user which (if either) to keep.

**Never** auto-resolve. The whole point of audit is to be the human-checkpoint before files land in the project.

## QA failures

`delegate.sh qa` fails when a chunk's `verification` or the `project_verification` exits non-zero. Show the user:

1. Which check failed.
2. The chunk(s) most likely responsible (look at `files_touched` overlap with the failing test).
3. `delegate.sh diff <run-id> <chunk-id>` for that chunk to show file list.
4. Suggested next step: revert apply by `clean`-ing the run, or fix forward.

## Resume patterns

`/delegate resume <run-id>` is for two cases:

- **Single chunk failed**: leave `done` chunks alone, re-fan the failed one only.
- **Run was killed mid-flight**: any `pending` or `running` chunks get re-launched. (Note: `running` is treated as "not done"; the engine assumes a crashed orchestrator left it stale.)

The orchestrator on resume should:
1. `delegate.sh state <run-id>` to read the full picture.
2. `delegate.sh pending <run-id>` to list re-fan candidates.
3. For each candidate, re-launch with the **same prompt template** as the original run (files_touched, intent, runner all live in the manifest).
4. Audit, apply, QA as normal.

## When NOT to use this skill

- Single-file edit, single-step task: just edit it.
- Conversational task: just respond.
- Task fits in <30% of remaining context: do it in-session.
- Tightly coupled refactor where chunks would constantly step on each other: serialize via `depends_on` chain — but if every chunk depends on every prior chunk, you have one chunk, not many.
- Exploratory work where the scope keeps changing: design first in the main session, fan out only when boundaries stabilise.

## Anti-patterns

- **Editing the manifest after `write-manifest`.** Manifest is immutable per run. To change the plan: `clean` + `init` a new run.
- **Skipping `audit`.** Even when you trust the chunks, the audit is the last guard before user files get touched.
- **Letting chunks write into the project.** They go to workspaces. Always.
- **Auto-resolving conflicts.** The user decides. Always.
- **Holding chunk diffs in your context.** Use `delegate.sh diff <run-id> <chunk-id>` on demand. State.tsv has everything else.
- **Spawning a new orchestrator turn per chunk.** Fan out all parallelizable chunks in a single batch. Don't serialize what can be parallel.

## Surface notes — Desktop, CLI, and Agent Teams

> Moved here from SKILL.md 2026-07-30 (R10 economy pass). SKILL.md carries the routing rule; this is the detail behind it.

**Desktop ↔ CLI parity (confirmed 2026).** Claude Code Desktop (Mac/Windows app) and the terminal CLI both support the Agent / `subagent_type` tool, `~/.claude/skills/`, hooks, MCP servers, and CLAUDE.md inheritance. This skill works identically on both — same triage, same fan-out, same QA gates. Documented Desktop gaps that touch this skill: no `--model` / `--permission-mode` flags exposed at launch, and no autonomous `/loop` runs. Neither blocks the core flow.

**Agent Teams (experimental, shipped Feb 2026).** A lead agent coordinating independent teammate *instances* via shared task lists and mailbox-style inter-agent messaging. Enable with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.

**Default behaviour: stay on subagents.** The `opus-subagent` / `sonnet-subagent` / `haiku-subagent` runners cover ~95% of fan-out needs — faster to spawn, well-understood failure modes, no shared-mailbox footgun. Agent Teams is a real escape hatch, not a parallel-by-default mechanism. The bar is genuinely high.

| Trigger | Why subagents fail here | First-choice answer |
|---------|------------------------|---------------------|
| A single chunk needs >150K context | Subagent context is bounded by the orchestrator's allowance | **1M Opus CLI subprocess** (`opus-1m-cli`). Agent Teams only if that isn't enough or you need teammate-shaped coordination. |
| A chunk needs project-scoped MCP servers the orchestrator lacks | Subagents inherit orchestrator MCP config | Agent Teams or CLI subprocess — both isolate MCP config |
| A chunk needs different hooks (security policy, auto-format, permission scope) | Subagents share hooks with the orchestrator | Agent Teams or CLI subprocess |
| The chunk could outlast the orchestrator's session limit | Subagents die when the orchestrator session dies | Agent Teams (independent lifetime) |
| The user explicitly asks for Agent Teams | Direct instruction overrides default | Agent Teams |

State the call out loud when reaching for it, like every other delegation call:

> `Agent Teams call: chunk-2 needs to ingest a 400k-token monorepo dump — beyond subagent context. Spinning up a teammate instance.`

**Mailbox messaging is a footgun for this skill's contract.** Agent Teams lets chunks talk to each other. This skill's manifest contract is explicit: chunks are *independent* — no shared files, no cross-dependencies. If chunks need to coordinate, the decomposition is wrong; re-author the manifest rather than papering over it with mailbox traffic. Use the mailbox only for chunk-to-orchestrator status, never chunk-to-chunk.

**No runner integration yet.** Agent Teams is documented but NOT wired into `delegate.sh` as a `runner:` enum value. When a real use case lands, the work is: (a) add `agent-team` to the runner enum in `references/manifest-schema.md` and `delegate.sh validate`, (b) add a spawn block to Step 6, (c) decide how `validate`/`audit`/`apply` handle teammate-produced workspaces. Don't speculate-build it before a real chunk needs it — speculative integration rots until first use exposes the wrong assumptions.

**CLI subprocess trade-off** (`claude -p "<prompt>" --model <id>`). The Agent tool's `model` param exposes `opus|sonnet|haiku|fable`, so Fable delegates spawn natively — but it cannot give a subagent a fresh **1M context window**. A genuine >150K read surface is the case for a subprocess.

| Gains | Costs |
|-------|-------|
| Full 1M-token context per chunk (`--model claude-opus-5`, native 1M) | Process spawn latency (~2–4s per launch) |
| Independent hooks / MCP / settings | No streaming back to the orchestrator (scrape stdout) |
| True session isolation | No `task-notification` token telemetry; harder to capture |
| Survives orchestrator session limits | Permission prompts unless `--permission-mode plan` or pre-approved |

Reach for a CLI subprocess only when: (a) the chunk genuinely needs the 1M window, (b) it needs project-scoped MCP/hooks the orchestrator's session lacks, or (c) Agent Teams isn't enabled and you need true session isolation. For everything else, in-session subagents are the right tool. Don't subprocess-spawn out of habit — it's an escape hatch, not a default.

**Outcomes (research preview).** Claude Managed Agents supports "Outcomes" — specify a desired end state, the agent loops until achieved. A different shape from this skill's bounded decompose-fan-out-collect flow. Don't fold it into the core loop; it changes the determinism contract. Worth knowing for genuinely outcome-shaped specs ("get all tests passing", "reduce bundle below 200kb") rather than decomposable ones.

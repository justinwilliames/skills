# Model Routing Decision Tree

This document explains how the orchestrator should decide between keeping work in the main Opus session, fanning out to Sonnet subagents, asking Codex for precision work, or using Haiku for cheap lookup. The goal is not to maximize delegation. The goal is to maximize output quality while keeping the main session lean and the prompt cache warm.

## Tier Table

> **Model layer refreshed 2026-07-27** for Claude Opus 5 (`claude-opus-5`, released 2026-07-24). Opus 5 takes the orchestrator seat from Opus 4.8 at identical pricing (5/25 per MTok) and now *leads* Fable 5 on general intelligence (AA index 61 v 60) and SWE-bench Verified (~96–97% v 95%), with a four-month-fresher knowledge cutoff. Fable's escalation bar therefore **rose** — see SKILL.md → "Fable 5 routing".

| Tier | Model | Primary job | When to use it | What stays in session |
|------|-------|-------------|----------------|-----------------------|
| Orchestrator | **Opus 5** | Planning, decomposition, QA, reporting, user communication | Always. The main session owns the task, writes the manifest, approves fan-out, reviews outputs, and presents the result. | The full task narrative, tradeoffs, manifest state, QA status, and user-facing explanation stay here. |
| Apex reasoning | Fable 5 (delegate target — `Agent(model="fable")`) | The narrow class of sub-problem that still outruns Opus 5 | Escalate only for **multi-day-autonomy stamina** or **SWE-bench-Pro-shaped repo judgment**, and only once Opus 5 has visibly plateaued. 2× cost, and it scores *below* Opus 5 on general intelligence — this is a lateral trade, not an upgrade. A **target**, never the seat. | Only the Fable delegate's result (a manifest, a fix, a verdict) returns to the seat. |
| Planning | Opus 5 (Plan subagent) | Manifest authoring, decomposition design, multi-file refactor architecture | For non-trivial decompositions (>3 chunks or unfamiliar codebase). Frees the main session from holding planning context while keeping Opus reasoning quality. Research-grade cuts now stay on Opus 5 + ultrathink rather than escalating to Fable. | Only the final JSON manifest and Opus's review notes stay in the main session. |
| Build | **Opus 5 subagent** (fresh, own workspace); Sonnet 5 for wide fan-outs | Parallel implementation chunks | Independent chunks that touch multiple files, follow repo conventions, and write clean outputs into their workspace for copy-back. Quality-first default is Opus 5; drop to Sonnet 5 only for wide (>~6) tightly-specified fan-outs where wall-clock matters. | Only the chunk prompt, its workspace, and the chunk result live in the subagent. Main-session knowledge does not carry over. |
| Cheap parallel | Haiku 4.5 subagent (`model="haiku"`) | High-volume narrow text/data chunks | Classify/tag, format-convert, bulk mechanical edits, per-row enrichment — where verification is trivial (schema/string/lint). Volume-and-latency play, not a cost play. | Only the structured outputs return; the orchestrator collates. |
| Large-context | **Opus 5 1M** via CLI subprocess (`opus-1m-cli`, `--model claude-opus-5`) | A single chunk with a >150K read surface | Monorepo-wide review, big PDF/transcript ingest, multi-hundred-file analysis. Native 1M window at standard pricing; never the orchestrator seat. | Only the chunk's result/verdict returns. |
| Precision / cross-family | Codex GPT-5.6 Sol (`gpt-5.6-sol`, effort `high`/`xhigh`) | Adversarial review, deep algorithms, long terminal/tool-loop grind | Second opinion from a different model family. Never Terra (−8.6pp review recall) or Luna (duplicates Haiku's lane). Never accept its self-reported pass — METR measured Sol with the highest detected reward-hacking rate of any public model they've assessed. | Codex reads the repo fresh; keep only the ask, the result, and review findings. |
| Integration | Opus 5 (main session, in-line) | Integration glue, cross-cutting edits, sibling-chunk coordination | Chunks that genuinely need orchestrator context — package.json edits, root config changes, glue between sibling chunks. Use sparingly. | The full chunk implementation lives in-session since it executes in-context. |
| Lookup | Haiku 4.5 explore subagent | Fast file discovery and lightweight searches | Use for grep-like tasks, symbol discovery, finding entry points, or locating candidate files before deciding where build work belongs. | Only the extracted facts and file paths should be carried back. Haiku should not own implementation context. |

## Decision Tree

1. Start with the context budget.
2. Decide whether the task is truly independent work or just one local edit.
3. If delegation is justified, split by file ownership boundaries first.
4. Pick Sonnet when the chunk should produce a conventional repo diff.
5. Pick Codex when you want an independent model perspective or a narrow precision task.
6. **Before defaulting to "in-session on Opus", check model fit — both directions.** *Down:* mechanical / pattern-following / boilerplate work routes to a 1-chunk Sonnet sub-agent even if context is healthy and there is no fan-out value. *Up:* a sub-problem harder than Opus 5 (multi-day autonomy stamina, SWE-bench-Pro-shaped repo judgment, a blocker-conflict tie-break) escalates to a Fable 5 delegate — a narrow, evidenced call, not a reflex. Opus is reserved for design, tradeoffs, synthesis, orchestration, and user communication — and it stays the orchestrator even when it dispatches Fable work. Fable is a *target*, never the seat.
7. Route any chunk whose *read surface* exceeds ~150K tokens to `opus-1m-cli` (a fresh 1M Opus 5 subprocess) — decomposition first if it splits cleanly; 1M only for genuinely irreducible surfaces. Never bloat the orchestrator seat.
8. Keep integration, conflict decisions, QA, and user communication in the main Opus 5 session.

## Context Budget Thresholds

### `<30%` context used

Keep the work in session.

Rationale:
- The orchestrator still has enough room to inspect files, edit directly, and verify without paying delegation overhead.
- Spinning up workers adds prompt-writing, collection, merge, and QA coordination costs that will usually exceed the savings.
- At this level, the main risk is over-engineering the workflow rather than losing reasoning quality.

Typical action:
- Read the relevant files.
- Make the change directly.
- Run verification.
- Do not create a *multi-chunk* manifest for tiny work — but a **1-chunk** delegation still wins when the task is mechanical/pattern-following (route to Sonnet for efficiency; Opus reasoning adds nothing) or needs an independent perspective (Codex). Context-health gates *fan-out*, not *all delegation*.

### `30-60%` context used

Stay mostly local, but offload lookup and exploration.

Rationale:
- The main session still has enough room to implement, but context growth can become noisy.
- Haiku can cheaply locate files, tests, or symbols without forcing the main session to ingest everything.
- Delegating implementation at this range is only worth it if there are clearly independent chunks.

Typical action:
- Use Haiku or lightweight search helpers to map the repo.
- Keep the implementation in the main session unless you find 2 or more independent units.
- If one chunk would be materially better with an outside perspective, use Codex surgically.

### `>60%` context used

Decompose and fan out unless the task is genuinely tiny.

Rationale:
- At this point the main session becomes expensive to maintain and easier to confuse with implementation detail.
- Parallel work lets each worker start from a fresh prompt and avoid inheriting irrelevant history.
- The orchestrator should spend its remaining context on decomposition, chunk prompts, QA, and user decisions.

Typical action:
- `delegate.sh init`, then author and `write-manifest` the manifest.
- Split independent chunks by file ownership.
- Route build chunks to Sonnet.
- Route skeptical review or precision work to Codex.

## Cache Discipline

Claude prompt cache TTL is 5 minutes. Treat that as a hard operational constraint.

Rules:
- Prefer keeping the main session cadence under `270` seconds between turns.
- If you know the next meaningful update will take longer, do not hover around the TTL boundary.
- Either return before the cache expires or accept that the cache will be cold and structure the workflow around that.
- When the pause will be long, aim for `>=1200` seconds rather than drifting around `300`.
- Never plan around exactly `300` seconds. It is too close to the expiration boundary to be reliable.

Why this matters:
- A near-expiry pause risks paying the cost of a cold session while still acting as if context is cheap.
- Sonnet and Codex workers already benefit from fresh, narrow prompts, so the main session should preserve its own cache discipline instead of letting it decay.

Operational rule of thumb:
- If you can answer, prompt, or checkpoint quickly, do it fast.
- If you need a long-running build or review cycle, lean into fan-out and treat the main session as a coordinator that returns after meaningful milestones.

## Sonnet vs Codex

Use this table after you have already decided that a chunk should not stay in the main session.

| Decision factor | Prefer Sonnet subagent | Prefer Codex |
|-----------------|------------------------|--------------|
| File scope | Multi-file changes, repo-wide conventions, a chunk that writes a multi-file workspace for copy-back | One file, one subsystem, one algorithm, or one targeted review pass |
| Need for independent perspective | Low to medium. You mostly want throughput and clean implementation. | High. You want a second model family or an adversarial opinion. |
| Project conventions | Strongly matters. Sonnet is the default for following established local patterns and producing clean workspace outputs. | Less about convention-following, more about precision and skepticism. |
| Output shape | A chunk workspace that copies back cleanly alongside siblings | A review report, a narrow patch, a risk assessment, or a deep focused diff |
| Typical role | Builder | Precision worker or reviewer |

### Choose Sonnet when

- The chunk touches several related files.
- The repo has strong conventions that should be mirrored.
- You want parallelizable implementation throughput.
- The output should copy back cleanly alongside sibling chunks.

### Choose Codex when

- The task benefits from an independent model perspective.
- You want adversarial review before or after integration.
- The risky part is narrow but subtle.
- You need a direct, highly scoped ask without loading a large narrative.

## Single-chunk delegation

A 1-chunk delegation to Sonnet or Codex is a valid pattern for three distinct reasons. Parallelism is one optimisation, but not the only one.

| Reason | Runner | Trigger |
|--------|--------|---------|
| **Fresh context window** | Sonnet (or Codex for deep algorithm) | Task would burn 40%+ of main-session context, force 5+ file reads, or hold a 500+ line working set |
| **Model fit / efficiency** | Sonnet | Task is mechanical / pattern-following / boilerplate — does not need Opus reasoning |
| **Independent perspective** | Codex, `--effort high` | Adversarial review, narrow precision fix, skeptical second opinion on a plan |
| **Apex reasoning** | Fable 5 (`model="fable"`) | Sub-problem harder than Opus 5 — multi-day autonomy stamina, SWE-bench-Pro-shaped repo judgment, blocker-conflict tie-break. 2× cost and a LOWER general-intelligence score than the seat; a lateral trade, never a reflex upgrade |

Use single-chunk delegation when:

- **Deep refactor in one module** (Sonnet) — fresh-context play. Clean cache and reasoning space.
- **Mechanical multi-file work** (Sonnet) — efficiency play. Rename a symbol across 3 files, mirror an existing endpoint, apply a lint fix, bump a dependency and patch call sites, generate a test from a clear spec, update copy across known files. Opus reasoning is not what makes this work succeed; Sonnet is faster and cheaper.
- **Adversarial review of one file or plan** (Codex, `--effort high`) — perspective play. This is the `/delegate review` use case.
- **Any single task >40% of remaining main-session budget** — fresh-context play, even with no sibling chunks.

### When NOT to delegate a single chunk

Keep in-session on Opus when the task needs orchestrator-level reasoning:

- Multi-file design decisions or architectural tradeoffs.
- Synthesising context the sub-agent doesn't have.
- Debugging where the failure mode is ambiguous.
- Reviewing or reconciling sub-agent output.
- Talking to the user, asking for clarification, surfacing risks.

The rule: ask "would Sonnet, given the same brief, produce the same or better result than Opus would?" If yes, delegate. If no, stay in-session.

## Anti-Patterns

### Delegating too eagerly

Bad pattern:
- A small single-file fix is decomposed into a manifest, two worker chunks, and a QA round.

Why it fails:
- Coordination cost dominates the actual work.
- You burn time writing prompts and merging trivial diffs.
- The main session gains no meaningful context relief.

Preferred action:
- Do the edit locally when the task is small and context is healthy.

### Delegating when context is low

Bad pattern:
- Context is at 15%, but the orchestrator fans out because delegation "feels scalable."

Why it fails:
- You spend more tokens on orchestration than implementation.
- You increase branch, merge, and prompt overhead with no quality gain.

Preferred action:
- Keep the work in session.
- Use direct edits and local verification.

### Parallel chunks on the same files

Bad pattern:
- Two Sonnet chunks both touch `src/auth/session.ts` and `src/auth/types.ts`.

Why it fails:
- Merge conflicts become likely, and even "clean" merges can be semantically wrong.
- Review gets harder because no single chunk owns the file.
- The parallelism is fake because one chunk logically depends on the other.

Preferred action:
- Make one chunk depend on the other with `depends_on`.
- Or redraw chunk boundaries so file ownership is exclusive.

## Worked Examples

### Example 1: Small single-file fix

Task:
- Fix an off-by-one bug in `src/pagination.ts`.
- Add one unit test in `src/pagination.test.ts`.

Routing decision:
- Do not delegate.

Why:
- Context is likely under 30%.
- The change is small and tightly local.
- The implementation and verification cost is lower than manifest + fan-out overhead.

Recommended execution:
- Read the two files.
- Patch them in the main session.
- Run the targeted test command.

### Example 1b: Mechanical multi-file rename (efficiency 1-chunk Sonnet)

Task:
- Rename `getUser` to `fetchUser` across the codebase (8 call sites in 5 files), update tests.

Routing decision:
- **1-chunk Sonnet sub-agent.** Not in-session on Opus.

Why:
- Context is healthy (<30%), so the old rule said "do it in session" — but the work is purely mechanical pattern-matching. Opus reasoning adds nothing here.
- A fresh Sonnet sub-agent with a tight brief executes faster, cheaper, and leaves the orchestrator's cache warm for the next decision.

Recommended execution:
- Orchestrator writes a short brief: project path, the rename, the test command.
- Single-chunk delegate run, `runner: sonnet-subagent`.
- Review the returned diff in the main session, apply, run QA.

### Example 2: Medium three-chunk feature

Task:
- Add API key management to an admin console.
- Requires backend endpoints, frontend settings UI, and audit-log integration.

Routing decision:
- Delegate to Sonnet subagents.

Suggested chunking:
1. Backend API chunk
   - Files: `server/routes/adminKeys.ts`, `server/services/keyService.ts`, tests
2. Frontend settings chunk
   - Files: `web/src/pages/AdminKeys.tsx`, `web/src/components/KeyTable.tsx`
3. Audit-log chunk
   - Files: `server/services/auditLog.ts`, `server/events/adminKeyEvents.ts`

Why Sonnet:
- Each chunk spans multiple files.
- All chunks should follow project conventions and return clean workspace outputs.
- The work is parallelizable if file ownership is clean.

Why not Codex:
- The value here is throughput, not an outside opinion.
- The chunk boundaries map naturally to conventional implementation work.

### Example 3: Large refactor with adversarial review

Task:
- Move a monolithic data-access layer to a repository pattern.
- Update services and tests across several modules.
- Validate that transaction handling and error propagation did not regress.

Routing decision:
- Mix Sonnet and Codex.

Suggested routing:
1. Sonnet chunk: repository interfaces and base implementations
2. Sonnet chunk: migrate service layer consumers
3. Sonnet chunk: update integration tests and fixtures
4. Codex chunk: adversarial review of transaction boundaries, failure modes, and missing tests

Why this mix works:
- Sonnet handles the broad multi-file refactor and produces clean workspace outputs.
- Codex provides a skeptical second pass that is not anchored to the same implementation assumptions.
- The main session copies back the chunk workspaces, reviews Codex findings, runs project QA, and decides whether to address review comments before presenting the result.

Practical note:
- The Codex review chunk should not race against files still changing underneath it.
- Run it after the implementation chunks land and copy back, or point it at the applied project snapshot.

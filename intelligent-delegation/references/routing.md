# Model Routing Decision Tree

This document explains how the orchestrator should decide between keeping work in the main Opus session, fanning out to Sonnet subagents, asking Codex for precision work, or using Haiku for cheap lookup. The goal is not to maximize delegation. The goal is to maximize output quality while keeping the main session lean and the prompt cache warm.

## Tier Table

> **Model layer refreshed 2026-07-27** for Claude Opus 5 (`claude-opus-5`, released 2026-07-24). Opus 5 takes the orchestrator seat from Opus 4.8 at identical pricing, and now *leads* Fable 5 on general intelligence and SWE-bench Verified with a four-month-fresher knowledge cutoff. Fable's escalation bar therefore **rose** — see SKILL.md → "Fable 5 routing". **Every figure lives in SKILL.md → "Model Facts"; this file carries none** (enforced by `scripts/check-model-facts.sh`).

| Tier | Model | Primary job | When to use it | What stays in session |
|------|-------|-------------|----------------|-----------------------|
| Orchestrator | **Opus 5** | Planning, decomposition, QA, reporting, user communication | Always. The main session owns the task, writes the manifest, approves fan-out, reviews outputs, and presents the result. | The full task narrative, tradeoffs, manifest state, QA status, and user-facing explanation stay here. |
| Apex reasoning | Fable 5 (delegate target — `Agent(model="fable")`) | The narrow class of sub-problem that still outruns Opus 5 | Escalate only for **multi-day-autonomy stamina** or **SWE-bench-Pro-shaped repo judgment**, and only once Opus 5 has visibly plateaued. 2× cost, and it scores *below* Opus 5 on general intelligence — this is a lateral trade, not an upgrade. A **target**, never the seat. | Only the Fable delegate's result (a manifest, a fix, a verdict) returns to the seat. |
| Planning | Opus 5 (Plan subagent) | Manifest authoring, decomposition design, multi-file refactor architecture | For non-trivial decompositions (>3 chunks or unfamiliar codebase). Frees the main session from holding planning context while keeping Opus reasoning quality. Research-grade cuts now stay on Opus 5 + ultrathink rather than escalating to Fable. | Only the final JSON manifest and Opus's review notes stay in the main session. |
| Build | **Opus 5 subagent** (fresh, own workspace); Sonnet 5 for wide fan-outs | Parallel implementation chunks | Independent chunks that touch multiple files, follow repo conventions, and write clean outputs into their workspace for copy-back. Default to Opus 5 when per-chunk quality dominates; drop to Sonnet 5 for wide (>~6) tightly-specified fan-outs where wall-clock and cost matter more. | Only the chunk prompt, its workspace, and the chunk result live in the subagent. Main-session knowledge does not carry over. |
| Cheap parallel | Haiku 4.5 subagent (`model="haiku"`) | High-volume narrow text/data chunks | Classify/tag, format-convert, bulk mechanical edits, per-row enrichment — where verification is trivial (schema/string/lint). Volume-and-latency play, not a cost play. | Only the structured outputs return; the orchestrator collates. |
| Large-context | **Opus 5 1M** via CLI subprocess (`opus-1m-cli`, `--model claude-opus-5`) | A single chunk with a >150K read surface | Monorepo-wide review, big PDF/transcript ingest, multi-hundred-file analysis. Native 1M window at standard pricing; never the orchestrator seat. | Only the chunk's result/verdict returns. |
| Precision / cross-family | Codex GPT-5.6 Sol (`gpt-5.6-sol`, effort `high`/`xhigh`) | Adversarial review, deep algorithms, long terminal/tool-loop grind | Second opinion from a different model family. Never Terra (measured review-recall regression) or Luna (duplicates Haiku's lane). Never accept its self-reported pass — METR measured Sol with the highest detected reward-hacking rate of any public model they've assessed. | Codex reads the repo fresh; keep only the ask, the result, and review findings. |
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

## Seat topology — why Opus 5 holds the orchestrator seat

> Moved here from SKILL.md 2026-07-30 (R10 economy pass). SKILL.md carries the *rule*; this is the evidence behind it. All figures live in SKILL.md → **Model Facts** — do not restate them here (`scripts/check-model-facts.sh` enforces it).

**The question, re-settled 2026-07-27 after Opus 5.** The old framing was "Fable is a tier above Opus at 2× the price, but the seat still stays Opus." Opus 5 broke the premise, not just the conclusion: Fable is no longer straightforwardly above the seat. Anthropic's docs still *name* Fable "the most capable widely released model", but their own routing line is now "start with Claude Opus 5 for complex agentic coding and enterprise work". Both are true — Fable keeps the highest ceiling on a narrow class of problem; Opus 5 wins or ties nearly everything else at half the cost.

| Argument | Detail |
|----------|--------|
| **It is now the more intelligent seat outright** | The strongest argument, and the new one. Under Opus 4.8 the seat was a deliberate step *down* from the apex, justified by cost and latency. Opus 5 removes the sacrifice: it tops the intelligence index, wins SWE-bench Verified and the agentic-coding benchmarks, and knows four more months of the world. Seating Opus 5 is no longer a trade-off to defend — it is the default a Fable seat has to beat. |
| **The seat pays its premium on *every* turn** | The orchestrator is the longest-lived component — in context for the whole session, including the great majority of turns that are pure coordination (init, mark running, collect, apply, present, re-read `state.tsv`). Seat Fable and you pay double on all of them, for a model scoring lower on general intelligence. |
| **Orchestration is agentic, and Opus 5 is the agentic flagship** | Anthropic positions Opus 5 for complex agentic coding — exactly the orchestrator's job (decompose, hold the narrative, sequence waves, reconcile). Fable's surviving edge is multi-day autonomous stamina: a delegate-shaped need (one brutal long-running sub-problem), not a coordination-shaped one. |
| **The seat's knowledge cutoff is load-bearing** | The orchestrator reasons about *current* tooling, APIs, and model choices — SKILL.md's own Model Facts block is the proof. Fable's cutoff predates Opus 5's own existence. A seat that doesn't know the lineup it is routing is the wrong seat. |
| **Apex reasoning belongs where verification *can't* catch the error — and that's specific gates, not the whole seat** | The strongest pro-Fable case: orchestrator mistakes (a bad decomposition, a wrong reconciliation verdict) aren't caught by a `verification` command, so put the best brain there. True — but those are a handful of *gates*, not the whole session. Escalate the gates; don't seat Fable for the mechanical majority. |
| **Latency is hidden in delegates, exposed in the seat** | An apex flagship is slower per token. The seat is the interactive surface that talks to the user — the worst place to absorb latency. Delegates run in the background behind parallelism, where latency is free. |

**The one carve-out where Fable may take the seat.** The "seat pays the premium on every coordination turn" argument assumes a session with lots of cheap coordination subsidised by a few hard calls. When that assumption fails — a **short, uniformly-hard** task where the decomposition is research-grade and there is almost no mechanical overhead to dilute — seating Fable is defensible. It narrowed under Opus 5: "the decomposition is research-grade" is no longer sufficient on its own, because Opus 5 out-reasons Fable on general intelligence. The remaining justification is **stamina**. State the trade-off out loud and get an explicit yes, exactly like the 1M flip — never a unilateral flip.

## Codex GPT-5.6 — the evidence behind the Sol-only rule

> Moved here from SKILL.md 2026-07-30. Figures live in SKILL.md → **Model Facts**.

- **Terra is banned for review**, not deprioritised: it measurably regresses on adversarial-review actionable recall against a production harness, and is token-verbose on long-horizon work (roughly half the pass rate at more than double the output tokens). Luna duplicates Haiku's lane cross-family, so it earns no separate seat here.
- **Sol is a credible cross-family second opinion at near-apex depth** — but since Opus 5 it is no longer within noise of *leading*. Its surviving edge is the terminal/tool-loop grind and ARC-AGI-shaped puzzle work, and even there the margin is around a point. Route on the lane, not the decimal.
- **Cluster read (coding-agent index, replotted widely in July 2026).** The index forms three cost-efficiency clusters: Luna (budget leader), Terra (value frontier), Sol (premium, top absolute score). That framing is *price-adjusted*; if you are routing on the absolute ceiling rather than value-per-dollar, only the top score matters. Consequence: **Sol at its maximum configuration is permitted for standalone wholesale Codex tasks** where Codex owns the whole job and its internal fan-out orchestrates nothing but itself. The `ultra` ban stays absolute *inside delegate-run chunks* — a contract rule, not a quality one. Terra's value-frontier win does not rehabilitate it: price-adjusted only, and it still loses outright on long-horizon quality and review recall.

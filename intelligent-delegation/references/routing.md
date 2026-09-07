# Model Routing Decision Tree

This document explains how the orchestrator should decide between keeping work in the main Opus session, fanning out to Sonnet subagents, asking Codex for precision work, or using Haiku for cheap lookup. The goal is not to maximize delegation. The goal is to maximize output quality while keeping the main session lean and the prompt cache warm.

## Tier Table

> **Model layer refreshed 2026-09-03** for Claude Fable 5.1 (`claude-fable-5-1`) — the newest Claude 5 model, Mythos-class, generally available, and above Opus 5 in capability. Fable takes the orchestrator seat **while Fable budget lasts**; Opus 5 takes it back the moment the meter runs out, and nothing else in the flow changes. Claude Mythos 5.1 (`claude-mythos-5-1`) is the same underlying model, restricted to approved organisations. What gates Fable now is metering, not capability — see SKILL.md → "Fable 5.1 routing" and "Fable budget". **Every figure lives in SKILL.md → "Model Facts"; this file carries none** (enforced by `scripts/check-model-facts.sh`).

| Tier | Model | Primary job | When to use it | What stays in session |
|------|-------|-------------|----------------|-----------------------|
| Orchestrator | **Fable 5.1 while Fable budget lasts, else Opus 5** | Planning, decomposition, QA, reporting, user communication | Always. The main session owns the task, writes the manifest, approves fan-out, reviews outputs, and presents the result. Orchestration is where an error escapes every `verification` command, so the apex tier holds the seat while the meter allows; when it runs out the seat drops to Opus 5 and the run continues unchanged. | The full task narrative, tradeoffs, manifest state, QA status, and user-facing explanation stay here. |
| Apex reasoning | Fable 5.1 (delegate target — `Agent(model="fable")`) | The class of sub-problem above Opus 5's band | Escalate for **long-horizon autonomy**, **hardest-repo judgment**, a **plateaued correctness cut**, or a **blocker tie-break**. Fable sits above Opus in capability, so this is a real upgrade — but usage is metered and finite, so name the lane before spawning and never spend it on mechanical, scoped, or replicated work. | Only the Fable delegate's result (a manifest, a fix, a verdict) returns to the seat. |
| Planning | Opus 5 (Plan subagent) | Manifest authoring, decomposition design, multi-file refactor architecture | For non-trivial decompositions (>3 chunks or unfamiliar codebase). Frees the main session from holding planning context while keeping Opus reasoning quality. A research-grade cut may go to a Fable Plan delegate — but only after in-seat ultrathink has demonstrably plateaued, because ultrathink is free and the meter is not. | Only the final JSON manifest and the review notes stay in the main session. |
| Build | **Opus 5 subagent** (fresh, own workspace); Sonnet 5 for wide fan-outs | Parallel implementation chunks | Independent chunks that touch multiple files, follow repo conventions, and write clean outputs into their workspace for copy-back. Quality-first default is Opus 5; drop to Sonnet 5 only for wide (>~6) tightly-specified fan-outs where wall-clock matters. | Only the chunk prompt, its workspace, and the chunk result live in the subagent. Main-session knowledge does not carry over. |
| Cheap parallel | Haiku 4.5 subagent (`model="haiku"`) | High-volume narrow text/data chunks | Classify/tag, format-convert, bulk mechanical edits, per-row enrichment — where verification is trivial (schema/string/lint). Volume-and-latency play, not a cost play. | Only the structured outputs return; the orchestrator collates. |
| Large-context | **Opus 5 1M** via CLI subprocess (`opus-1m-cli`, `--model claude-opus-5`) — the CLI authenticates separately from your session; **probe the login before routing** (SKILL.md → 1M Context Routing) | A single chunk with a >150K read surface | Monorepo-wide review, big PDF/transcript ingest, multi-hundred-file analysis. Native 1M window at standard pricing; never the orchestrator seat. | Only the chunk's result/verdict returns. |
| Precision / cross-family | **Codex GPT-6 Astra** for adversarial review and terminal grind (pin an effort — it defaults to the bottom of the ladder); Sol for a second model family, `gpt-5.5` if neither serves — availability has flipped repeatedly, so check `~/.codex/models_cache.json` before routing | Adversarial review, deep algorithms, long terminal/tool-loop grind | Second opinion from a different model family. Never Terra (measured review-recall regression) or Luna (duplicates Haiku's lane). Never accept its self-reported pass — METR measured Sol with the highest detected reward-hacking rate of any public model they've assessed. | Codex reads the repo fresh; keep only the ask, the result, and review findings. |
| Integration | Opus 5 (main session, in-line) | Integration glue, cross-cutting edits, sibling-chunk coordination | Chunks that genuinely need orchestrator context — package.json edits, root config changes, glue between sibling chunks. Use sparingly. | The full chunk implementation lives in-session since it executes in-context. |
| Lookup | Haiku 4.5 explore subagent | Fast file discovery and lightweight searches | Use for grep-like tasks, symbol discovery, finding entry points, or locating candidate files before deciding where build work belongs. | Only the extracted facts and file paths should be carried back. Haiku should not own implementation context. |

## Decision Tree

1. Start with the context budget.
2. Decide whether the task is truly independent work or just one local edit.
3. If delegation is justified, split by file ownership boundaries first.
4. Pick Sonnet when the chunk should produce a conventional repo diff.
5. Pick Codex when you want an independent model perspective or a narrow precision task.
6. **Before defaulting to "in-session", check model fit — both directions.** *Down:* mechanical / pattern-following / boilerplate work routes to a 1-chunk Sonnet sub-agent even if context is healthy and there is no fan-out value. *Up:* a sub-problem above Opus 5's band (long-horizon autonomy, hardest-repo judgment, a plateaued correctness cut, a blocker-conflict tie-break) escalates to a Fable 5.1 delegate — a named, evidenced call, not a reflex, because the tier is metered. The seat is reserved for design, tradeoffs, synthesis, orchestration, and user communication.
7. Route any chunk whose *read surface* exceeds ~150K tokens to `opus-1m-cli` (a fresh 1M Opus 5 subprocess) — decomposition first if it splits cleanly; 1M only for genuinely irreducible surfaces. Never bloat the orchestrator seat. Probe the CLI login before you commit a chunk to this runner; when it is shut, decomposition is the fallback, not escalation.
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
| **Apex reasoning** | Fable 5.1 (`model="fable"`) | Sub-problem above Opus 5's band — long-horizon autonomy, hardest-repo judgment, a plateaued correctness cut, a blocker-conflict tie-break. A real upgrade, but metered: name the lane, and never spend it on mechanical, scoped, or replicated work |

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

## Seat topology — Fable 5.1 holds the seat until the meter says otherwise

> Moved here from SKILL.md 2026-07-30 (R10 economy pass); re-settled 2026-09-03 for Fable 5.1. SKILL.md carries the *rule*; this is the reasoning behind it. All figures live in SKILL.md → **Model Facts** — do not restate them here (`scripts/check-model-facts.sh` enforces it).

**The question, re-settled after Fable 5.1.** Under Fable 5 the seat argument turned on capability: Opus 5 had caught and passed Fable, so seating Fable bought nothing. Fable 5.1 reverses that premise — it is the newest Claude 5 model, Mythos-class, generally available, and above Opus 5 in capability. The seat argument therefore stops being about which model is better and becomes about **where a finite meter is best spent**.

| Argument | Detail |
|----------|--------|
| **The seat is where verification can't catch the error** | A bad decomposition or a wrong reconciliation verdict fails no test and trips no `verification` command — it silently wastes the entire fan-out. That is the single strongest case for putting the most capable model somewhere, and it points at the seat. |
| **The seat is one instance, not N** | A fan-out spends the apex tier once per chunk; the seat spends it once per run. Seating Fable is the cheapest way to buy apex judgment at the gates that matter, precisely because coordination turns are short. |
| **Orchestration is agentic and long-horizon** | Decompose, hold the narrative, sequence waves, reconcile reviews — long-horizon coherence is a Fable strength, and the orchestrator is the longest-lived component in the run. |
| **But the meter is real** | Fable usage runs out. A session that seats Fable and then also fans out `fable-subagent` chunks for work Opus 5 handles will exhaust the budget before it reaches the chunk that needed it. The seat is the standing exception to the budget rule; everything else has to earn the lane. |
| **Latency is exposed in the seat** | An apex flagship is slower per token, and the seat is the interactive surface. This is the one genuine cost of seating Fable — worth paying at the gates, not worth pretending away. |
| **Exhaustion is a non-event** | When Fable runs out, Opus 5 takes the seat. No part of the six-question triage, the manifest contract, the runner enum, or the QA gates depends on Fable being present. Say it in one line and carry on; never downgrade below Opus 5, and never stall to ask. |

**The user still owns the seat.** A user who wants the seat on Opus 5 with Fable reserved entirely for delegates is making a legitimate budget call — take it, and route `fable-subagent` on named lanes only. What is never acceptable is a silent drop below Opus 5, or a silent Fable burn on work that never needed it.

## GPT-6 Astra — screen driving, terminal grind, and now review

> Added 2026-09-04 as a lane held open; **opened 2026-09-07** when the account began serving it. Figures live in SKILL.md → **Model Facts**.

The reason to write the lane down carefully is that the headline framing ("generational leap", "the AGI era") invites a reflex upgrade of every Codex chunk, and the measurements do not support one. Astra's evidenced strength is **computer use and terminal grind**; on general intelligence it sits level with Opus 5, and it publishes no repo-judgment score at all. So it displaces **Terra** on the `codex-cu.sh` screen-driving lane, and — corrected 7 Sep 2026 — it also displaces **Sol** on adversarial review, because the only published head-to-head puts it ahead on actionable bug coverage and further ahead on cross-file findings. Judgment and planning stay where they are: Astra is level with Opus 5 on general intelligence and publishes no repo-judgment score at all.

Four traps, each one earned by a probe rather than by reading the launch post. Its terminal benchmark is a **different version** from the one the Sol/Terra rows use and cannot be cross-read. Its ARC-AGI headline comes off a stateful bespoke harness, not stateless API calls. Its **usable read surface through the CLI is far smaller than the launch coverage implies**, so it is not the large-surface tool — that stays `opus-1m-cli`. And it **defaults to the lowest effort on the ladder**, so an unpinned call quietly buys the flagship at its shallowest.

On availability: Astra was entitled *before* it appeared in the models cache, and the 400 it returned in between said the client was too old rather than that access was missing. The cache is a floor, not a ceiling — when a slug matters, probe it and read the error text.

## Codex GPT-5.6 — the evidence behind the Sol lane

> Moved here from SKILL.md 2026-07-30. Figures live in SKILL.md → **Model Facts**.

- **Terra is banned for review**, not deprioritised: it measurably regresses on adversarial-review actionable recall against a production harness, and is token-verbose on long-horizon work (roughly half the pass rate at more than double the output tokens). Luna duplicates Haiku's lane cross-family; under quality-first, "budget cluster" is not a lane.
- **Sol left the account on 12 Aug 2026 and returned on 4 Sep 2026** (probed serving). It is the default Codex target again; `gpt-5.5` is the fallback, and `delegate.sh` now retries on it automatically when a run 400s with *"is not supported when using Codex"*.
- **Sol is a credible cross-family second opinion at near-apex depth** — but since Opus 5 it is no longer within noise of *leading*. Its surviving edge is the terminal/tool-loop grind and ARC-AGI-shaped puzzle work, and even there the margin is around a point. Route on the lane, not the decimal.
- **Cluster read (coding-agent index, replotted widely in July 2026).** The index forms three cost-efficiency clusters: Luna (budget leader), Terra (value frontier), Sol (premium, top absolute score). That framing is *price-adjusted*; under QUALITY-FIRST only the absolute ceiling matters. Consequence: **Sol at its maximum configuration is permitted for standalone wholesale Codex tasks** where Codex owns the whole job and its internal fan-out orchestrates nothing but itself. The `ultra` ban stays absolute *inside delegate-run chunks* — a contract rule, not a quality one. Terra's value-frontier win does not rehabilitate it: price-adjusted only, and it still loses outright on long-horizon quality and review recall.

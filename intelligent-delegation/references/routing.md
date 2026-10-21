# Model Routing Decision Tree

This document explains how the orchestrator should decide between keeping work in the main Opus session, fanning out to Sonnet subagents, asking Codex for precision work, or using Haiku for cheap lookup. The goal is not to maximize delegation. The goal is to maximize output quality while keeping the main session lean and the prompt cache warm.

## Tier Table

> **Model layer refreshed 2026-10-19** for Claude Opus 5.5 (`claude-opus-5-5`), Sonnet 5.5 (`claude-sonnet-5-5`) and Haiku 5.5 (`claude-haiku-5-5`), which supersede Opus 5, Sonnet 5 and Haiku 4.5 (history) in every lane below. The Agent tool's `opus` / `sonnet` / `haiku` aliases resolve to the 5.5 tiers. ⚠️ **The Fable-seat reasoning below is PENDING RE-EVALUATION:** it rests on Fable 5.1 being above Opus, and Anthropic's own Opus 5.5 launch table puts Opus 5.5 ahead of Fable 5.1 on every row it publishes (SKILL.md → Model Facts → 5.5-generation table), while Anthropic's docs still position Fable 5.1 as the step up when Opus 5.5 at higher effort falls short. Until it is re-settled, read "above Opus's band" as "after Opus 5.5 at high effort has visibly fallen short".
>
> *Previous refresh, 2026-09-03 (history):* Claude Fable 5.1 (`claude-fable-5-1`) — the newest Claude 5 model, Mythos-class, generally available, and above Opus 5 in capability. Fable takes the orchestrator seat **while Fable budget lasts**; Opus 5 takes it back the moment the meter runs out, and nothing else in the flow changes. Claude Mythos 5.1 (`claude-mythos-5-1`) is the same underlying model, restricted to approved organisations. What gates Fable now is metering, not capability — see SKILL.md → "Fable 5.1 routing" and "Fable budget". **Every figure lives in SKILL.md → "Model Facts"; this file carries none** (enforced by `scripts/check-model-facts.sh`).

| Tier | Model | Primary job | When to use it | What stays in session |
|------|-------|-------------|----------------|-----------------------|
| Orchestrator | **Opus 5.5** (Fable 5.1 is never the seat — delegate only) | Planning, decomposition, QA, reporting, user communication | Always. The main session owns the task, writes the manifest, approves fan-out, reviews outputs, and presents the result. Orchestration is where an error escapes every `verification` command, so the apex tier holds the seat while the meter allows; when it runs out the seat drops to Opus 5.5 and the run continues unchanged. | The full task narrative, tradeoffs, manifest state, QA status, and user-facing explanation stay here. |
| Apex reasoning | Fable 5.1 (delegate target — `Agent(model="fable")`) | The class of sub-problem above Opus 5.5's band | Escalate for **long-horizon autonomy**, **hardest-repo judgment**, a **plateaued correctness cut**, or a **blocker tie-break**. Whether Fable still sits above Opus 5.5 is pending re-evaluation (SKILL.md → Model Facts) — and usage is metered and finite, so name the lane before spawning and never spend it on mechanical, scoped, or replicated work. | Only the Fable delegate's result (a manifest, a fix, a verdict) returns to the seat. |
| Planning | Opus 5.5 (Plan subagent) | Manifest authoring, decomposition design, multi-file refactor architecture | For non-trivial decompositions (>3 chunks or unfamiliar codebase). Frees the main session from holding planning context while keeping Opus reasoning quality. A research-grade cut may go to a Fable Plan delegate — but only after in-seat ultrathink has demonstrably plateaued, because ultrathink is free and the meter is not. | Only the final JSON manifest and the review notes stay in the main session. |
| Build | **Opus 5.5 subagent** (fresh, own workspace); Sonnet 5.5 for wide fan-outs | Parallel implementation chunks | Independent chunks that touch multiple files, follow repo conventions, and write clean outputs into their workspace for copy-back. Quality-first default is Opus 5.5; drop to Sonnet 5.5 only for wide (>~6) tightly-specified fan-outs where wall-clock matters. | Only the chunk prompt, its workspace, and the chunk result live in the subagent. Main-session knowledge does not carry over. |
| Cheap parallel | Haiku 5.5 subagent (`model="haiku"`) | High-volume narrow text/data chunks | Classify/tag, format-convert, bulk mechanical edits, per-row enrichment — where verification is trivial (schema/string/lint). Volume-and-latency play, not a cost play. | Only the structured outputs return; the orchestrator collates. |
| Large-context | **Opus 5.5 1M** via CLI subprocess (`opus-1m-cli`, `--model claude-opus-5-5`) — the CLI authenticates separately from your session; **probe the login before routing** (SKILL.md → 1M Context Routing) | A single chunk with a >150K read surface | Monorepo-wide review, big PDF/transcript ingest, multi-hundred-file analysis. Native 1M window at standard pricing; never the orchestrator seat. | Only the chunk's result/verdict returns. |
| Codex default | **`gpt-6.1-sol`, effort `medium` (Sol Medium; Sol Light for trivial edits)** | Code builds, renders, refactors, scraping, distillation, mechanical spec/doc edits, data wrangling | Default Codex target; `gpt-5.5` fallback when a target 400s. Lane from Codex's own description and owner decision; no published benchmarks checked. | Codex reads the repo fresh; keep only the ask, result and verification findings. |
| Codex specialist / cross-family | **`gpt-6-astra`, always pin effort `high`, `xhigh` for the hardest** | Adversarial review, screen-driving / `codex-cu.sh`, long terminal grind, nuanced editorial/copy rewriting where voice quality matters | Named specialist lanes; not a default upgrade. Independently verify results; the historical reward-hacking measurement was GPT-5.6 Sol, not the new workhorse. | Keep only the ask, result and review findings. |
| Codex volume (floor) | **`gpt-6-luna`, effort `high`** — the lowest model and effort ever used | Simple, high-volume, easily verified tasks only | Never long-context reads. Usable recall is unmeasured; GPT-5.6 Luna's historical recall does not measure GPT-6 Luna. | Only verified structured outputs return. |
| Integration | Opus 5.5 (main session, in-line) | Integration glue, cross-cutting edits, sibling-chunk coordination | Chunks that genuinely need orchestrator context — package.json edits, root config changes, glue between sibling chunks. Use sparingly. | The full chunk implementation lives in-session since it executes in-context. |
| Lookup | Haiku 5.5 explore subagent | Fast file discovery and lightweight searches | Use for grep-like tasks, symbol discovery, finding entry points, or locating candidate files before deciding where build work belongs. | Only the extracted facts and file paths should be carried back. Haiku should not own implementation context. |

## Decision Tree

1. Start with the context budget.
2. Decide whether the task is truly independent work or just one local edit.
3. If delegation is justified, split by file ownership boundaries first.
4. Pick Sonnet when the chunk should produce a conventional repo diff.
5. Pick Codex when you want an independent model perspective or a narrow precision task.
6. **Before defaulting to "in-session", check model fit — both directions.** *Down:* mechanical / pattern-following / boilerplate work routes to a 1-chunk Sonnet sub-agent even if context is healthy and there is no fan-out value. *Up:* a sub-problem above Opus 5.5's band (long-horizon autonomy, hardest-repo judgment, a plateaued correctness cut, a blocker-conflict tie-break) escalates to a Fable 5.1 delegate — a named, evidenced call, not a reflex, because the tier is metered. The seat is reserved for design, tradeoffs, synthesis, orchestration, and user communication.
7. Route any chunk whose *read surface* exceeds ~150K tokens to `opus-1m-cli` (a fresh 1M Opus 5.5 subprocess) — decomposition first if it splits cleanly; 1M only for genuinely irreducible surfaces. Never bloat the orchestrator seat. Probe the CLI login before you commit a chunk to this runner; when it is shut, decomposition is the fallback, not escalation.
8. Keep integration, conflict decisions, QA, and user communication in the main Opus 5.5 session.

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
| **Independent perspective** | Codex `gpt-6-astra`, `--effort high` | Adversarial review, narrow precision fix, skeptical second opinion on a plan |
| **Apex reasoning** | Fable 5.1 (`model="fable"`) | Sub-problem above Opus 5.5's band — long-horizon autonomy, hardest-repo judgment, a plateaued correctness cut, a blocker-conflict tie-break. Pending re-evaluation against Opus 5.5, and metered: name the lane, and never spend it on mechanical, scoped, or replicated work |

Use single-chunk delegation when:

- **Deep refactor in one module** (Sonnet) — fresh-context play. Clean cache and reasoning space.
- **Mechanical multi-file work** (Sonnet) — efficiency play. Rename a symbol across 3 files, mirror an existing endpoint, apply a lint fix, bump a dependency and patch call sites, generate a test from a clear spec, update copy across known files. Opus reasoning is not what makes this work succeed; Sonnet is faster and cheaper.
- **Adversarial review of one file or plan** (Codex `gpt-6-astra`, `--effort high`) — perspective play. This is the `/delegate review` use case.
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

## Seat topology — Opus 5.5 holds the seat; Fable 5.1 is a delegate

> Moved here from SKILL.md 2026-07-30 (R10 economy pass); re-settled 2026-09-03 for Fable 5.1; **decided 2026-10-19 by the user: Opus 5.5 seat, Fable for sub-problem escalation only.** SKILL.md carries the *rule*; this is the reasoning behind it. All figures live in SKILL.md → **Model Facts** — do not restate them here (`scripts/check-model-facts.sh` enforces it).

**History.** Under Fable 5 the seat argument turned on capability: Opus 5 had caught and passed Fable, so seating Fable bought nothing. Fable 5.1 reversed that premise against Opus 5, and from 2026-09-03 Fable held the seat while its budget lasted. **Opus 5.5 (2026-09-22) reversed it again** — Anthropic's own launch table puts Opus 5.5 ahead of Fable 5.1 on every published row — and on 2026-10-19 the seat moved to Opus 5.5 for good.

| Argument | Detail |
|----------|--------|
| **The seat is where verification can't catch the error** | A bad decomposition or a wrong reconciliation verdict fails no test and trips no `verification` command. That still argues for the strongest *seat-shaped* model — and on the published evidence that is Opus 5.5, not Fable 5.1. Force ultrathink at the decomposition gate for the hard cuts. |
| **The meter belongs to sub-problems** | Fable usage runs out. Every coordination turn a seated Fable takes is budget that never reaches the long-horizon grind or the plateaued correctness cut that actually needed it. Keeping Fable off the seat keeps the whole budget for named `fable-subagent` lanes. |
| **Latency is exposed in the seat** | Fable is the slower tier, and the seat is the interactive surface. Opus 5.5 keeps the conversation responsive. |
| **Exhaustion is a non-event** | When Fable runs out, the `fable-subagent` lane closes and nothing else moves — the seat was never Fable. No part of the six-question triage, the manifest contract, the runner enum, or the QA gates depends on Fable being present. |

**The user owns the seat.** The current call (2026-10-19) is Opus 5.5 in the seat with Fable reserved for delegates on named lanes. What is never acceptable is a silent drop below Opus 5.5, a silent move of the seat to Fable, or a Fable burn on work that never needed it.

## GPT-6 Astra — review, screen driving, terminal grind, and nuanced rewriting

> Added 2026-09-04 as a lane held open; **opened 2026-09-07** when the account began serving it. Figures live in SKILL.md → **Model Facts**.

**Routing refreshed 2026-10-22** from `~/.codex/models_cache.json` (re-read), owner-reported serving probes that day with codex-cli `0.163.0-alpha.10.2`, and owner-approved lanes. Exact cache quotes and probe results live in SKILL.md → **Model Facts**. `gpt-6.1-sol` at effort `high` is the default Codex target. Astra holds **adversarial review, screen-driving / `codex-cu.sh`, long terminal grind, and nuanced editorial/copy rewriting where voice quality matters**. Always pin effort `high`, `xhigh` for the hardest. It is **not a default upgrade**; the historical comparisons below do not measure Astra against GPT-6.1 Sol. `gpt-6-luna` is for simple, high-volume, easily verified tasks only; never long-context reads, because usable recall is unmeasured. `gpt-5.5` is the fallback on a target 400; it is absent from this cache and was not re-probed here. `gpt-6-sol` has no lane; GPT-5.6 Sol/Terra/Luna are superseded for default routing. No published benchmarks checked for GPT-6.1 Sol or GPT-6 Luna.

Four traps, each one earned by a probe rather than by reading the launch post. Its terminal benchmark is a **different version** from the one the Sol/Terra rows use and cannot be cross-read. Its ARC-AGI headline comes off a stateful bespoke harness, not stateless API calls. Its **usable read surface through the CLI is far smaller than the launch coverage implies**, so it is not the large-surface tool — that stays `opus-1m-cli`. And it **defaults to the lowest effort on the ladder**, so an unpinned call quietly buys the flagship at its shallowest.

On availability: Astra was entitled *before* it appeared in the models cache, and the 400 it returned in between said the client was too old rather than that access was missing. The cache is a floor, not a ceiling — when a slug matters, probe it and read the error text.

## Codex GPT-5.6 — historical evidence (superseded for default routing)

> Moved here from SKILL.md 2026-07-30. **Superseded for default routing 2026-10-22; historical notes below are not current lanes.** Figures live in SKILL.md → **Model Facts**.

- **Terra is banned for review**, not deprioritised: it measurably regresses on adversarial-review actionable recall against a production harness, and is token-verbose on long-horizon work (roughly half the pass rate at more than double the output tokens). Luna duplicates Haiku's lane cross-family; under quality-first, "budget cluster" is not a lane.
- **Sol left the account on 12 Aug 2026 and returned on 4 Sep 2026** (probed serving). It became the default Codex target again then; that routing is now superseded by `gpt-6.1-sol`. `gpt-5.5` remains the owner-approved fallback on a target 400; `delegate.sh` does not implement an automatic retry.
- **Sol is a credible cross-family second opinion at near-apex depth** — but since Opus 5 (historical; not re-measured against Opus 5.5) it is no longer within noise of *leading*. Its surviving edge is the terminal/tool-loop grind and ARC-AGI-shaped puzzle work, and even there the margin is around a point. Route on the lane, not the decimal.
- **Cluster read (coding-agent index, replotted widely in July 2026).** The index forms three cost-efficiency clusters: Luna (budget leader), Terra (value frontier), Sol (premium, top absolute score). That framing is *price-adjusted*; under QUALITY-FIRST only the absolute ceiling matters. Consequence: **Sol at its maximum configuration is permitted for standalone wholesale Codex tasks** where Codex owns the whole job and its internal fan-out orchestrates nothing but itself. The `ultra` ban stays absolute *inside delegate-run chunks* — a contract rule, not a quality one. Terra's value-frontier win does not rehabilitate it: price-adjusted only, and it still loses outright on long-horizon quality and review recall.

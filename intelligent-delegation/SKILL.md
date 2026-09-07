---
name: intelligent-delegation
description: >
  Triage non-trivial tasks for delegation before implementation. Use at the start
  of a complex task and re-run when scope expands, the topic pivots, work can run
  independently, the read surface is large, or another model is a better fit.
  Trigger explicitly on "delegate", "fan out", "parallel build", "decompose this
  task", "hand off to Codex", multi-part builds, or follow-ups such as "also do
  X" and "apply the same to Y". Evaluate scope, context, fresh-window needs,
  parallelism, large-surface handling, and model fit. Skip conversational
  replies, simple status checks, single-line edits, and one-file lookups.
allowed-tools: Bash, Read, Grep, Glob, Write, Edit, Agent, TaskOutput
---

# Intelligent Delegation

> Paths below use `{base}` as shorthand for this skill's base directory, provided automatically at the top of the prompt when the skill loads.

You are the **orchestrator**. Your job: decompose, delegate, collect, verify, present. You do not implement chunks yourself — that's what sub-sessions and Codex are for. You hold the context, own the QA gate, and report back.

**No git required.** Project directories, plain folders, Notion exports, scratch dirs — anything works. State lives in a tmp run dir, not in branches.

## Upfront Triage — run this BEFORE touching anything

**The single most important behaviour in this skill.** When any non-trivial task arrives — before reading files, spawning Explore subagents, writing code, or fanning out — run this 5-second check. The point is to catch delegation candidates BEFORE the main session burns context, not after.

**The six questions:**

1. **Scope** — does the task touch 2+ independent files, features, or deliverables?
2. **Context** — would in-session execution likely burn >30% of remaining context?
3. **Fresh-window** — would a single deep task benefit from a fresh prompt cache + clean reasoning surface? (Deep refactor in one module, adversarial review of one file, anything that would otherwise eat 40%+ of main-session context.)
4. **Parallelism** — are there 2+ independent units that could execute concurrently?
5. **Large-surface (1M context fit)** — does the chunk's *required read surface* exceed roughly 150K tokens? Monorepo-wide review, large PDF/transcript ingest, multi-hundred-file analysis, log forensics across days. If yes, this chunk routes to a **1M-context Opus 5 subprocess** (`claude -p ... --model claude-opus-5`, native 1M window) — not a regular Sonnet/Opus subagent. Subagent context is bounded; 1M is the right tool. See "1M Context Routing" below.
6. **Model fit** — *only ask this if 1–5 are all no.* Two directions. **Down:** does the task genuinely need Opus-level reasoning (multi-file design, architectural tradeoffs, ambiguous spec, nuanced review)? If not, delegate it to a single Sonnet or Codex sub-agent for efficiency. **Up:** is the task *above Opus 5's band* — hardest-repo judgment, a long-horizon autonomy grind, or the subtlest correctness problem where Opus 5 has plateaued? If so, escalate that sub-problem to a **Fable 5.1** delegate (see "Fable 5.1 routing"). Fable sits above Opus in capability, so this is a real upgrade — but Fable usage is **metered and runs out**, so it stays a named, evidenced call, never a reflex (see "Fable budget"). Most work sits in Opus 5's band and stays in-session.

**The decision rule:**

- **ANY of 1–4 yes** → start the delegate flow. `/delegate plan "<task>"` for non-obvious decompositions, `/delegate run "<task>"` once you have the manifest. For a single deep task, a 1-chunk delegate run to Sonnet or Codex still wins on fresh context — parallelism is an optimisation, fresh-context is the primary value.
- **Q5 yes (large-surface)** → route THAT chunk (or the whole task if it's a 1-chunk job) to a **1M-context Opus 5 subprocess**. Do NOT flip the orchestrator session to 1M — keep the seat lean. The chunk runs as a Bash subprocess: `claude -p "<self-contained prompt>" --model claude-opus-5 --permission-mode plan`. See "1M Context Routing" for the full pattern.
- **1–5 all no, but Opus reasoning NOT required** → still delegate, but as an *efficiency* 1-chunk run, not a parallelism run. Route to Sonnet sub-agent (mechanical edits, boilerplate, clear-pattern work, simple refactors, generation from a tight spec) or Codex (single-file adversarial review, narrow precision fix). The orchestrator (Opus) writes the brief, delegates, reviews the returned diff. Do NOT burn Opus on work that Sonnet or Codex would do better and cheaper.
- **1–5 all no AND Opus reasoning required** → proceed in-session. Log the call in one line so the user can override.
- **Per-chunk apex check (fan-out runs).** Q6 gates on "1–5 all no", so a run that already triggered on scope/parallelism skips the top-level model-fit question. Re-apply its *upward* direction during decomposition: if any individual chunk sits above Opus 5's band (a long-horizon autonomy grind, hardest-repo judgment, a proof-shaped correctness chunk), mark that chunk `fable-subagent` — after checking the meter ("Fable budget"). Every other chunk in the fan-out stays on its normal tier.

**What "Opus reasoning required" actually means.** Use Opus in-session for: multi-file design decisions, architectural tradeoffs, synthesising disparate context the sub-agent doesn't have, debugging where the failure mode is ambiguous, reviewing or reconciling work the sub-agents produced, talking to the user. Do NOT use Opus in-session for: mechanical edits following a clear pattern, boilerplate generation, writing a test from a clear spec, single-file refactors with obvious shape, formatting/lint fixes, dependency bumps. Those go to Sonnet.

**Always state the call out loud, one line:**

> `Delegation triage: in-session on Opus — multi-file architectural decision, reasoning needed here.`
> `Delegation triage: 1-chunk Sonnet run — mechanical refactor, no Opus reasoning required, efficiency play.`
> `Delegation triage: fan-out — 4 independent feature chunks, would burn ~50% main-session context.`
> `Delegation triage: 1-chunk Codex run — deep algorithm, want fresh-window + adversarial review.`
> `Delegation triage: 1-chunk 1M-Opus-5 subprocess — read surface is the whole monorepo (~280K tokens), beyond subagent budget.`

This makes the orchestration call visible without bloating the response. The user gets to redirect early instead of after you've already started reading files.

**Skip the triage entirely** ONLY for these narrowly-defined cases:
- Genuinely conversational replies ("what's the status of X?", "explain Y") — no implementation surface at all.
- Truly single-line / single-symbol edits — one line, one symbol, no analysis, no surrounding context to load.
- One-file, one-read lookups — single file, single Read tool call, done. (Note: this is *tighter* than the old "<3 file reads" threshold — that was too loose and let too much accidental scope creep in.)
- Status questions answerable from memory, git, or a single tool call.

**If you're not sure whether the task qualifies for skip, run the triage anyway.** 5 seconds beats 30% of a context window. The default bias is *toward* triaging, not away from it.

**Anti-pattern:** running the triage, deciding "delegate", then reading 5 files first "to understand the codebase". The whole point of delegating is to push that exploration into sub-sessions. If the triage says delegate, the next move is `/delegate plan` — full stop.

## Re-triage triggers — fire the 6 questions AGAIN mid-session

**The upfront triage is not a one-shot at session start.** It re-fires whenever the work surface changes. Default aggressive: when in doubt, re-triage. The cost is 5 seconds; the cost of missing it is burning Opus on work that should have fanned out, or accumulating scope inside a session that should have been handed off.

**Mandatory re-triage moments:**

| Trigger | Why it fires | What to do |
|---------|--------------|------------|
| Follow-up turn adds scope ("also do X", "and now Y", "next, can you...") | The new ask is a fresh task — in-session momentum is not an excuse to skip the call | Re-run the 6 questions on the *new* request, ignoring prior in-session decisions |
| User pivots to a new topic | New topic ≠ continuation of prior work | Fresh triage from scratch |
| Replicated work request ("apply the same to Y", "do this for X too") | Replication IS parallelism by definition — Q4 just answered itself | Default to fan-out unless the unit count is genuinely 1 |
| Tool result reveals 2+ files of unexpected work | The complexity surface just expanded | Re-evaluate parallelism + context budget |
| Context just compressed / auto-summary fired | Fresh window = fresh delegation surface | Reassess everything pending; favour handoff if context is mid-task |
| About to read a 3rd file in one turn | The reactive fallback threshold — exploration is becoming a context drain | Stop reading. Re-triage. If "delegate", hand exploration to an Explore subagent |
| First non-trivial request after a session handoff | Resumed-state ≠ in-session continuation; the new session has full context budget to spend | Re-run triage on the resumed task before doing anything else |
| You catch yourself thinking "this is bigger than I thought" | The signal | Stop. Re-triage |
| User says "while you're at it" / "one more thing" | These are always scope additions | Triage the addition independently |
| Failed in-session attempt, about to retry differently | Failure means the original approach was wrong; the new approach gets fresh triage | Don't just retry — re-triage first |

**New-session protocol.** The first non-trivial user request in any new session = mandatory triage. State it explicitly out loud. "I haven't triaged yet" is never an excuse — fresh-session is exactly when delegation has the most leverage (full context budget, no momentum to protect, clean cache). The aggression goes UP at session start, not down.

**Follow-up turn protocol.** Every follow-up turn — not just the first request — gets a one-line internal check: "did the scope change? did the surface expand? did the user add work?" If yes to any, re-run the 6 questions. If no, proceed without ceremony. The check itself is sub-second; it is not optional.

**Why this matters.** The most common delegation failure mode is not "ran triage and got it wrong" — it's "didn't re-run triage when the work grew." A session that started as a single-file edit and accumulated five follow-up additions ends up doing fan-out-shaped work inside one context window, badly. Re-triage cuts that off at every checkpoint.

## Routing objective — QUALITY-FIRST (standing directive, set 2026-07-14)

This skill assumes a subscription with ample included usage. **Cost is NOT a routing input.** Route on capability-fit, latency, and model-diversity only. Every "cheaper / save tokens / efficiency" rule in this file is subordinate to this section; pricing notes remain for intuition only.

**What changes under quality-first:**

- **Build chunks default to Opus 5, not Sonnet — and the cost argument for Sonnet is now dead on the evidence.** Sonnet 5's measured cost per index task is within a few cents of Opus 5's, because it burns far more tokens to get there (**Model Facts**). So drop to Sonnet (latest tier — currently Sonnet 5) only for wide fan-outs (>~6 parallel chunks) of tightly-specified, easily-verified chunks where **wall-clock and rate headroom** genuinely matter. "To save Opus" was always banned as a quality rule; it is now also simply false.
- **Haiku's lane shrinks to volume + latency.** High-volume (>10 units) trivially-verifiable classify/enrich/smoke fan-outs where speed dominates. Anything judgment-adjacent goes to Sonnet or Opus. Haiku is never a cost play now.
- **Fable 5.1 is the apex tier again — and the constraint moved from capability to the meter.** Claude Fable 5.1 is the newest Claude 5 model, Mythos-class, generally available, and above Opus 5 in capability (**Model Facts**). Escalating to Fable is a genuine upgrade, not the lateral trade Fable 5 had become. What gates it now is that **Fable usage is metered and runs out** — so route `fable-subagent` where the chunk is genuinely above Opus 5's band, and nowhere else. See "Fable budget" and "Fable 5.1 routing".
- **Step 10.5 dual review fires more readily** — when in doubt, run it. Reviewer A is an Opus 5 subagent; spend a Fable reviewer only where the applied run itself sits above Opus 5's band.
- **Seat: Fable 5.1 while Fable budget lasts, Opus 5 once it is exhausted.** Orchestration is the highest-leverage surface in a run — a bad cut or a wrong reconciliation is the error no `verification` command catches — so the apex tier earns the seat while the meter allows it. When Fable runs out, Opus 5 takes the seat and nothing else changes: no part of the triage, the manifest contract, or the QA gates depends on Fable being available. Never downgrade below Opus 5 mid-session.

**What does NOT change (these were never cost rules):**

- Terra ban for review (measured recall regression); the account-availability check before any Codex route; the reward-hacking QA rule.
- No Haiku for code chunks — always was a quality rule.
- Extended-thinking caution on intuitive tasks (measured regression).
- Lean orchestrator seat / 1M-as-target-never-seat (reasoning-quality + cache, not price).
- Decomposition beats brute-force context.

## Model Routing — the tier table

| Tier | Model | Session | Use for |
|------|-------|---------|---------|
| **Orchestrator** | **Fable 5.1 (`claude-fable-5-1`, main session) while Fable budget lasts; Opus 5 (`claude-opus-5`, adaptive `xhigh` thinking) once it is exhausted** | Stays | Decompose, review diffs, QA, reconcile dual-model reviews, talk to the user |
| **Apex reasoning** | **Fable 5.1 (`Agent(model="fable")`, or CLI subprocess for 1M)** | Subagent / subprocess (fresh) | The class of sub-problem above Opus 5's band: long-horizon autonomy, hardest-repo judgment, a correctness cut where Opus 5 has plateaued, blocker-conflict tie-break. Metered — spend it under "Fable budget". See "Fable 5.1 routing" below. |
| **QA reviewer A** | Opus 5 (fresh subagent) | Subagent | Cold semantic review of an applied major run (Step 10.5) |
| **QA reviewer B** | **Codex GPT-6 Astra** `--effort high` (Sol for a second family; `gpt-5.5` if neither serves) | Background | Adversarial review of an applied major run, parallel to reviewer A (Step 10.5). Cross-*family* diversity at near-apex depth — Fable is cross-*depth*, not diversity. Never Terra for review (measured recall regression — **Model Facts**). |
| **Planning** | Opus 5 (Plan subagent) | Subagent | Architecture, multi-file refactor design. Exhaust in-seat ultrathink first; a Fable Plan delegate is for a genuinely research-grade cut, and it spends metered budget. |
| **Build** | **Opus 5 (`opus-subagent`) — quality-first default.** Sonnet (latest) for wide, tightly-specified fan-outs where wall-clock matters | Fresh per chunk | Parallel independent implementation chunks (multi-file, project-conventions-aware) |
| **Precision** | Codex GPT-5.6 Sol (fallback `gpt-5.5`) | Background | Adversarial review, deep algorithms, second opinions. Long terminal/tool-loop *screen-driving* chunks go to `gpt-5.6-terra` via `codex-cu.sh` — and to `gpt-6-astra` once the account serves it |
| **Large-context** | **Opus 5 1M (native 1M window; via CLI subprocess to keep it off the orchestrator seat)** — ⛔ **probe the CLI login first**, it is a separate auth from your session and was NOT logged in on 2026-09-07 | Subprocess (fresh session) | Single chunks whose *read surface* exceeds ~150K tokens: monorepo-wide review, big PDF/transcript ingest, multi-hundred-file analysis, log forensics. Never the orchestrator seat. |
| **Cheap parallel** | Haiku 4.5 (Agent, `model="haiku"`) — check its retirement date before building on it | Fresh per task | High-volume narrow tasks at scale: classify/tag, format-convert, bulk mechanical text edits, smoke checks, per-row enrichment |
| **Lookup** | Haiku 4.5 (Explore subagent) | Subagent | File location, grep-for-symbol, quick searches |
| **Integration** | Opus 5 (main session, in-line) | Stays | runner: `main` chunks — cross-cutting edits, package.json, config wiring, glue between sibling chunks |

Full decision tree with per-tier rationale: `references/routing.md`. Every number behind these calls: **Model Facts**, below.

Use `runner: main` sparingly — typically the final chunk in a chain when integration genuinely requires orchestrator context (sibling-chunk awareness, cross-file decisions). Most chunks should be `opus-subagent` for code work (quality-first default; `sonnet-subagent` for wide, tightly-specified fan-outs) or `haiku-subagent` for high-volume trivially-verifiable text/data work.

### Codex tier rules (GPT-5.6 / GPT-6 family — figures in **Model Facts**)

- **⛔ ROUTE ONLY TO MODELS THE ACCOUNT CAN SERVE — check before you route.** The authoritative list is `~/.codex/models_cache.json` (`slug` fields); `codex login status` does NOT tell you this. Account availability **moves in both directions**: `gpt-5.6-sol` vanished from the account on 12 Aug 2026 and was **back and serving on 4 Sep 2026** (probed: `codex exec -m gpt-5.6-sol` returned a clean answer). Re-read the cache; never route off a remembered ban.
- **The 400 does not mean the model exists.** An unservable slug 400s with *"The '<slug>' model is not supported when using Codex with a ChatGPT account."* — and so does a slug that was never real: `gpt-6-fake-nonexistent` returns that identical message (probed 4 Sep 2026). The error tells you *"not on this auth"*, nothing more. **Existence is proved by the cache, not by the error string.** Worse, under `codex-cu.sh` that 400 lands **after** the Computer Use app has opened, so it reads like a screen-capture or permissions failure and sends you debugging the wrong layer. If a Codex run returns no real answer, **grep the log for `is not supported` and `token_invalidated` before touching anything else.**
- **Current allowed set** (verify, don't trust this line — the cache is the source of truth; cache read 7 Sep 2026): `gpt-6-astra` · `gpt-5.6-sol` · `gpt-5.6-terra` · `gpt-5.6-luna` · `gpt-5.5` · `gpt-5.4-mini`. `gpt-5.4` dropped off between 4 and 7 Sep; `gpt-6-astra-aeon` is still not entitled.
- **`gpt-5.6-sol` serves again and holds the deep-algorithm and second-opinion lane.** Adversarial *review* moved to Astra on 7 Sep 2026 (see the Astra bullet) — Sol is now the second model family on a diff, not the first choice. **`gpt-5.5` is the fallback** and becomes the target the moment a Sol call 400s.
- **GPT-6 Astra (`gpt-6-astra`) — LIVE on this account since 7 Sep 2026** (probed serving; cache lists it at priority 1). It takes the `codex-cu.sh` **screen-driving and terminal-grind lane off Terra**, where it clears Sol by a wide margin (**Model Facts**). It also takes the **adversarial-review lane off Sol** — corrected 7 Sep 2026 against the only published head-to-head, where Astra leads Sol on actionable bug coverage, and leads it by a wide margin on *cross-file* findings specifically (**Model Facts**). Sol stays as the second opinion when you want a different model family on the same diff. What Astra takes **nothing** of is **judgment and planning**: on general intelligence it is *level with Opus 5*, not above it, and it publishes no repo-judgment number at all. Route it on the lane, not on the launch headline.
- **⚠️ Astra defaults to `low` effort — always pin one.** The cache's `default_reasoning_level` for Astra is `low` (every other Codex model defaults `medium`). Routing a hard chunk to "the best model" and omitting `-c model_reasoning_effort` gets you the flagship thinking as little as it is allowed to. Every Astra call in this skill passes an explicit effort.
- **The version gate — a third 400 message, and the useful one.** Astra 400'd on 4 Sep with *"not supported when using Codex with a ChatGPT account"* and on 7 Sep with *"requires a newer version of Codex. Please upgrade to the latest app or CLI."* **Read the message, not the status code:** "not supported" = no entitlement (or a fake slug); **"requires a newer version" = the entitlement has landed and the CLIENT is the blocker.** Upgrading codex-cli unlocked it the same minute. Corollary: **the cache lags entitlement** — Astra was absent from it while already entitled, so the cache is a floor, not a ceiling. Probe when a slug matters.
- **nvm double-install trap.** `npm i -g @openai/codex` installs per *node version*. After the 7 Sep upgrade the machine held codex-cli 0.153.4 under node v20 and a stale 0.144.1 under node v24 — and the stale one fails Astra with the version-gate 400 that reads like an entitlement problem. Upgrade under **every** node version that has a `codex` binary, or a shell that switches node silently loses the model.
- **`gpt-5.6-terra` is the agentic/screen-driving target**, and is what `codex-cu.sh` defaults to. Terra's documented weakness was **review recall**, which is a different job from driving a UI — do not let that caveat push CU work onto a model not built for agentic loops. Still never route Terra to adversarial review while Astra, Sol or `gpt-5.5` serve.
- **Luna duplicates Haiku's lane** cross-family; `gpt-5.4-mini` is the cheap tier. Neither is a quality-first target — Claude tiers keep those lanes.
- **⛔ Luna's advertised context is not usable context.** It ships the same ~1M window as Sol and Terra and recalls **under half of it** on long-context retrieval, where its siblings clear 89% (**Model Facts**). Never route a repo-wide read, a long transcript, or any multi-document synthesis to Luna, whatever its coding scores say. Short, self-contained chunks only.
- **Two hidden slugs serve but get NO lane — deliberately.** `gpt-reserve` and `codex-auto-review` both answer a probe (7 Sep 2026) despite `visibility: hide` in the cache. They are not undiscovered capacity: `gpt-reserve` is described as a fast, affordable agentic model, i.e. Luna's lane again, and `codex-auto-review` is Codex's own internal approval-review model, not a general-purpose target. Recorded here so a future session that finds them in the cache does not read the silence as an oversight and route to them.
- **Route on the lane (grind vs judgment), never on a decimal.** Since Opus 5, a Codex chunk is a *legitimate target*, not an automatic upgrade over keeping it on Opus.
- **Reward-hacking caveat (load-bearing, and now live again).** METR measured Sol's detected cheating rate as **higher than any public model they had evaluated** — and Sol is back on the account, so this is an operating rule, not a historical note. Treat the whole family as suspect on self-report.
- **⛔ Unattended, test-graded work does NOT go to Codex.** Where a test suite or checker is both the goal and the judge, and no human reads the diff before it lands, route to Opus 5 — the grader is precisely the thing this family is measured gaming. This is a hard rule, not a preference. A Codex chunk whose result a human or the orchestrator's own Step 10 QA actually inspects is fine; that inspection is the whole mitigation. Never accept a Codex chunk's self-reported pass — the orchestrator's own Step 10 QA run is the only evidence that counts.
- **Tier suffix is mandatory** — bare `gpt-5.6` is accepted by the CLI but rejected by the API. GPT-5.5 stays available as the fallback if 5.6 misbehaves.
- **`ultra` changed meaning on Astra — re-probed 7 Sep 2026.** On the GPT-5.x models it was a CLI-level switch, not a reasoning level. On Astra it is **both**: the cache lists `ultra` as a supported reasoning level described as *"Maximum reasoning with automatic task delegation"*, and it runs (probed). So on Astra it buys depth **and** fan-out, where on GPT-5.x it bought only fan-out. The structural ban is unchanged and unaffected: banned *inside delegate-run chunks*, because `multi_agent_version: v2` means it spawns its own agents against the manifest contract — a contract rule, not a quality judgment. Outside a delegate run it is **permitted but gated** — see the ultra gate below.

#### The `ultra` gate — earn it or don't fire it

**On GPT-5.x, `ultra` buys *parallelism*, not depth** — reaching for it on work that isn't fan-out-shaped pays a fan-out's cost for a single agent's result, and hands the coordination to an orchestrator you can't see or verify. **On Astra it buys both** (max reasoning *plus* automatic delegation), so the "wrong axis" argument below does not apply there — but the verification argument hardens, because you are now trusting an unseen fan-out *and* a model family with a measured reward-hacking problem. **All four must hold:**

1. **Standalone** — Codex owns the whole job end-to-end; no manifest, no delegate run, no chunk contract for it to fight.
2. **Genuinely fan-out-shaped** — 3+ units that are *independent* (separate files, targets, or cases). If you can't name the units, it isn't fan-out-shaped and the switch does nothing but spend.
3. **Too wide for one agent** — the read/edit surface genuinely exceeds what a single `xhigh` Codex pass handles well. A wide sweep, a repo-scale migration, a multi-target audit.
4. **Verifiable from outside** — you hold a check that judges the *result* (test run, build, diff review) without trusting Codex's internal reports. The reward-hacking caveat above hardens here: `ultra` multiplies the number of self-reports you must not believe.

**Fails the gate → use `--effort xhigh`/`max` instead.** Single-file work, adversarial review of one file, a narrow precision fix, a deep-but-narrow algorithm, "let's be thorough" — every one of these is a depth need, and `max` supplies depth on every model in the family without buying an invisible fan-out with it. On GPT-5.x that is because `ultra` moves only the parallelism axis; on Astra it is because `ultra`'s *extra* over `max` is the delegation, and delegation is precisely what a narrow task does not need.

## Model Facts — every number that ages, in one place

> **Verified 2026-09-07** — full two-family benchmark re-sweep, every figure re-taken from a fetched primary page. Several long-standing rows were found to be UNSOURCED and have been removed rather than updated; the removals are recorded below because a deleted number that quietly returns is the failure this block exists to prevent. (GPT-6 Astra now servable — context window, effort ladder and defaults re-taken from the local models cache, which disagrees with the launch coverage. `gpt-5.6-sol` availability re-probed 2026-09-04; Claude lineup refreshed for Fable 5.1 on 2026-09-03). This is the **only** place in this skill — SKILL.md *and* every file under `references/` — that carries a figure which ages: benchmarks, prices, context windows, cutoffs, measured regressions. Everywhere else names *lanes and rules*, never numbers. When a model lands or a benchmark moves, re-verify **here and nowhere else**; a figure found outside this block is drift — delete it, don't update it. Enforced by `scripts/check-model-facts.sh` — run it after any model-layer edit.
>
> Prices are written without dollar signs (a literal `$N` gets argument-substituted when this skill is invoked with args) and are **intuition only — cost is not a routing input**.

**Lineup**

| Model | ID | Ctx | Max out | in/out per MTok | Cutoff | Notes |
|-------|----|-----|---------|-----------------|--------|-------|
| **Opus 5** | `claude-opus-5` | 1M | 128K (300K on Batch via `output-300k-2026-03-24`) | 5/25 | May 2026 | Released 2026-07-24. Adaptive thinking **on by default** when `thinking` is omitted (changed from 4.8). Effort low→max, default `high`. Fast mode bills 2× → 10/50. |
| **Fable 5.1** | `claude-fable-5-1` | 1M | 128K | 10/50 (cache reads 0.25) | — | **The newest Claude 5 model — Mythos-class, generally available, and above Opus 5 in capability.** Anthropic's most capable widely released model. Thinking always-on. Effort low→max, default `high`. Ships additional safety measures for dual-use capabilities: a declined request returns HTTP 200 with `stop_reason:"refusal"`. **Usage is metered and runs out** — see "Fable budget". |
| **Mythos 5.1** | `claude-mythos-5-1` | 1M | 128K | 10/50 | — | The same underlying model as Fable 5.1 — same capabilities, pricing, and API surface — available only to approved organisations. Not a routing target unless the account has it. |
| ~~Fable 5~~ | `claude-fable-5` | 1M | 128K | 10/50 | Jan 2026 | Superseded by Fable 5.1 in the same tier at the same per-token price. Still served; no remaining lane in this skill. |
| **Sonnet 5** | `claude-sonnet-5` | 1M | 128K | 3/15 (2/10 intro thru 2026-08-31) | — | Adaptive thinking, no extended thinking. |
| **Haiku 4.5** | `claude-haiku-4-5-20251001` | 200K | 64K | 1/5 | Feb 2025 reliable (Jul 2025 training) | Only current model still on classic extended thinking rather than effort/adaptive — **it has no `effort` parameter at all**, which breaks any scheme that tunes effort per chunk. ⚠️ **Retirement commitment expires 2026-10-15** — the shortest-lived model in the lineup; re-check before building anything durable on it. |
| **Codex GPT-5.6 Sol** | `gpt-5.6-sol` | 1M | 128K | 5/30 | — | **Available again on the account — probed serving 2026-09-04** (it had 400'd since 12 Aug 2026). Default Codex routing target; `gpt-5.5` is the fallback. Re-probe rather than trusting this row — availability has flipped twice. |
| **Codex GPT-6 Astra** | `gpt-6-astra` | **272K default / 872K max** via Codex CLI (launch coverage quotes 1,050,000 for the raw API — the CLI cache is what governs a `delegate.sh` chunk, so route on 272K) | 128K | 10/50 | — | Launched 2026-09-03; **servable on this account from 2026-09-07** (probed), cache priority 1. **`default_reasoning_level` is `low`** — always pin an effort. Ladder: `low`→`max` **plus `ultra`** ("maximum reasoning with automatic task delegation", `multi_agent_version: v2`, `multi_agent_reasoning_effort: xhigh`). Fast tier 2× speed at 2× price. `gpt-6-astra-aeon` exists as a slug but is **not entitled** on this account. |
| ~~Opus 4.8~~ | `claude-opus-4-8` | 1M | 128K | 5/25 | — | **Retired from this skill.** Superseded by Opus 5 at identical price, better on every published benchmark. No remaining lane. |

**Benchmarks that drive the routing calls** (max-reasoning configurations)

> **Fable 5.1 has no head-to-head rows here, and none are invented.** What is known, and what the routing runs on: it is the newest Claude 5 model, Mythos-class, generally available, and **above Opus 5 in capability**. Every Fable column below was measured against **Fable 5**, which 5.1 supersedes — read those rows as history, not as a reason to keep the apex on Opus. The live constraint on Fable is the meter, not the score.

| Signal | Opus 5 | Fable 5 (superseded) | Codex Sol | Consequence |
|--------|--------|----------------------|-----------|-------------|
| AA Intelligence Index | **REMOVED — unsourced** | — | — | AA publishes conflicting values per model across its own surfaces; see the AA instability note below |
| SWE-bench Verified | **REMOVED — unsourced** | — | — | Not published for ANY frontier tier; see the SWE-bench note below |
| SWE-bench **Pro** (hardest repo judgment) | behind | **~80%** | 64.6% | Hardest-repo judgment is a Fable lane |
| Frontier-Bench v0.1 (agentic coding) | **43.3%** | 33.7% | — | Historical — Opus 5 vs Fable **5** |
| GDPval-AA (Elo) | **1861** | 1747 | — | Historical — Opus 5 vs Fable **5** |
| OSWorld 2.0 (computer use) | **70.57%** | lower | — | Historical — Opus 5 vs Fable **5** |
| Terminal-Bench 2.1 | 84.64% | — | **85.77%** | Sol's ~1pp edge — narrow, lane-based call only (Sonnet 5: 74.53%) |
| ARC-AGI-2 | ~90% | — | **~92–93%** | Sol |
| AA Coding Agent Index | 78 (xhigh, CC harness) | — | 77–80 | Effectively tied |
| Longest-horizon autonomy | behind | **ahead** | — | Long-horizon autonomy is a Fable lane |
| Adversarial review recall | — | — | Sol **+7.4pp** vs 5.5, ~32% precision; **Terra −8.6pp** | Sol-only review lane; expect noise, reconcile it |
| Long-horizon efficiency | — | — | Sol 63.7% @ ~21K out; **Terra 40.7% @ ~55K** | Terra ban |

**GPT-6 Astra — the measured picture (2026-09-04)**

| Signal | GPT-6 Astra | Comparator | Consequence |
|--------|-------------|------------|-------------|
| AA Intelligence Index (max) | **61** (#8 / 202) | Opus 5 **61** | Level with Opus 5, not above it. Astra is **not** a judgment-tier upgrade. |
| OSWorld 2.0 (computer use) | **72.6%** (offline set, ~40 min/task) | Opus 5 70.57% · Sol 65.7% | Best computer-use number on the board — the screen-driving lane, once servable. |
| Terminal-Bench 4.0 | **57.7%** | Sol 37.3% | Wide terminal-grind margin. ⚠️ **v4.0 — not comparable to the v2.1 rows above.** Never cross-read the two. |
| DeepSWE v1.1 | 74.1% | — | No comparator measured here; not a routing input on its own. |
| GPQA (verified) | 96.0% | — | Knowledge, not agentic capability. Not a routing input. |
| SWE-bench Verified / Pro | **not published** | — | The absence is the point: no evidence Astra beats Opus 5 or Fable on repo judgment. Do not assume it. |
| Usable read surface (CLI) | **272K** default, 872K max | Opus 5 1M | Astra is **not** the large-surface tool. A >150K chunk still routes to `opus-1m-cli`; anything near 272K on Astra risks truncation (`truncation_policy` trims tool output at 10K tokens). |
| ARC-AGI-3 headline | 99.9% provider adapter / **62.7% standard harness** | — | 37.2pp apart on the same model — the adapter preserves opaque reasoning state between requests and compacts context. The launch table carries the 99.9%. **Route on 62.7%.** |
| Adversarial review — actionable bug coverage | **61.3%** overall, **57.1%** cross-file | Sol 59.0 / 47.6 · Opus 5 50.2 / 42.9 | Astra leads, and the cross-file gap over Sol is ~9.5pp. Single vendor (CodeRabbit), bespoke ~100-pattern harness, and it reports *coverage* — recall, precision and FPR are published for no model at all. It is the only head-to-head that exists, so the review lane follows it. |

**Two figures were REMOVED from this block on 2026-09-07, not updated. Do not reinstate either without a fetched primary page.**

- **SWE-bench Verified is not published for any frontier tier.** Neither Anthropic's Opus 5 nor its Fable 5.1 announcement carries one; nor does the Astra launch, nor the GPT-5.6 family. The figures circulating on aggregator blogs (~95–97% for Opus 5 / Fable 5.1, and four mutually inconsistent numbers for Sonnet 5) trace to no primary source. **The only clean vendor-published figure in the whole lineup is Haiku 4.5 at 73.3%** — 50 trials, a two-tool bash-plus-edit scaffold, default sampling, no test-time compute. It is the most trustworthy single number here, and it belongs to the cheapest model. Related: no Claude 5-generation model appears on Scale's public SWE-bench **Pro** board either, which tops out at Opus 4.6; every Pro figure quoted for a Claude 5 tier is vendor self-report.
- **The AA Intelligence Index is unstable across AA's own surfaces.** GPT-5.6 Sol reads 51, 59 or 61 depending which of three AA pages you open; Claude Sonnet 5 moves from 45 (#38/202) on its model page to 53 (#5) in its launch article. Index versions rebase without renaming. **Use the rank ordering as the signal and cite the live model page; never quote the absolute as though it were stable.**
- **Terminal-Bench is three benchmarks sharing one name.** Versions 2.0, 2.1 and 4.0 are all in current marketing. GPT-5.6 Sol scores **88.8% on 2.1 and 37.3% on 4.0**; Fable 5.1 scores **91.4% on 2.1 and 55.8% on 4.0**. A cross-version comparison is worth ~35-50 points of pure artefact. Always carry the version; refuse to compare without it.
- **Sonnet 5's cost advantage does not survive measurement.** Cost per AA Intelligence Index task: Sonnet 5 **$2.29**, Opus 5 **$2.34** — Sonnet's cheaper tokens are cancelled by burning far more of them. Route Sonnet for wall-clock and rate headroom, never for spend.
- **Luna's usable context is far below its advertised window.** MRCR long-context recall: Sol **91.5%**, Terra **89.6%**, **Luna 41.3%** — on the same ~1M window. See the Luna rule in Codex tier rules.
- **Only one model in the lineup has a METR evaluation: GPT-5.6 Sol.** 50%-time-horizon "around 11.3hrs (95% CI: 5hrs – 40hrs)", and METR states plainly that it does not consider these a robust measurement. The same report is the source of the reward-hacking rule. **No METR evaluation exists for GPT-6 Astra.**

> **Snapshot caution.** The AA Coding Agent Index is re-scored as models are added — two fetches in July 2026 returned different absolutes for the same models. Treat every figure here as dated. Route on the *lane*, not the decimal.

**Behavioural figures that also age**

| Figure | Value | Consequence |
|--------|-------|-------------|
| Extended thinking on *intuitive* tasks | measured **~36%** performance regression | Default thinking OFF on Sonnet/Haiku code chunks — never enable it reflexively |
| Sibling-chunk prompt-cache reuse (May 2026) | `cache_creation` cost down **~3×** when fan-out chunks share a stable prompt prefix | Structure chunk prompts with a shared briefing prefix so the hit rate compounds |
| Prompt cache TTL | 5 min default; 1-hour tier available | Stay under ~270s between turns, or commit to ≥1200s |

**API quirks that bite hand-rolled calls** (the Agent tool handles these; raw `claude -p` / SDK calls do not)

- **Opus 5:** no assistant prefill (400) • `thinking:{type:"disabled"}` is valid **only at effort `high` or below** — pairing it with `xhigh`/`max` returns 400 • adaptive thinking runs by default when `thinking` is omitted • cyber/bio safety classifiers mean a declined request returns HTTP 200 with `stop_reason:"refusal"` and a `stop_details.category`, not an exception — branch on `stop_reason` before reading `content`; the `fallbacks` beta auto-reruns on a fallback model.
- **Fable 5.1 (and Mythos 5.1):** thinking is always on — omit `thinking` entirely; both `{type:"disabled"}` and `{type:"enabled",budget_tokens:N}` return 400 • forced tool use (`tool_choice` `any`/`tool`) returns 400 — use `auto` plus an explicit instruction, or `strict:true` for schema-valid arguments • no assistant prefill • the dual-use safety measures mean a declined request returns HTTP 200 with `stop_reason:"refusal"` and a `stop_details.category`, not an exception — branch on `stop_reason` before reading `content`.
- **Codex CLI (re-probed against codex-cli 0.153.4, 2026-09-07):** the effort ladder is **per-model**, not global. GPT-5.x: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` — `ultra` absent. **Astra: `low`, `medium`, `high`, `xhigh`, `max`, `ultra`** — and `ultra` runs. The earlier "ultra is never a reasoning tier" note was probed on 0.144.1, before Astra existed; it was right then and is wrong now. Re-probe the ladder when a new model lands.

## Fable 5.1 routing — the apex tier, and the meter that governs it

**The rule.** Claude Fable 5.1 (`claude-fable-5-1`) is the newest Claude 5 model — Mythos-class, generally available, and **above Opus 5 in capability** (**Model Facts**). Claude Mythos 5.1 is the same underlying model behind an approved-organisation gate; if the account does not have it, it is not a route. So escalating to Fable is a genuine upgrade again — the Fable-5-era "lateral trade" framing is retired.

**The constraint moved, it did not disappear.** Fable usage is **metered and runs out**. The question is therefore never *"is Fable better here"* — it is — but ***"is this chunk worth the meter?"***

### Fable budget — the spending rule

- **Route to Fable only where the chunk is genuinely above Opus 5's band.** Long-horizon autonomy, hardest-repo judgment, a correctness cut where Opus 5 has visibly plateaued, a blocker the orchestrator cannot adjudicate. Name which of those you are buying before you spawn.
- **Never spend Fable on mechanical, tightly-scoped, or replicated work.** A rename across files, boilerplate from a clear spec, a test from a written contract, a wide fan-out of near-identical chunks, anything whose verification is a schema check — those are Sonnet, Haiku, or Codex lanes. Replicated work in particular ("apply the same to Y") is the classic invisible burn: N chunks of Fable buying one chunk's worth of judgment.
- **The seat is the one standing exception.** Orchestration is the highest-leverage surface in a run — a bad cut or a wrong reconciliation is the error no `verification` command catches — so the apex tier takes the seat while the meter allows it.
- **When the meter runs out, Opus 5 takes the seat and the run continues unchanged.** Say so in one line; don't stall, don't ask, don't downgrade further. Nothing in the six-question triage, the manifest contract, the runner enum, or the QA gates depends on Fable being available — a Fable-exhausted session routes exactly like a Fable-present one minus the `fable-subagent` lane.

**Where Fable 5.1 earns a delegate spawn** — beyond the seat, escalate on a *narrow, high-leverage* sub-problem. Shape check first: if the plateaued sub-problem is *agentic-grind-shaped* (a long terminal/tool-loop execution slog rather than a judgment problem), a Codex `gpt-5.5` chunk is the better escalation and leaves the meter alone.

| Use Fable 5.1 for | Spawn |
|-------------------|-------|
| **Long-horizon autonomy** — a single delegate that must stay coherent across an extended unsupervised run | 1-chunk `fable-subagent`, background |
| **Hardest-repo judgment** — the hardest class of real-repo change, where Opus 5 has visibly stalled | 1-chunk `fable-subagent` (CLI subprocess if it also needs a >150K read surface) |
| **Research-grade decomposition or a subtlest-correctness cut** — where in-seat ultrathink has demonstrably plateaued. Exhaust ultrathink first: it is free and spawns nothing | 1-chunk `fable-subagent` (Plan-shaped) |
| **Blocker-conflict reconciliation** — Step 10.5 reviewers (Opus 5 + Codex) disagree on a *blocker* and the orchestrator can't confidently adjudicate | Escalate that one finding to Fable as a *third, independent* opinion |

**Mechanical notes:**

- Fable spawns natively via the Agent tool — the `model` field accepts `sonnet | opus | haiku | fable`, so `Agent(subagent_type="general-purpose", model="fable", run_in_background=True, ...)` is all it takes. Unlike 1M-Opus, **no CLI subprocess is required**. Use one only if the Fable chunk also needs a >150K read surface or isolated MCP/hooks.
- Runner enum: `fable-subagent` is wired into `delegate.sh validate` and `references/manifest-schema.md`. Step 6 fan-out uses the standard spawn block with `model="fable"`.
- Thinking and effort quirks for raw CLI/API calls: see **Model Facts** → "API quirks". Effort defaults to `high`, not `xhigh` — climb only on a concrete signal (the delegate self-reports low confidence, its verdict conflicts with both Step 10.5 reviewers, or its output fails verification). Reflexive `max` on a metered tier is the fastest way to lose the budget you were saving.
- Discipline: Fable is **not** model-diversity for QA — it's still a Claude model. Codex remains the cross-family reviewer; Fable is depth, not diversity.

## Effort Levels per Runner

| Runner | Effort control | Default | Override |
|--------|---------------|---------|----------|
| **Orchestrator (Fable 5.1, else Opus 5)** | Always-on thinking + `effort` on Fable; adaptive thinking (`xhigh` default in Claude Code) on Opus 5. **Explicit ultrathink at the planning gate on either** | Full + adaptive | Never switch the seat to Sonnet manually, and never below Opus 5 when Fable runs out. At the decomposition gate (Step 2), *force* the ceiling with ultrathink rather than trusting adaptivity to find it; a bad cut is the one orchestrator error no verification catches |
| **Apex (Fable 5.1)** | `effort` (sweep `medium`/`high`/`xhigh`) + always-on thinking | `high` | Start at `high`, not `xhigh`; climb only if the sub-problem demands it. Never send `thinking:{type:"disabled"}` (400 on Fable — omit the param). The tier is metered: default effort is part of the budget rule |
| **Sonnet subagents (Sonnet 5)** | Model tier + adaptive thinking | Adaptive (default) | Set `thinking="extended"` for genuinely deliberative tasks (math, multi-step symbolic reasoning); default OFF for code chunks — extended thinking measurably hurts on intuitive tasks (**Model Facts**) |
| **Codex (GPT-5.6 Sol)** | `CODEX_EFFORT` env var → `model_reasoning_effort` — real API ladder: `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` | `high` (quality-first) | `CODEX_EFFORT=xhigh` for deep algorithmic work or adversarial review (matches the local config pin). **`ultra` is not on this ladder** — it's a CLI-level orchestration switch that spawns Codex's own subagent fan-out. Never inside a delegate-run chunk (double-orchestrates against the manifest contract); outside one it must clear all four conditions of the **ultra gate** (§ "Codex tier rules"). Depth comes from this ladder, parallelism from `ultra` — don't substitute one for the other |
| **Haiku 4.5 (Cheap parallel + Explore)** | Model tier + optional extended thinking | OFF | Default OFF for pure lookups/classification/bulk edits. Enable extended thinking only for unambiguous deliberative subtasks — rare for Haiku-suitable work |

**Session advice:** Start on Fable 5.1 if Fable budget is available, otherwise Opus 5 — and stay there. The skill routes sub-runners automatically. Switching to Sonnet manually to "save tokens" just degrades the orchestrator; the planning and QA gates are where the seat earns its keep. Adaptive thinking on Opus is the default — don't fight it; it spends thought where the task warrants it. If Fable runs out mid-session, drop the seat to Opus 5, say so in one line, and carry on.

**Thinking-mode rule of thumb:** If the task is "follow the obvious pattern", leave thinking OFF on Sonnet/Haiku. If the task is "reason about which of three valid approaches is right here", extended thinking earns its cost. The intuitive-task regression is measured and real — don't reflexively turn it on.

## Session Handoff — when to suggest a fresh start

The orchestrator must proactively suggest a handoff when it detects diminishing returns from held context. Don't wait for the user to notice. The trigger is any one of:

| Signal | Threshold | Action |
|--------|-----------|--------|
| Context window | **>75%** full | Suggest handoff immediately — before the next fan-out or QA gate |
| Mid-run stall | Collect phase done, QA not started, session feels stale | Suggest handoff before QA |
| Repeated clarifications | Same question asked / context re-explained 2+ times | Stop and suggest handoff |
| User says "handoff" | Explicit | Always produce the prompt block |

**How to surface it.** Say *"Here's the transfer prompt — paste this into a new session:"*, then emit a fenced, self-contained block the user can paste as the first message of a fresh session. For a run in flight, `delegate.sh handoff <run-id>` generates it from the manifest + `state.tsv`; hand-author only when there's no run to read from. Shape: `references/prompt-templates.md` → "Session-handoff transfer prompt".

**The rule:** every handoff lives in the chat as a copyable block. No file, no script, no "go read HANDOFF.md". The prompt IS the handoff.

## Context Budget Rules

- **<30% context**: do the work in-session *only if it needs Opus reasoning*. Mechanical or pattern-following work goes to a 1-chunk Sonnet sub-agent regardless of context budget — Opus shouldn't be spent on it.
- **30–60%**: hand exploration to Explore subagents. Keep implementation local only when it requires orchestrator-level synthesis.
- **>60%** OR **2+ independent units**: decompose and fan out. The sweet spot.
- **Cache discipline**: sub-sessions start with a fresh cache, and subagent progress summaries hit the prompt cache — so repeated fan-outs with a shared system prompt and shared context blocks cache cleanly across siblings. Structure chunk prompts with a stable prefix (shared briefing, project conventions) so the hit rate compounds. TTLs and the measured saving: **Model Facts** → "Behavioural figures".
- **Single-chunk delegation is valid.** A 1-chunk run to Sonnet or Codex is worth it for any of three reasons: (a) **fresh context window** — a deep task that would burn 40%+ of main-session context; (b) **model fit / efficiency** — mechanical or pattern-following work that doesn't need Opus, route to Sonnet; (c) **independent perspective** — adversarial review or precision fix, route to Codex with `--effort high`. Parallelism is one optimisation, but not the only one. Fresh-context, efficiency, and perspective are all valid reasons to delegate a single chunk.

## When to Use Codex vs Sonnet Subagent

| Use Codex | Use Sonnet subagent |
|-----------|---------------------|
| One focused file/function | Multi-file chunk |
| Want a different model's opinion | Follows project conventions |
| Adversarial review | Parallelisable with siblings |
| Deep algorithmic work | Output is a clean diff |
| Long terminal/tool-loop agentic grind — Sol's measured lane (numbers: **Model Facts**) | **Efficiency 1-chunk run** — mechanical code work that doesn't need Opus |

**The efficiency 1-chunk Sonnet pattern.** When triage Q1–4 all land "no" but the task is mechanical / pattern-following / boilerplate — rename a symbol across files, generate a test from a clear spec, apply a diagnosed lint fix, bump a dependency, mirror an existing endpoint, update copy across known files — the default move is a 1-chunk Sonnet sub-agent run, not in-session Opus. In-session Opus stays the right call for: multi-file design, architectural tradeoffs, ambiguous-spec debugging, reconciling reviewer findings, talking to the user.

## When to Use Haiku vs Sonnet (the cheap-parallel tier)

Haiku 4.5 is the **volume-and-latency** tier — never a cost play (cost is not a routing input; see "Routing objective"). It earns the spawn when the unit count is high (>10) *and* the verification surface is trivial — "does the output match the spec, yes/no". Use it as Explore subagents (lookups) and as fresh Agent subagents for narrow, mechanically-verifiable chunks. Anything judgment-adjacent goes to Sonnet or Opus.

| Use Haiku | Use Sonnet |
|-----------|------------|
| Classify or tag a list of items | Multi-file code chunk |
| Format conversion (JSON↔YAML, table↔CSV, MJML↔HTML stubs) | Anything requiring project-conventions awareness |
| Bulk text edits following an unambiguous rule | Chunks that need caller/callee context |
| Smoke checks (does X import, has Y key, schema validation) | Code that mirrors a non-trivial existing pattern |
| File-location lookups / grep-for-symbol | Test generation from a real spec |
| Per-row enrichment over a large list | Refactors with subtle invariants |
| Doc lookups in known files | Anything where "looks right" might subtly be wrong |
| Tag/categorise content blocks, audit logs, change lists | Generating glue code that wires multiple systems |
| Strip emojis / normalise whitespace across many files | API surface design |

**The rule:** Haiku for narrow, unambiguous, mechanical text/data tasks where verification is trivial. Sonnet for code chunks that need full project-conventions awareness. Opus for orchestration and design.

**Fan-out pattern for high-volume Haiku work.** When you have N independent narrow tasks (e.g. 50 content blocks to classify, 30 files to lint-fix, 100 records to enrich), fan out as Haiku subagents in batches of 4–8 in parallel. Shared system prompt = good cache hit rate. Per-chunk verification = trivial schema check. The orchestrator (Opus) collates the structured outputs.

**Anti-pattern:** routing code-chunk work to Haiku to save money. The Sonnet→Haiku cost savings are real but Haiku will silently miss subtleties — wrong null-handling, wrong import order, wrong test framework — that Sonnet catches. False economy. The Haiku tier earns its keep on tasks where the verification surface is *trivial* (schema check, string equality, lint pass), not "looks like working code".

**If Fable is exhausted or unavailable** (the meter ran out, access lapsed, 400/404 on spawn): do not stall and do not downgrade silently. **Opus 5 takes the seat**, and the replacement for an apex *delegate* is **ultrathink on Opus 5 + an independent Codex `gpt-5.5` `--effort high` pass on the same sub-problem**, reconciled by the orchestrator — depth via forced thinking budget, blind-spot coverage via cross-family diversity (the Codex tier sits close to Fable-5 depth on AA's index — **Model Facts** — so the substitute is credible). Note in the run log that the apex tier was substituted. Everything else in the flow is unchanged.

## 1M Context Routing — a fresh 1M session as a delegation target (never the orchestrator seat)

**The rule, stated bluntly.** The orchestrator session stays **lean** — full stop. A 1M read surface is a *target*, not a *seat*. Opus 5 ships a native 1M window at standard pricing, so the old *cost* argument ("the premium above 200K burns cash") is gone — but the rule stands on its other leg: the orchestrator's job (decompose, review diffs, reconcile reviews, talk to the user) is small-context work, and pouring 1M of source into the seat degrades reasoning quality and trashes the prompt cache regardless of price. Keep huge read surfaces in a **fresh** delegate session and the orchestrator stays sharp. If the orchestrator session itself is hitting 75%+ context, the right move is **handoff** (cheap, clean, deterministic), not bloating the seat.

**When 1M Opus is the right routing call:**

| Trigger | Why 1M, not Sonnet/Haiku subagent or Agent Teams |
|---------|--------------------------------------------------|
| Chunk needs to read >150K tokens of source material in one pass (monorepo-wide refactor analysis, big PDF/transcript ingest, multi-hundred-file audit, days of logs) | Subagent context is bounded by the orchestrator's allowance; Sonnet 5 caps below where this needs to be. 1M Opus gives the chunk a fresh full 1M window. |
| Adversarial review where reviewer needs spec + full codebase + test suite + prior reviews in one context | Same as above — review quality collapses when the reviewer can't hold the whole surface. |
| Cross-cutting "find every place X is true" sweep over a large corpus | Greps miss semantic patterns; full-context Opus reads catch them. |

**When 1M Opus is NOT the right call (use the cheaper path):**

- Chunk fits comfortably in <150K tokens → regular Sonnet subagent or Codex.
- Task decomposes into independent sub-units → fan out instead. Decomposition beats brute-force-context every time.
- You only need keyword/symbol lookup → Haiku Explore subagent + grep.
- The orchestrator session is full → handoff, not 1M flip.

**⛔ PRECONDITION — probe the CLI login before routing anything here.** `opus-1m-cli` shells out to the standalone `claude` binary, which authenticates **separately from the session you are sitting in**. On one machine (probed 2026-09-07) it is **not logged in**: `claude -p "..." --model claude-opus-5` returns *"Not logged in · Please run /login"*. Not a sandbox artefact and not an inherited-env artefact — it reproduces with the sandbox disabled and with every `CLAUDE_*` variable unset, while the keychain credential itself reads fine from the same shell. The app-hosted session is authenticated; the CLI is a different client and has its own login.

So: **probe first, route second.** One cheap command, and it costs nothing next to discovering this mid-run on a chunk you have already decomposed for:

```bash
claude -p "reply OK" --model claude-opus-5 </dev/null 2>&1 | head -1
```

Anything but a normal answer means the lane is shut. **Fall back by decomposing** — split the surface into sub-150K chunks and fan them out, which is the better answer in most cases anyway (see "When 1M Opus is NOT the right call"). Only escalate to the user if the surface is genuinely irreducible, and say plainly that the fix is `claude login` in their own terminal — that is their action, not yours.

**Mechanical invocation.** Manifest runner is `opus-1m-cli`; it spawns as a Bash subprocess to the Claude Code CLI, not as an Agent (subagent context is bounded well below 1M whatever the model). Spawn block and its flags: `references/prompt-templates.md` → "`opus-1m-cli` — the 1M subprocess spawn block".

**Session escalation (last-resort, rare).** If the user's *own* session has accumulated irreducible context that handoff would lose (mid-debugging an ambiguous failure, holding cross-file mental state that can't be summarised cleanly), the alternative to handoff is launching a fresh 1M Opus 5 CLI session and pasting the held context in. State the trade-off out loud: "The orchestrator's at 80%. Handoff loses momentum but keeps the seat lean. A 1M flip preserves momentum, but every subsequent turn re-reads the bloated context — slower, costlier per turn, and the reasoning dulls. Recommendation: handoff unless the held state is genuinely unsummarisable." Default to handoff; the 1M flip needs an explicit yes.

## Usage

```
/delegate plan "<task>"     # Decompose only — produce manifest, no execution
/delegate run "<task>"      # Decompose + fan out + collect + audit + apply + QA + present
/delegate resume [run-id]   # Re-fan only chunks still pending or failed
/delegate qa <run-id>       # Re-run QA gate on an existing run
/delegate watch [run-id]    # Compact one-shot snapshot of state.tsv (cheap in-chat progress — use instead of re-cat'ing state)
/delegate liveness [run-id] # Two-signal liveness check on running chunks — ALIVE|SILENT|STALLED, exit 2 if any stalled
/delegate abort <run-id>    # Mark all running chunks failed; write ABORTED marker (hard-blocks apply)
/delegate review "<draft-or-task>"  # 1-chunk Codex run for adversarial second opinion (review.md, no apply)
```

Review mode is a 1-chunk Codex run that produces a `review.md` artefact instead of code files. Use for: adversarial second opinion on an Opus-authored plan, sanity-checking a risky integration, getting model-diversity on a critical algorithm. See `references/prompt-templates.md` for the review-mode template.

## State model

Every run lives at `$TMPDIR/delegate/<run-id>/`. The orchestrator never holds chunk diffs in context — it reads `state.tsv` on demand. `state.tsv` is the source of truth.

```
$TMPDIR/delegate/<run-id>/
  manifest.json             ← authored once, then read-only
  state.tsv                 ← compact orchestrator state (see below)
  <chunk-id>/workspace/     ← chunk writes files here (relative paths)
  <chunk-id>/.spawned       ← spawn stamp, written by `set status=running` (liveness signal)
  <chunk-id>/output.log     ← OPTIONAL: captured chunk stdout, if the orchestrator
                               redirects it. Nothing in the engine writes this —
                               `liveness` sweeps the whole chunk dir, so it counts
                               as an artifact when present and costs nothing when not.
```

**`state.tsv` layout** — header comment + column header + one row per chunk:

```
# run_id=20260511-153022-a4b9
# project=/path
# task=add slugify + truncate
id      status   runner           files                    verification              tokens  duration_ms  result
chunk-1 done     sonnet-subagent  src/slugify.js,...       node --test src/slug...   1234    4500         pass:5/5
chunk-2 done     codex            src/truncate.js,...      node --test src/trun...   2100    8200         pass:4/4
```

Status values: `pending` → `running` → `done` | `failed` | `skipped`. The whole file is ~80 chars per row — re-reading it mid-run costs <250 tokens.

> **Run state is not durable.** `$TMPDIR` is swept by the OS (on macOS, `com.apple.bsd.dirhelper` prunes files older than ~3 days), so `state.tsv` — the declared source of truth — silently disappears from an abandoned run over a long weekend. `resume` and `handoff` will then fail on a run-id that looked valid on Friday. For any run you might return to after a break, copy the run dir somewhere durable, or re-init. Set `DELEGATE_ROOT` to a persistent path if you want runs to outlive the sweep.

**Token capture:** Sonnet chunks report exact tokens via the `task-notification` `<usage><total_tokens>` field — the orchestrator must parse and call `delegate.sh set ... tokens=<N>` (the engine doesn't auto-capture for sonnet). Codex chunks are auto-captured by `cmd_codex` from JSONL `turn.completed` events.

## Orchestration Flow (run mode)

### Step 1 — Init the run

```bash
OUT=$({base}/scripts/delegate.sh init "<task>" --project <project-path>)
RUN_ID=$(echo "$OUT" | sed -n 's/^RUN_ID: //p')
```

Returns `RUN_ID`, `RUN_DIR`, `PROJECT`. Stash the RUN_ID in your scratchpad — every other command takes it.

### Step 1.5 — Autodetect verification commands

Before authoring the manifest, run:
```bash
{base}/scripts/delegate.sh autodetect <project-path>
```
Use the output to populate `project_verification` and chunk `verification` fields in the manifest. Avoids the orchestrator inventing wrong commands (e.g. `npm test` on a Python project). If autodetect prints `NO_VERIFICATION_DETECTED`, fall back to a minimal sanity check (`bash -n script.sh`) or omit verification.

### Step 2 — Decompose

**Ultrathink gate — engage before you cut.** Decomposition is the highest-leverage, least-recoverable decision in the whole flow: a wrong chunk boundary is invisible to every downstream verification command — it doesn't fail a test, it silently wastes the entire fan-out. That's precisely the "intelligence belongs where verification *can't* catch the error" case. When the cut is non-obvious, **explicitly escalate to the maximum thinking budget (ultrathink) before authoring the manifest** — don't trust adaptive thinking to find the ceiling on its own at this gate; force it. Trigger ultrathink when *any* of:

- **Topology is a real choice** — by-feature vs by-layer vs by-file all look plausible, and the wrong one creates cross-chunk dependencies the manifest contract forbids.
- **Many chunks (>~5) with `files_touched` overlap risk** — keeping them genuinely disjoint takes real thought, not a glance.
- **Unfamiliar or tangled project** — boundary-finding depends on architecture you've had to infer rather than read off.
- **A wrong cut is expensive to unwind** — long-running chunks, a large fan-out, or irreversible side effects downstream.

Skip it for the obvious 2–3 chunk runs — burning max thinking on a trivial cut is the same waste as reflexive `xhigh` on a Sonnet chunk.

**Planning escalation ladder:** adaptive `xhigh` (default, routine cuts) → **ultrathink in-seat** (high-stakes but seat-tractable — free, no spawn, no latency) → **Fable 5.1 Plan delegate** (genuinely research-grade decomposition where in-seat ultrathink has plateaued; see "Fable 5.1 routing"). Climb only on a real signal, and exhaust the free in-seat ultrathink *before* spending metered Fable budget on a delegate.

Author a manifest with this shape (see `references/manifest-schema.md` for the full spec):

```json
{
  "task": "high-level description",
  "run_id": "<RUN_ID from step 1>",
  "project_verification": "npm test",
  "chunks": [
    {
      "id": "chunk-1",
      "title": "short title",
      "intent": "what this chunk must accomplish",
      "files_touched": ["src/foo.ts", "src/bar.ts"],
      "runner": "sonnet-subagent",
      "depends_on": [],
      "verification": "npm run typecheck"
    }
  ]
}
```

`files_touched` is **required** and **non-empty** — it's how chunks are kept disjoint and how audits work later.

Install the manifest into the run:
```bash
{base}/scripts/delegate.sh write-manifest "$RUN_ID" /tmp/manifest.json
```

### Step 2.5 — (Optional) Delegate manifest authoring to a Plan subagent

For non-trivial decompositions (>3 chunks, unfamiliar project, or heavy file analysis), delegate the manifest-authoring to a Plan subagent (Opus, fresh subagent context) instead of doing it in the main session. Hand it the task + project path + a brief on the runner enum, and ask for JSON-only output. Main session reviews the returned manifest and installs via `write-manifest`. Saves main-session tokens on planning. Skip this for simple 2-3 chunk runs — overhead exceeds the benefit. **If the cut tripped the Step 2 ultrathink gate, push that depth into the Plan subagent** — instruct it to ultrathink on the boundary decision — or keep the decomposition in-seat; don't delegate a high-stakes cut to a default-effort subagent.

### Step 3 — Validate + preflight

```bash
{base}/scripts/delegate.sh validate "$RUN_ID"
{base}/scripts/delegate.sh preflight "$RUN_ID"
```

- `validate` checks schema, runner enum, duplicate IDs, dep cycles, **and concurrent file overlaps**.
- `preflight` halts if any target file already exists in the project (override with `--force` if the user explicitly wants to overwrite).

### Step 4 — Confirm with the user

Show the manifest. Get explicit yes before fanning out.

### Step 5 — Prepare workspaces

```bash
{base}/scripts/delegate.sh prepare "$RUN_ID"
```

Creates `$RUN_DIR/<chunk-id>/workspace/` for every chunk. **This is where chunks write.** They never write directly to the project.

### Step 6 — Fan Out (parallel)

Resolve absolute workspace paths up-front so each chunk gets a self-contained prompt:

```bash
WS_C1=$({base}/scripts/delegate.sh workspace "$RUN_ID" chunk-1)
```

**Build the brief with the `subagent-brief` skill.** Every spawn — Opus, Sonnet, Haiku, Fable, Codex — gets its prompt built through `subagent-brief`, which bakes in the operator doctrine, the verification-gates rules, the drone persona and first-person voice, the authority boundaries, and the output contract. The blocks below show the *chunk-specific* contract that `subagent-brief` wraps; they are not a substitute for it. A hand-rolled brief produces a drone that drifts to default habits, and its report becomes this session's claims.

**Opus / Sonnet / Fable subagent chunks** — Agent tool, background, no worktree isolation (we don't need git). The `model` field accepts `sonnet | opus | haiku | fable`. Quality-first default is `model="opus"` (`opus-subagent`); use `model="sonnet"` only for wide, tightly-specified fan-outs, and `model="fable"` only for a named Fable lane with the meter checked. Same prompt shape for all three:
```
Agent(
  subagent_type="general-purpose",
  model="opus",
  run_in_background=True,
  prompt="""
You are chunk-1 of a delegated build.

PROJECT (read-only context — do not modify): /Users/.../my-project
WORKSPACE (write here, relative paths under it): /tmp/delegate/<run-id>/chunk-1/workspace

Create exactly these files inside WORKSPACE:
  - src/foo.ts
  - src/foo.test.ts

[intent here]

When done, run: cd WORKSPACE && <verification command using ABSOLUTE imports>
Report: file list + test summary in your final message.
"""
)
```

**Haiku subagent chunks** — same Agent shape as Sonnet but `model="haiku"`. Use only for narrow text/data work (see "When to Use Haiku vs Sonnet"):
```
Agent(
  subagent_type="general-purpose",
  model="haiku",
  run_in_background=True,
  prompt="""
You are chunk-3 of a delegated build (Haiku tier — narrow scope, trivial verification).

PROJECT (read-only context): /Users/.../my-project
WORKSPACE (write here): /tmp/delegate/<run-id>/chunk-3/workspace

Task: classify each block in INPUT.json as one of {transactional, marketing, system}.
Output: a single classifications.json file with shape [{id, category, confidence}].
Verification: jq '.[] | select(.category | IN("transactional","marketing","system") | not)' classifications.json must return empty.
"""
)
```

**Codex chunks** — `--dir` points at the chunk workspace, `--add-dir` (read) points at the project:
```bash
{base}/codex/scripts/codex.sh run "<intent + same workspace contract>" \
  --dir "$WS_C1" --sandbox workspace-write
```

Mark each chunk `running` as you launch:
```bash
{base}/scripts/delegate.sh set "$RUN_ID" chunk-1 status=running
```

### Step 6.5 — While the fan-out runs

Don't idle — the prompt cache (300s TTL) goes cold past ~270s, costing you on the QA gate. Use the 30s–5min productively: draft the summary skeleton, pre-load audit conventions, write the QA edge-case checklist. Full pattern: `references/orchestration-patterns.md` → "While the fan-out runs".

### Step 6.6 — Liveness gate (mandatory before you report or wait further)

**A missing completion notification is not evidence of progress.** A backgrounded agent can hang silently and never emit a stop event, so "no notification yet" means *unknown*, not *alive*. Never tell the user a chunk is "still running" without an observation.

```bash
{base}/scripts/delegate.sh liveness "$RUN_ID"           # default window: 300s
{base}/scripts/delegate.sh liveness "$RUN_ID" --stale-secs 600
```

Two signals per `running` chunk, both of which actually exist on disk: the **spawn stamp** (`<chunk-id>/.spawned`, written by `set status=running`) and the **newest artifact mtime anywhere under `<chunk-id>/`** — workspace files, `codex.jsonl`, `result.txt`, whatever that runner emits.

| Verdict | Meaning | Action |
|---------|---------|--------|
| `ALIVE` | An artifact moved inside the stale window | Keep waiting; report "running" honestly |
| `BOOTING` | No artifacts yet, spawned less than `--grace-secs` ago (default 90s) | Normal. Not a failure — a chunk that reasons before it writes is still working |
| `SILENT` | No artifacts and past the grace window | Treat as stalled |
| `STALLED` | Has artifacts, none moved inside the window | **Re-spawn once, into a clean workspace** (`prepare` re-creates it — never re-spawn onto a live agent's files). If it stalls again, `abort` |

Exit codes: `0` all advancing or booting · `2` any `SILENT`/`STALLED` · `3` the run is unusable (an `ABORTED` marker exists, or `state.tsv` is missing/empty). **Exit 3 is the fail-closed case** — a gate that reports OK over a destroyed run is worse than no gate. Run it before every status report during a fan-out, and always before Step 7. Stale signals + no output = **stalled** — say so; do not narrate it as still working.

### Step 7 — Collect

When each agent/codex run returns, update state:

```bash
{base}/scripts/delegate.sh set "$RUN_ID" chunk-1 \
  status=done tokens=1234 duration_ms=4500 result=pass:5/5
```

On failure, set `status=failed` and copy the error into `result=…`. **Do not** auto-retry *hard* failures — surface to the user. (Transient failures — `timeout`/`429`/`ECONNRESET`/`503` — get exactly one silent retry; see the transient-vs-hard policy in `references/orchestration-patterns.md`.)

> On failure, see retry policy in `references/orchestration-patterns.md` (transient vs hard failure handling).

### Step 8 — Audit

```bash
{base}/scripts/delegate.sh audit "$RUN_ID"
```

Catches: chunks that produced files not declared in `files_touched`; the same file emitted by two different chunks. If either fires, halt and ask the user how to proceed — **do not auto-resolve.**

### Step 9 — Apply

```bash
{base}/scripts/delegate.sh apply "$RUN_ID"
```

Copies each `done` chunk's workspace into the project, preserving relative paths. Prints `APPLIED: <path> (from <chunk-id>)` per file and a final `APPLIED_CHUNKS: N`.

### Step 10 — QA gate

```bash
{base}/scripts/delegate.sh qa "$RUN_ID"
```

Runs each chunk's `verification` in the project root, then runs `project_verification`. Prints `PASS|FAIL` per check and `QA_PASS: N/N` or `QA_FAIL: N/M failed` at the end.

If anything fails: show the failure, show the offending chunk's `diff` (`delegate.sh diff "$RUN_ID" <chunk-id>` lists files), ask how to proceed.

### Step 10.5 — Dual-model QA review (major runs)

Mechanical QA (Step 10) verifies that tests pass. It does not verify that the code is **good** — correct, idiomatic, safe, free of subtle bugs, complete. For major runs, a second pass is mandatory: **Opus 5 reviews in the main session, Codex `gpt-5.5` reviews in a fresh background context, both in parallel, then the orchestrator reconciles and fixes.**

#### When this step fires (the "major" trigger)

Run dual-model review if **any** of the following hold:

| Trigger | Threshold |
|---------|-----------|
| Chunk count | ≥3 chunks applied (excluding pure review runs) |
| Files changed | ≥5 files written to the project |
| Risk surface (fires at **any** size — a 1-line change still trips it) | Touches auth, payments, migrations, billing, security, data-loss-capable paths, or anything that ships to real users: **Liquid / personalisation logic, Braze segment or canvas entry filters, customer-facing sends, lifecycle / email content, production data writes**. Route by *blast radius, not diff size* — the riskiest changes are often the smallest. |
| Lines of code | ≥300 net new lines across the run |
| User flag | User said "high-stakes", "critical", "production", "ship-ready", or explicitly requested review |

For runs that don't trip any trigger (1-2 chunk runs, scratch work, prototypes), skip straight to Step 11. The overhead of dual review is not worth it for trivial work.

**Do NOT skip this step on a major run to "save time".** The reconcile-and-fix loop is exactly where bugs get caught before they ship. Mechanical QA passing is necessary but not sufficient.

#### How to run it

**1. Spawn both reviews in parallel** (same message, two tool calls):

- **Opus review** — Agent tool, `subagent_type="general-purpose"`, no `model=` override (inherits Opus from the orchestrator session). Fresh context window — the subagent has not seen the build conversation, so it reviews the applied code cold. Hand it: the project path, the list of files changed, the original task description, the manifest, and the review dimensions below.
- **Codex review** — `{base}/codex/scripts/codex.sh run` with `--effort high --model gpt-5.5`, background. Hand it the same brief. Codex's review writes `review-codex.md` to a temp workspace. (Sol used to hold this lane and found more real bugs than 5.5 at lower precision — but Sol is no longer servable on this account, so `gpt-5.5` is the review model. Never substitute Terra here: measured recall regression. Figures: **Model Facts**.)

Both reviewers MUST be given:
- The original task and manifest (so they know what was supposed to be built).
- The exact list of files changed (so they know where to look).
- The project path (read-only for both — they do not modify code).
- The dimensions: **correctness, edge cases, missing tests, security, scalability, conventions, completeness vs. spec**.
- The output shape: structured findings with severity (`blocker` / `major` / `minor` / `nit`), file:line refs, and a concrete fix recommendation per finding.

Use the review template in `references/prompt-templates.md` (the `/delegate review` template) as the base, adapted for "review this just-applied delegate run" framing.

**2. Collect both reviews.** Read them into the main session. Do NOT have either reviewer fix anything — reviewers review, the orchestrator decides.

**3. Reconcile** in the main session (this is Opus orchestrator work):

| Reconciliation step | What you do |
|---------------------|-------------|
| Dedupe | Same issue flagged by both reviewers → single finding with both citations |
| Resolve conflicts | Reviewers disagree → orchestrator decides, names the reasoning in one line. On a *blocker*-level conflict the orchestrator genuinely can't call, escalate that one finding to a Fable 5.1 delegate and take its verdict as the tie-break (see "Fable 5.1 routing") |
| Prioritise | Sort: blockers → majors → minors → nits |
| Filter | Drop nits unless trivial to fix; drop findings the user explicitly accepted as out of scope |
| Produce a reconciled punch list | Markdown, severity-grouped, with file:line refs and the agreed fix per item |

**4. Surface the reconciled list to the user.** Lead with: blockers count, majors count, your recommended action (ship as-is / fix-then-ship / re-architect). Get explicit yes before fixing.

**5. Fix the agreed items.** Use the same delegation calculus:
- Single-file mechanical fixes → do inline in main session.
- Multiple independent fixes → fan out via a follow-up `/delegate run` with the punch list as the task.
- One deep correctness fix → 1-chunk Codex run with `--effort high`.

**6. Re-run mechanical QA** (`delegate.sh qa "$RUN_ID"`) after fixes land. If it fails, loop. If it passes, proceed to Step 11.

**7. Re-review only if blockers were fixed.** If only minors/nits were patched, trust the mechanical QA and move on. Do not infinite-loop the review pass.

#### Anti-patterns specific to this step

- **Skipping reconciliation** — handing two raw review files to the user is lazy and noisy. Reconciliation is the orchestrator's job.
- **Auto-fixing without confirmation** — even when both reviewers agree, the user gets to see the punch list and approve scope before fixes land. Some findings will be deliberate design choices.
- **Running both reviews sequentially** — they're independent; parallel is free latency. Same message, two tool calls.
- **Letting reviewers see each other's output** — model-diversity is the point. Each reviewer must produce findings independently.
- **Treating Codex's `do-not-ship` verdict as veto** — Codex is opinionated and sometimes wrong. Weigh both reviewers, decide in the main session, be willing to overrule with reasoning.

### Step 11 — Present

```bash
{base}/scripts/delegate.sh summary "$RUN_ID"
```

Shows the run header + the full state.tsv as a column-aligned table. Lead the user with: chunks done, files added, mechanical QA result, dual-review result (if Step 10.5 ran), reconciled findings fixed, run_id (for resume).

## Resume

If a chunk fails or the user kills the run:

```bash
{base}/scripts/delegate.sh resume          # uses last run
{base}/scripts/delegate.sh resume <run-id> # specific run
{base}/scripts/delegate.sh pending <run-id> # just the chunk ids
```

Re-fan only the `pending` and `failed` chunks. State.tsv preserves the rest.

```bash
{base}/scripts/delegate.sh abort <run-id> [reason]
```

`/delegate abort <run-id> [reason]` — Mark all running chunks `failed` with `result=aborted:<reason>`, write an `ABORTED` marker, prevent the apply step from running. The orchestrator should call this when it has *evidence* of a runaway chunk — `liveness` returning `STALLED` for the same chunk twice with a re-spawn in between, contradictory state, or an obvious loop in stdout. Never abort off a single reading. Re-fan via `/delegate resume` after the root cause is fixed.

## Self-Healing

If scripts break, edit them directly — you have authorization to modify anything under `{base}/`:
- `scripts/delegate.sh` — the entire engine (init, validate, audit, apply, qa, etc.)
- `scripts/detect-verification.sh` — auto-detect test commands
- `scripts/check-model-facts.sh` — enforces the Model Facts invariant across SKILL.md + `references/`. Run it after any model-layer edit; exit 1 means a figure escaped the block
- `references/routing.md` — full decision tree
- `references/manifest-schema.md` — JSON schema + examples
- `references/orchestration-patterns.md` — sequencing patterns
- `references/prompt-templates.md` — chunk prompt templates

Set `DELEGATE_DEBUG=1` to enable an ERR trap that prints the failing line + command + exit code.

## Surface notes — Desktop, CLI, and Agent Teams

**Desktop ↔ CLI parity (confirmed 2026).** This skill works identically on the Desktop app and the terminal CLI — same triage, same fan-out, same QA gates. Desktop's documented gaps (no launch-time `--model` / `--permission-mode`, no autonomous `/loop`) don't block the core flow.

**Agent Teams (experimental) is an escape hatch, not a fan-out default.** The `opus-subagent` / `sonnet-subagent` / `haiku-subagent` runners cover ~95% of needs. Reach for Agent Teams (or a CLI subprocess) ONLY when a chunk needs: a >150K context (try `opus-1m-cli` first), project-scoped MCP servers the orchestrator lacks, different hooks, a lifetime outlasting the orchestrator session — or the user asks for it by name. State the call out loud like any other delegation call. It is **not** wired into `delegate.sh` as a runner enum; don't speculate-build the integration before a real chunk needs it.

**Never use the Agent Teams mailbox for chunk-to-chunk traffic.** This skill's manifest contract makes chunks independent. If chunks need to coordinate, the decomposition is wrong — re-author the manifest.

Full detail — parity gaps, the trigger table, the CLI-subprocess trade-off table, and the Outcomes preview: `references/orchestration-patterns.md` → "Surface notes".

## Anti-Patterns

- Do NOT report a spawned chunk as "running" without a `liveness` observation. A missing completion notification means *unknown*, not alive — a hung agent never emits a stop event.
- Do NOT hand-roll a chunk brief. Every spawn goes through the `subagent-brief` skill; a hand-rolled drone drifts to default habits and its report becomes this session's claims.
- Do NOT put a model figure anywhere outside **Model Facts**. Numbers restated in a routing table go stale silently and mis-route at the moment of choice — reference the lane, not the decimal. `scripts/check-model-facts.sh` enforces this; run it after any model-layer edit.
- Do NOT ship a gate you have only tested on synthetic state. A gate that fails *open* — reporting OK over a destroyed run, or dying before it evaluates the remaining chunks — is worse than no gate, because it converts "unknown" into a false "fine". Test every verdict path, including the ones that should refuse.
- Do NOT delegate a chunk that touches the same file as a concurrent chunk. `validate` will refuse to run, but don't try.
- Do NOT auto-resolve audit failures (undeclared files, cross-chunk file overlap). The user decides.
- Do NOT fan out *trivial* work — a single tiny edit with healthy context isn't worth the coordination overhead. But scope and parallelism (Q1/Q4) override context-health: a genuine multi-file or multi-unit task delegates even from a near-empty session. The gating metric is Q2 (*would in-session execution burn >30% of remaining context*), not raw context-already-used.
- Do NOT use this for conversational tasks or single-file edits — just do them.
- Do NOT skip `preflight`. Overwriting the user's in-progress work is the worst-case failure mode.
- Do NOT let chunks write directly into the project path. Workspaces only.
- Do NOT skip Step 10.5 (dual-model QA review) when a run trips any "major" trigger — chunks ≥3, files ≥5, risk surface, ≥300 LOC, or user-flagged. Mechanical QA passing is necessary, not sufficient.
- Do NOT auto-apply fixes from the reconciled review punch list. Surface, get approval, then fix.
- Do NOT burn Opus on mechanical work (renames, boilerplate, pattern-mirroring, dependency bumps) — that's 1-chunk Sonnet. Opus stays for design, tradeoffs, synthesis, orchestration.
- Do NOT route code chunks to Haiku to save money — it silently misses subtleties Sonnet catches. Haiku is for *trivially-verifiable* text/data work only.
- Do NOT reflexively enable extended thinking on Sonnet/Haiku — it hurts intuitive-task performance. Reserve for genuinely deliberative subproblems.
- Do NOT subprocess-spawn the `claude` CLI as a default fan-out path — in-session subagents cover ~95% of needs. Subprocess is for 1M / isolation edge cases only.
- Do NOT seat the orchestrator on a 1M-bloated context — its work is small-context, and bloating the seat degrades reasoning and trashes the cache. 1M is a *target*, never a *seat*.
- Do NOT flip to 1M Opus instead of handoff — at 75%+ context, handoff is cheaper and cleaner. A 1M flip is a last-resort needing the user's explicit yes.
- Do NOT route to 1M Opus when decomposition would solve it — splitting into Sonnet-sized sub-units wins on cost, latency, parallelism, and cache. 1M is for irreducible read surfaces only.
- Do NOT spend Fable on mechanical, tightly-scoped, or replicated work — renames, boilerplate, a test from a written spec, a fan-out of near-identical chunks. Fable usage is metered and finite; burning it there means the one chunk that genuinely needed it finds the meter empty.
- Do NOT stall, ask, or downgrade past Opus 5 when Fable runs out. Opus 5 takes the seat, the `fable-subagent` lane closes, and every other part of the flow is unchanged — say it in one line and carry on.
- Do NOT treat Fable as "model diversity" in QA — it's still a Claude model (depth, not diversity). Codex remains the cross-family reviewer; Fable breaks a tie.
- Do NOT default Fable to `xhigh`/`max` — start at `high`, climb only on a concrete signal. Reflexive `max` on a metered tier is the fastest way to spend the budget you were protecting.
- Do NOT accept a Codex Sol chunk's self-reported "tests pass" — METR measured GPT-5.6 Sol with the highest reward-hacking rate of any public model they've assessed. The orchestrator's own Step 10 QA run is the only evidence that counts.
- Do NOT route Codex work to Terra or Luna — Terra measurably regresses on adversarial review and bloats long-horizon token spend; Luna duplicates Haiku's lane. Sol is the only 5.6 tier this skill calls.
- Do NOT use Codex `ultra` inside a delegate run — it is not a reasoning tier at all (the API effort enum is `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`); it is a CLI-level switch that spawns Codex's own subagent fan-out and double-orchestrates against the manifest contract. (Standalone wholesale Codex tasks MAY use `ultra` — the ban is contract-scoped, not quality-scoped — but only after clearing all four conditions of the **ultra gate** in § "Codex tier rules". Failing the gate, reach for `--effort xhigh`/`max`.)
- Do NOT escalate to Fable 5.1 without naming the lane. It genuinely sits above Opus 5, so the old capability argument for holding back is gone — but the meter is finite, so "this is hard" is not a lane. Long-horizon autonomy, hardest-repo judgment, a plateaued correctness cut, a blocker tie-break. Name one or stay in-seat.
- Do NOT route to Fable 5 (`claude-fable-5`). Fable 5.1 supersedes it in the same tier at the same per-token price; there is no remaining lane for 5. Mythos 5.1 is the same model behind an approved-organisation gate — not a route unless the account has it.
- Do NOT route new work to Opus 4.8. Opus 5 supersedes it at identical pricing with a better score on every published benchmark. There is no remaining lane for 4.8 in this skill.

---
name: intelligent-delegation
description: PRIORITISE at the START of EVERY new session, EVERY non-trivial task, AND EVERY follow-up turn that adds scope, pivots topic, or reveals unexpected complexity — BEFORE reading files, spawning Explore subagents, or implementing anything. Run the 6-question triage: scope / context / fresh-window / parallelism / large-surface-1M / model-fit. If any fires, delegate — fan out to Opus/Sonnet/Haiku/Codex subagents, route a >150K read surface to a 1M subprocess, escalate a named-lane sub-problem to Fable; only stay in-session when none fire AND Opus-5-level reasoning is genuinely required. Default aggressive — when in doubt, re-triage. Always fires on 'delegate', 'fan out', 'parallel build', 'decompose this task', 'hand off to codex', or a multi-part build request. Mandatory re-triage on scope additions ('also do X', 'and now Y', 'next, can you...', 'while you're at it'), topic pivots, replicated work ('apply the same to Y'), session-handoff resumptions, post-compaction turns, or any 'this is bigger than I thought' moment. Reactive fallbacks: 2+ files already read this turn, 2+ independent files/features/deliverables in the request, or about to read a 3rd file. Skip ONLY for: conversational replies, status questions answerable from memory/git/a single tool call, single-line single-symbol edits, or one-file one-read lookups.
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
6. **Model fit** — *only ask this if 1–5 are all no.* Two directions. **Down:** does the task genuinely need Opus-level reasoning (multi-file design, architectural tradeoffs, ambiguous spec, nuanced review)? If not, delegate it to a single Sonnet or Codex sub-agent for efficiency. **Up:** is the task *harder than Opus 5* — a multi-day-autonomy grind or the subtlest correctness problem where Opus 5 has plateaued? If so, escalate that sub-problem to a Fable 5 delegate (a target, never the seat — see "Fable 5 routing"). Note the bar is now high: Opus 5 edges Fable on general intelligence and SWE-bench Verified, so "escalate to Fable" is a narrow, evidenced call, not a reflex. Most work sits in Opus 5's band and stays in-session.

**The decision rule:**

- **ANY of 1–4 yes** → start the delegate flow. `/delegate plan "<task>"` for non-obvious decompositions, `/delegate run "<task>"` once you have the manifest. For a single deep task, a 1-chunk delegate run to Sonnet or Codex still wins on fresh context — parallelism is an optimisation, fresh-context is the primary value.
- **Q5 yes (large-surface)** → route THAT chunk (or the whole task if it's a 1-chunk job) to a **1M-context Opus 5 subprocess**. Do NOT flip the orchestrator session to 1M — keep the seat lean. The chunk runs as a Bash subprocess: `claude -p "<self-contained prompt>" --model claude-opus-5 --permission-mode plan`. See "1M Context Routing" for the full pattern.
- **1–5 all no, but Opus reasoning NOT required** → still delegate, but as an *efficiency* 1-chunk run, not a parallelism run. Route to Sonnet sub-agent (mechanical edits, boilerplate, clear-pattern work, simple refactors, generation from a tight spec) or Codex (single-file adversarial review, narrow precision fix). The orchestrator (Opus) writes the brief, delegates, reviews the returned diff. Do NOT burn Opus on work that Sonnet or Codex would do better and cheaper.
- **1–5 all no AND Opus reasoning required** → proceed in-session. Log the call in one line so the user can override.
- **Per-chunk apex check (fan-out runs).** Q6 gates on "1–5 all no", so a run that already triggered on scope/parallelism skips the top-level model-fit question. Re-apply its *upward* direction during decomposition: if any individual chunk is harder than Opus 5 (a multi-day-autonomy grind, a proof-shaped correctness chunk), mark that chunk `fable-subagent`. The orchestrator seat stays Opus 5.

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

## Model Routing — the tier table

| Tier | Model | Session | Use for |
|------|-------|---------|---------|
| **Orchestrator** | **Opus 5 (`claude-opus-5`, main session, adaptive `xhigh` thinking)** | Stays | Decompose, review diffs, QA, reconcile dual-model reviews, talk to the user |
| **Apex reasoning** | **Fable 5 (`Agent(model="fable")`, or CLI subprocess for 1M)** | Subagent / subprocess (fresh) | The narrow class of sub-problem that still outruns Opus 5: multi-day-autonomy grind, SWE-bench-Pro-shaped repo judgment, blocker-conflict tie-break. A *target*, never the seat — and no longer a general upgrade. See "Fable 5 routing" below. |
| **QA reviewer A** | Opus 5 (fresh subagent) | Subagent | Cold semantic review of an applied major run (Step 10.5) |
| **QA reviewer B** | Codex GPT-5.6 Sol `--effort high` | Background | Adversarial review of an applied major run, parallel to reviewer A (Step 10.5). Cross-*family* diversity at near-apex depth — Fable is cross-*depth*, not diversity. Never Terra for review (measured recall regression — **Model Facts**). |
| **Planning** | Opus 5 (Plan subagent) | Subagent | Architecture, multi-file refactor design. A Fable Plan delegate is now rarely the better call — exhaust in-seat ultrathink first. |
| **Build** | Opus 5 (`opus-subagent`) when build quality dominates; Sonnet 5 (`sonnet-subagent`) for wide, tightly-specified fan-outs where wall-clock and cost matter | Fresh per chunk | Parallel independent implementation chunks (multi-file, project-conventions-aware) |
| **Precision** | Codex GPT-5.6 Sol | Background | Adversarial review, deep algorithms, second opinions, long terminal/tool-loop agentic chunks (Sol's measured lane) |
| **Large-context** | **Opus 5 1M (native 1M window; via CLI subprocess to keep it off the orchestrator seat)** | Subprocess (fresh session) | Single chunks whose *read surface* exceeds ~150K tokens: monorepo-wide review, big PDF/transcript ingest, multi-hundred-file analysis, log forensics. Never the orchestrator seat. |
| **Cheap parallel** | Haiku 4.5 (Agent, `model="haiku"`) | Fresh per task | High-volume narrow tasks at scale: classify/tag, format-convert, bulk mechanical text edits, smoke checks, per-row enrichment |
| **Lookup** | Haiku 4.5 (Explore subagent) | Subagent | File location, grep-for-symbol, quick searches |
| **Integration** | Opus 5 (main session, in-line) | Stays | runner: `main` chunks — cross-cutting edits, package.json, config wiring, glue between sibling chunks |

Full decision tree with per-tier rationale: `references/routing.md`. Every number behind these calls: **Model Facts**, below.

Use `runner: main` sparingly — typically the final chunk in a chain when integration genuinely requires orchestrator context (sibling-chunk awareness, cross-file decisions). Most code chunks are `opus-subagent` (best per-chunk quality) or `sonnet-subagent` (wide, tightly-specified fan-outs — cheaper and faster) or `haiku-subagent` for high-volume trivially-verifiable text/data work.

### Codex tier rules (GPT-5.6 family — figures in **Model Facts**)

- **Sol (`gpt-5.6-sol`) is the only 5.6 tier this skill routes to.** Terra regressed on adversarial review recall and is token-verbose on long-horizon work; Luna merely duplicates Haiku's lane cross-family. Claude tiers keep those lanes.
- **Sol's lane is the terminal/tool-loop agentic grind**, plus cross-family review diversity. Since Opus 5 it is a *legitimate target*, not a clear upgrade over keeping the chunk on Opus — route on the lane (grind vs judgment), never on a decimal.
- **Reward-hacking caveat (load-bearing).** METR measured Sol with the highest detected reward-hacking rate of any public model they've assessed. Never accept a Sol chunk's self-reported pass — the orchestrator's own Step 10 QA run is the only evidence that counts. (True for every runner; Sol earns the explicit call-out.)
- **Tier suffix is mandatory** — bare `gpt-5.6` is accepted by the CLI but rejected by the API. GPT-5.5 stays available as the fallback if 5.6 misbehaves.
- **`ultra` is not a reasoning tier** — it's a CLI-level switch that spawns Codex's own subagent fan-out. Banned *inside delegate-run chunks* (it double-orchestrates against the manifest contract — a structural ban, not a quality judgment); permitted for standalone wholesale Codex tasks where Codex owns the whole job.

## Model Facts — every number that ages, in one place

> **Verified 2026-07-27.** This is the **only** place in this skill — SKILL.md *and* every file under `references/` — that carries a figure which ages: benchmarks, prices, context windows, cutoffs, measured regressions. Everywhere else names *lanes and rules*, never numbers. When a model lands or a benchmark moves, re-verify **here and nowhere else**; a figure found outside this block is drift — delete it, don't update it. Enforced by `scripts/check-model-facts.sh` — run it after any model-layer edit.
>
> Prices are written without dollar signs (a literal `$N` gets argument-substituted when this skill is invoked with args) and are **intuition only — cost is not a routing input**.

**Lineup**

| Model | ID | Ctx | Max out | in/out per MTok | Cutoff | Notes |
|-------|----|-----|---------|-----------------|--------|-------|
| **Opus 5** | `claude-opus-5` | 1M | 128K (300K on Batch via `output-300k-2026-03-24`) | 5/25 | May 2026 | Released 2026-07-24. Adaptive thinking **on by default** when `thinking` is omitted (changed from 4.8). Effort low→max, default `high`. Fast mode bills 2× → 10/50. |
| **Fable 5** | `claude-fable-5` | 1M | 128K | 10/50 | Jan 2026 | Thinking always-on. Anthropic's nominal "most capable widely released model". Effort low→max, default `high`. |
| **Sonnet 5** | `claude-sonnet-5` | 1M | 128K | 3/15 (2/10 intro thru 2026-08-31) | — | Adaptive thinking, no extended thinking. |
| **Haiku 4.5** | `claude-haiku-4-5-20251001` | 200K | 64K | 1/5 | — | Only current model still on classic extended thinking rather than effort/adaptive. |
| **Codex GPT-5.6 Sol** | `gpt-5.6-sol` | 1M | 128K | 5/30 | — | Subscription-billed in practice. Terra 2.50/15 and Luna 1/6 exist but are not routed to. |
| ~~Opus 4.8~~ | `claude-opus-4-8` | 1M | 128K | 5/25 | — | **Retired from this skill.** Superseded by Opus 5 at identical price, better on every published benchmark. No remaining lane. |

**Benchmarks that drive the routing calls** (max-reasoning configurations)

| Signal | Opus 5 | Fable 5 | Codex Sol | Consequence |
|--------|--------|---------|-----------|-------------|
| AA Intelligence Index | **61** (#1 of 190) | 60 | 59 | Seat stays Opus 5 |
| SWE-bench Verified | **~96–97%** | ~95% | — | Seat stays Opus 5 |
| SWE-bench **Pro** (hardest repo judgment) | behind | **~80%** | 64.6% | Fable's surviving lane |
| Frontier-Bench v0.1 (agentic coding) | **43.3%** | 33.7% | — | Opus 5, decisively |
| GDPval-AA (Elo) | **1861** | 1747 | — | Opus 5 |
| OSWorld 2.0 (computer use) | **70.57%** | lower | — | Opus 5, at ~⅓ cost |
| Terminal-Bench 2.1 | 84.64% | — | **85.77%** | Sol's ~1pp edge — narrow, lane-based call only (Sonnet 5: 74.53%) |
| ARC-AGI-2 | ~90% | — | **~92–93%** | Sol |
| AA Coding Agent Index | 78 (xhigh, CC harness) | — | 77–80 | Effectively tied |
| Longest-horizon autonomy | behind | **ahead** | — | Fable's other surviving lane |
| Adversarial review recall | — | — | Sol **+7.4pp** vs 5.5, ~32% precision; **Terra −8.6pp** | Sol-only review lane; expect noise, reconcile it |
| Long-horizon efficiency | — | — | Sol 63.7% @ ~21K out; **Terra 40.7% @ ~55K** | Terra ban |

> **Snapshot caution.** The AA Coding Agent Index is re-scored as models are added — two fetches in July 2026 returned different absolutes for the same models. Treat every figure here as dated. Route on the *lane*, not the decimal.

**Behavioural figures that also age**

| Figure | Value | Consequence |
|--------|-------|-------------|
| Extended thinking on *intuitive* tasks | measured **~36%** performance regression | Default thinking OFF on Sonnet/Haiku code chunks — never enable it reflexively |
| Sibling-chunk prompt-cache reuse (May 2026) | `cache_creation` cost down **~3×** when fan-out chunks share a stable prompt prefix | Structure chunk prompts with a shared briefing prefix so the hit rate compounds |
| Prompt cache TTL | 5 min default; 1-hour tier available | Stay under ~270s between turns, or commit to ≥1200s |

**API quirks that bite hand-rolled calls** (the Agent tool handles these; raw `claude -p` / SDK calls do not)

- **Opus 5:** no assistant prefill (400) • `thinking:{type:"disabled"}` is valid **only at effort `high` or below** — pairing it with `xhigh`/`max` returns 400 • adaptive thinking runs by default when `thinking` is omitted • cyber/bio safety classifiers mean a declined request returns HTTP 200 with `stop_reason:"refusal"` and a `stop_details.category`, not an exception — branch on `stop_reason` before reading `content`; the `fallbacks` beta auto-reruns on a fallback model.
- **Fable 5:** an explicit `thinking:{type:"disabled"}` returns 400 — omit the param entirely.
- **Codex CLI (probed locally against codex-cli 0.144.1):** the API's validation error enumerates the real effort ladder — `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `ultra` is **not** on it.

## Fable 5 routing — apex reasoning target (never the default seat)

**The rule.** Opus 5 holds the seat; Fable is a target for two narrow lanes. Escalating to Fable is a **lateral trade, not an upgrade** — it buys multi-day-autonomy stamina and hardest-repo-judgment depth, and costs four months of world knowledge, 2× price, and a lower general-intelligence score (**Model Facts**). **Name which of Fable's two lanes you are buying before you spawn it. If you can't name one, stay on Opus 5.**

Why the seat stays Opus 5, in one line each: it is the more intelligent seat outright; the seat pays its premium on every coordination turn (~80% of them); orchestration is agentic and Opus 5 is the agentic flagship; the seat's knowledge cutoff is load-bearing (it reasons about the lineup it is routing); apex reasoning belongs at the few *gates* verification can't catch, not across the whole session; and latency is free in a background delegate but exposed in the interactive seat. Full argument with evidence: `references/routing.md` → "Seat topology".

**Where Fable 5 still earns the spawn** — escalate only when Opus 5 has genuinely plateaued on a *narrow, high-leverage* sub-problem that sits in one of Fable's two surviving evidenced lanes. Shape check first: if the plateaued sub-problem is *agentic-grind-shaped* (a long terminal/tool-loop execution slog rather than a judgment problem), Codex Sol is the better escalation. Fable is for stamina and hardest-repo judgment.

| Use Fable 5 for | Spawn |
|-----------------|-------|
| **Multi-day / longest-horizon autonomy** — a single delegate that must stay coherent across an extended unsupervised run. Fable's clearest surviving edge. | 1-chunk `fable-subagent`, background |
| **SWE-bench-Pro-shaped repo judgment** — the hardest class of real-repo change, where Fable's lead over Sol is the relevant signal and Opus 5 has visibly stalled | 1-chunk `fable-subagent` (CLI subprocess if it also needs a >150K read surface) |
| **Blocker-conflict reconciliation** — Step 10.5 reviewers (Opus 5 + Codex) disagree on a *blocker* and the orchestrator can't confidently adjudicate | Escalate that one finding to Fable as a *third, independent* opinion. Note it is a tie-break by independence, not by authority — Fable no longer outranks the Opus 5 seat on general reasoning. |

**No longer a Fable lane (moved back to the Opus 5 seat, 2026-07-27):** research-grade decomposition and subtlest-algorithmic-correctness. Opus 5 now leads on general intelligence and SWE-bench Verified, so the old "escalate the hard cut to Fable" reflex spends 2× for a lower-scoring model. Use in-seat ultrathink at the planning gate instead; escalate only if ultrathink demonstrably plateaus AND the problem is stamina- or repo-judgment-shaped.

**The seat carve-out.** A short, uniformly-hard task with almost no coordination overhead to dilute the premium is the one case where seating Fable is defensible — bought for **stamina**, not raw reasoning. It needs an explicit yes, never a unilateral flip; state the trade-off exactly like the 1M flip. Full reasoning: `references/routing.md` → "Seat topology".

**Mechanical notes:**

- Fable spawns natively via the Agent tool — `Agent(subagent_type="general-purpose", model="fable", run_in_background=True, ...)`. Unlike 1M-Opus, **no CLI subprocess is required**. Use one only if the Fable chunk also needs a >150K read surface or isolated MCP/hooks.
- Runner enum: `fable-subagent` is wired into `delegate.sh validate` and `references/manifest-schema.md`. Step 6 fan-out uses the standard spawn block with `model="fable"`.
- Thinking and effort quirks for raw CLI/API calls: see **Model Facts** → "API quirks". Effort defaults to `high`, not `xhigh`, on both tiers — climb only on a concrete signal (the delegate self-reports low confidence, its verdict conflicts with both Step 10.5 reviewers, or its output fails verification).
- Discipline: Fable is not a "just in case" upgrade, and it is **not** model-diversity for QA — it's still a Claude model. Codex Sol remains the cross-family reviewer; Fable is depth of a different shape, not diversity.

## Effort Levels per Runner

| Runner | Effort control | Default | Override |
|--------|---------------|---------|----------|
| **Orchestrator (Opus 5)** | Adaptive thinking (`xhigh` default in Claude Code); **explicit ultrathink at the planning gate** | Full + adaptive | Stay on Opus 5; never switch to Sonnet manually. Adaptive thinking is on by default here (new in Opus 5) — but at the decomposition gate (Step 2), *force* the ceiling with ultrathink rather than trusting adaptivity to find it; a bad cut is the one orchestrator error no verification catches |
| **Apex (Fable 5)** | `effort` (sweep `medium`/`high`/`xhigh`) + always-on thinking | `high` | Start at `high`, not `xhigh`; climb only if the sub-problem demands it. Never send `thinking:{type:"disabled"}` (400 on Fable — omit the param) |
| **Sonnet subagents (Sonnet 5)** | Model tier + adaptive thinking | Adaptive (default) | Set `thinking="extended"` for genuinely deliberative tasks (math, multi-step symbolic reasoning); default OFF for code chunks — extended thinking measurably hurts on intuitive tasks (**Model Facts**) |
| **Codex (GPT-5.6 Sol)** | `CODEX_EFFORT` env var → `model_reasoning_effort` — real API ladder: `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` | `high` | `CODEX_EFFORT=xhigh` for deep algorithmic work or adversarial review (matches the local config pin). **`ultra` is not on this ladder** — it's a CLI-level orchestration switch that spawns Codex's own subagent fan-out. Permitted ONLY for standalone wholesale Codex tasks where Codex owns the whole job; never inside a delegate-run chunk — it double-orchestrates against the manifest contract |
| **Haiku 4.5 (Cheap parallel + Explore)** | Model tier + optional extended thinking | OFF | Default OFF for pure lookups/classification/bulk edits. Enable extended thinking only for unambiguous deliberative subtasks — rare for Haiku-suitable work |

**Session advice:** Start and stay on Opus 5. The skill routes sub-runners automatically. Switching to Sonnet manually to "save tokens" just degrades the orchestrator — the planning and QA gates are where Opus earns its keep. Adaptive thinking on Opus is the new default — don't fight it; it spends thought where the task warrants it.

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

Haiku 4.5 is the **volume-and-latency** tier — not primarily a cost play. It earns the spawn when the unit count is high (>10) *and* the verification surface is trivial — "does the output match the spec, yes/no". Use it as Explore subagents (lookups) and as fresh Agent subagents for narrow, mechanically-verifiable chunks. Anything judgment-adjacent goes to Sonnet or Opus.

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

**If Fable 5 is unavailable** (access lapsed, model retired, 400/404 on spawn): do not stall or downgrade silently. The replacement for an apex delegate is **ultrathink on Opus 5 + an independent Codex GPT-5.6 Sol `--effort high` pass on the same sub-problem**, reconciled by the orchestrator — depth via forced thinking budget, blind-spot coverage via cross-family diversity (Sol sits at near-Fable depth on AA's index — **Model Facts** — so the substitute is credible). Note in the run log that the apex tier was substituted.

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

**Planning escalation ladder:** adaptive `xhigh` (default, routine cuts) → **ultrathink in-seat** (high-stakes but Opus-tractable — cheap, no spawn, no latency) → **Fable 5 Plan delegate** (genuinely research-grade decomposition where ultrathink-on-Opus has plateaued; see "Fable 5 routing"). Climb only on a real signal, and exhaust the free in-seat ultrathink *before* reaching for the 2× Fable delegate.

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

**Give every spawn a standard brief, not an ad-hoc one.** Whatever briefing template you use, every chunk prompt should carry the same spine: operating standards, the evidence rule for any claim it makes back to you, its authority boundaries, and an explicit output contract. The blocks below are the *chunk-specific* contract that goes inside that spine — not a substitute for it. A hand-rolled brief produces a sub-agent that drifts to default habits, and its report becomes your session's claims.

**Opus / Sonnet / Fable subagent chunks** — Agent tool, background, no worktree isolation (we don't need git). Use `model="opus"` (`opus-subagent`) when per-chunk quality dominates, `model="sonnet"` for wide tightly-specified fan-outs, and `model="fable"` only for a named Fable lane. Same prompt shape for all three:
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

Mechanical QA (Step 10) verifies that tests pass. It does not verify that the code is **good** — correct, idiomatic, safe, free of subtle bugs, complete. For major runs, a second pass is mandatory: **Opus 5 reviews in the main session, Codex GPT-5.6 Sol reviews in a fresh background context, both in parallel, then the orchestrator reconciles and fixes.**

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
- **Codex review** — `{base}/codex/scripts/codex.sh run` with `--effort high --model gpt-5.6-sol`, background. Hand it the same brief. Codex's review writes `review-codex.md` to a temp workspace. (Sol finds more real bugs than 5.5 did, but at low precision it is noisy — the reconciliation step exists to filter nitpicks, so expect a longer raw list, not a worse one. Never substitute Terra here: measured recall regression. Figures: **Model Facts**.)

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
| Resolve conflicts | Reviewers disagree → orchestrator decides, names the reasoning in one line. On a *blocker*-level conflict the orchestrator genuinely can't call, escalate that one finding to a Fable 5 delegate and take its verdict as the tie-break (see "Fable 5 routing") |
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
- Do NOT hand-roll a chunk brief per chunk. Use one standard briefing spine for every spawn; an ad-hoc brief produces a sub-agent that drifts to default habits, and its report becomes your session's claims.
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
- Do NOT seat the orchestrator on Fable 5 by default — the seat pays its 2× premium on every coordination turn. Fable is a *target* for the single hardest sub-problem; the seat-exception needs the user's explicit yes.
- Do NOT reach for Fable as a "just in case" upgrade — at 2× cost its edge only shows where Opus 5 has visibly plateaued on stamina or hardest-repo judgment. Otherwise it's wasted spend.
- Do NOT treat Fable as "model diversity" in QA — it's still a Claude model (depth, not diversity). Codex remains the cross-family reviewer; Fable breaks a tie.
- Do NOT default Fable to `xhigh`/`max` — start at `high`, climb only on a concrete signal. Reflexive `max` on a 2× model is the priciest way to waste tokens here.
- Do NOT accept a Codex Sol chunk's self-reported "tests pass" — METR measured GPT-5.6 Sol with the highest reward-hacking rate of any public model they've assessed. The orchestrator's own Step 10 QA run is the only evidence that counts.
- Do NOT route Codex work to Terra or Luna — Terra measurably regresses on adversarial review and bloats long-horizon token spend; Luna duplicates Haiku's lane. Sol is the only 5.6 tier this skill calls.
- Do NOT use Codex `ultra` inside a delegate run — it is not a reasoning tier at all (the API effort enum is `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`); it is a CLI-level switch that spawns Codex's own subagent fan-out and double-orchestrates against the manifest contract. (Standalone wholesale Codex tasks MAY use `ultra` — the ban is contract-scoped, not quality-scoped.)
- Do NOT escalate a hard *reasoning* chunk to Fable 5 by reflex. Since Opus 5 (2026-07-24) that spends 2× for a model scoring *below* the seat on general intelligence with a four-month-staler cutoff. Fable is now a lateral trade bought for two specific things — multi-day autonomy stamina and SWE-bench-Pro-shaped repo judgment. Name the lane or stay on Opus 5.
- Do NOT route new work to Opus 4.8. Opus 5 supersedes it at identical pricing with a better score on every published benchmark. There is no remaining lane for 4.8 in this skill.



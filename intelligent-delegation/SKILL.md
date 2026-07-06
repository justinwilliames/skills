---
name: intelligent-delegation
description: PRIORITISE at the START of EVERY new session, EVERY non-trivial task, AND EVERY follow-up turn that adds scope, pivots topic, or reveals unexpected complexity — BEFORE reading files, spawning Explore subagents, or implementing anything. Run the 6-question triage: scope / context / fresh-window / parallelism / large-surface-1M / model-fit. If any fires, delegate — fan out to Sonnet/Haiku/Codex, route a >150K read surface to a 1M subprocess, escalate a beyond-Opus sub-problem to Fable; only stay in-session when none fire AND Opus-level reasoning is genuinely required. Default aggressive — when in doubt, re-triage. Always fires on 'delegate', 'fan out', 'parallel build', 'decompose this task', 'hand off to codex', or a multi-part build request. Mandatory re-triage on scope additions ('also do X', 'and now Y', 'next, can you...', 'while you're at it'), topic pivots, replicated work ('apply the same to Y'), session-handoff resumptions, post-compaction turns, or any 'this is bigger than I thought' moment. Reactive fallbacks: 2+ files already read this turn, 2+ independent files/features/deliverables in the request, or about to read a 3rd file. Skip ONLY for: conversational replies, status questions answerable from memory/git/a single tool call, single-line single-symbol edits, or one-file one-read lookups.
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
5. **Large-surface (1M context fit)** — does the chunk's *required read surface* exceed roughly 150K tokens? Monorepo-wide review, large PDF/transcript ingest, multi-hundred-file analysis, log forensics across days. If yes, this chunk routes to a **1M-context Opus 4.8 subprocess** (`claude -p ... --model claude-opus-4-8`, native 1M window) — not a regular Sonnet/Opus subagent. Subagent context is bounded; 1M is the right tool. See "1M Context Routing" below.
6. **Model fit** — *only ask this if 1–5 are all no.* Two directions. **Down:** does the task genuinely need Opus-level reasoning (multi-file design, architectural tradeoffs, ambiguous spec, nuanced review)? If not, delegate it to a single Sonnet or Codex sub-agent for efficiency. **Up:** is the task *harder than Opus 4.8* — a research-grade decomposition or the subtlest correctness problem where Opus has plateaued? If so, escalate that sub-problem to a Fable 5 delegate (a target, never the seat — see "Fable 5 routing"). Most work is neither: it sits in Opus's band and stays in-session.

**The decision rule:**

- **ANY of 1–4 yes** → start the delegate flow. `/delegate plan "<task>"` for non-obvious decompositions, `/delegate run "<task>"` once you have the manifest. For a single deep task, a 1-chunk delegate run to Sonnet or Codex still wins on fresh context — parallelism is an optimisation, fresh-context is the primary value.
- **Q5 yes (large-surface)** → route THAT chunk (or the whole task if it's a 1-chunk job) to a **1M-context Opus 4.8 subprocess**. Do NOT flip the orchestrator session to 1M — keep the seat lean. The chunk runs as a Bash subprocess: `claude -p "<self-contained prompt>" --model claude-opus-4-8 --permission-mode plan`. See "1M Context Routing" for the full pattern.
- **1–5 all no, but Opus reasoning NOT required** → still delegate, but as an *efficiency* 1-chunk run, not a parallelism run. Route to Sonnet sub-agent (mechanical edits, boilerplate, clear-pattern work, simple refactors, generation from a tight spec) or Codex (single-file adversarial review, narrow precision fix). The orchestrator (Opus) writes the brief, delegates, reviews the returned diff. Do NOT burn Opus on work that Sonnet or Codex would do better and cheaper.
- **1–5 all no AND Opus reasoning required** → proceed in-session. Log the call in one line so the user can override.
- **Per-chunk apex check (fan-out runs).** Q6 gates on "1–5 all no", so a run that already triggered on scope/parallelism skips the top-level model-fit question. Re-apply its *upward* direction during decomposition: if any individual chunk is harder than Opus 4.8 (a research-grade boundary, a proof-shaped correctness chunk), mark that chunk `fable-subagent`. The orchestrator seat stays Opus.

**What "Opus reasoning required" actually means.** Use Opus in-session for: multi-file design decisions, architectural tradeoffs, synthesising disparate context the sub-agent doesn't have, debugging where the failure mode is ambiguous, reviewing or reconciling work the sub-agents produced, talking to the user. Do NOT use Opus in-session for: mechanical edits following a clear pattern, boilerplate generation, writing a test from a clear spec, single-file refactors with obvious shape, formatting/lint fixes, dependency bumps. Those go to Sonnet.

**Always state the call out loud, one line:**

> `Delegation triage: in-session on Opus — multi-file architectural decision, reasoning needed here.`
> `Delegation triage: 1-chunk Sonnet run — mechanical refactor, no Opus reasoning required, efficiency play.`
> `Delegation triage: fan-out — 4 independent feature chunks, would burn ~50% main-session context.`
> `Delegation triage: 1-chunk Codex run — deep algorithm, want fresh-window + adversarial review.`
> `Delegation triage: 1-chunk 1M-Opus subprocess — read surface is the whole monorepo (~280K tokens), beyond subagent budget.`

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
| **Orchestrator** | Opus 4.8 (main session, adaptive `xhigh` thinking) | Stays | Decompose, review diffs, QA, reconcile dual-model reviews, talk to the user |
| **Apex reasoning** | **Fable 5 (`Agent(model="fable")`, or CLI subprocess for 1M)** | Subagent / subprocess (fresh) | The single hardest sub-problem that has outrun Opus 4.8: research-grade decomposition, subtlest algorithmic correctness, blocker-conflict tie-break. A *target*, never the seat — see "Fable 5 routing" below. |
| **QA reviewer A** | Opus 4.8 (fresh subagent) | Subagent | Cold semantic review of an applied major run (Step 10.5) |
| **QA reviewer B** | Codex GPT-5.5 `--effort high` | Background | Adversarial review of an applied major run, parallel to reviewer A (Step 10.5). Cross-*family* diversity — Fable is cross-*depth*, not diversity. |
| **Planning** | Opus 4.8 (Plan subagent) | Subagent | Architecture, multi-file refactor design. Escalate to a Fable 5 Plan delegate only for a genuinely research-grade decomposition. |
| **Build** | Sonnet 4.6 (Agent, adaptive thinking) | Fresh per chunk | Parallel independent implementation chunks (multi-file, project-conventions-aware) |
| **Precision** | Codex GPT-5.5 | Background | Adversarial review, deep algorithms, second opinions |
| **Large-context** | **Opus 4.8 1M (native 1M window; via CLI subprocess to keep it off the orchestrator seat)** | Subprocess (fresh session) | Single chunks whose *read surface* exceeds ~150K tokens: monorepo-wide review, big PDF/transcript ingest, multi-hundred-file analysis, log forensics. Never the orchestrator seat. |
| **Cheap parallel** | Haiku 4.5 (Agent, `model="haiku"`) | Fresh per task | High-volume narrow tasks at scale: classify/tag, format-convert, bulk mechanical text edits, smoke checks, per-row enrichment |
| **Lookup** | Haiku 4.5 (Explore subagent) | Subagent | File location, grep-for-symbol, quick searches |
| **Integration** | Opus 4.8 (main session, in-line) | Stays | runner: `main` chunks — cross-cutting edits, package.json, config wiring, glue between sibling chunks |

**Pricing context (2026-07):** Fable 5 **$10/$50 per MTok** (2× Opus — the apex tier) • Opus 4.8 $5/$25 • Sonnet 4.6 $3/$15 • Haiku 4.5 $1/$5 • Codex GPT-5.5 separate billing. **Opus 4.8 ships a native 1M context window at standard $5/$25 — no long-context premium.** (This corrects the old "$10/$50 above 200K input, 2× tier" note: that premium was the Opus 4.7-era 1M beta and is gone. The *cost* reason to keep the orchestrator off a 1M context has evaporated; the *reasoning-quality + cache* reason has not — a bloated context still degrades the seat regardless of price.) Haiku is ~3× cheaper than Sonnet on input — for narrow parallel tasks the savings compound across chunks; route mechanically suitable work to Haiku without ceremony. Fable at 2× Opus is the inverse discipline: reach for it only when Opus 4.8 has genuinely plateaued on a narrow, high-leverage sub-problem — never as a "just in case" upgrade.

Use `runner: main` sparingly — typically the final chunk in a chain when integration genuinely requires orchestrator context (sibling-chunk awareness, cross-file decisions). Most chunks should be `sonnet-subagent` for code work or `haiku-subagent` for narrow text/data work.

## Fable 5 routing — apex reasoning target (never the default seat)

**The topology question, settled.** Fable 5 is the most intelligent model — a tier above Opus, at 2× the price ($10/$50 vs Opus 4.8's $5/$25). The instinct is to put the smartest model in charge: Fable orchestrates, Opus executes. **That instinct is wrong for this skill.** The orchestrator seat stays **Opus 4.8**; Fable 5 is a *target* you escalate to for the single hardest sub-problem — the exact same shape as the 1M-Opus rule.

**Why Opus 4.8 holds the seat, not Fable 5:**

| Argument | Detail |
|----------|--------|
| **The seat pays its premium on *every* turn** | The orchestrator is the longest-lived component — in context for the whole session, including the ~80% of turns that are pure coordination (init, mark running, collect, apply, present, re-read `state.tsv`). Seat Fable and you pay 2× on all of them. Seat Opus and the premium is only spent where reasoning actually happens; the rare hard call escalates to a Fable *delegate*. |
| **Orchestration is agentic, and Opus 4.8 is the agentic flagship** | Opus 4.8 is explicitly state-of-the-art at *long-horizon agentic execution* — which is exactly the orchestrator's job (decompose, hold the narrative, sequence waves, reconcile). Fable's documented edge is *raw reasoning depth*, a delegate-shaped need (one brutal sub-problem), not a coordination-shaped one. Nothing says Fable orchestrates better — only that it reasons deeper. |
| **Intelligence belongs where verification *can't* catch the error — and that's specific gates, not the whole seat** | The strongest pro-Fable case: orchestrator mistakes (a bad decomposition, a wrong reconciliation verdict) aren't caught by a `verification` command, so put the best brain there. True — but those are a handful of *gates*, not the whole session. Escalate those gates to Fable; don't seat it for the mechanical 80%. |
| **Latency is hidden in delegates, exposed in the seat** | A tier-above-Opus flagship is near-certainly slower per token. The seat is the interactive surface that talks to the user — the worst place to absorb latency. Delegates run in the background behind parallelism, where latency is free. |

**Where Fable 5 *does* earn its 2×** — escalate to a Fable delegate when Opus 4.8 has genuinely plateaued on a *narrow, high-leverage* sub-problem:

| Use Fable 5 for | Spawn |
|-----------------|-------|
| **Research-grade decomposition** — a genuinely novel task where getting the chunk boundaries *right* is the hard part, and a wrong cut wastes the whole fan-out — **and ultrathink on the Opus seat has already plateaued** (try the free in-seat ultrathink first; see Step 2's planning ladder) | One-shot Fable Plan delegate → returns the manifest → orchestrate the build on Opus 4.8 |
| **The subtlest algorithmic correctness** — concurrency invariants, numerical edge cases, a proof-shaped argument where Opus *and* Codex both hesitate | 1-chunk `fable-subagent` (CLI subprocess if it also needs a >150K read surface) |
| **Blocker-conflict reconciliation** — Step 10.5 reviewers (Opus + Codex) disagree on a *blocker* and the orchestrator can't confidently adjudicate | Escalate that one finding's reconciliation to Fable 5; take its verdict as the tie-break |

**The one carve-out where Fable *may* take the seat.** The "seat pays the premium on every coordination turn" argument assumes a session with lots of cheap coordination subsidised by a few hard calls. When that assumption fails — a **short, uniformly-hard** task where the decomposition itself is research-grade and there's almost no mechanical overhead to dilute — seating Fable is defensible. State the trade-off out loud and get the user's sign-off, exactly like the 1M flip:

> `Fable-seat call: single research-grade problem, ~no coordination overhead, the decomposition IS the hard part. Recommend seating Fable 5 for this session — 2× cost, but every turn is Fable-hard. The user's call.`

Default is Opus-seat / Fable-target. The carve-out needs an explicit yes — never a unilateral flip.

**Mechanical notes:**

- Fable spawns natively via the Agent tool — `Agent(subagent_type="general-purpose", model="fable", run_in_background=True, ...)`. Unlike 1M-Opus, **no CLI subprocess is required** — the Agent `model` param now accepts `fable`. Use a CLI subprocess only if the Fable chunk also needs a >150K read surface or isolated MCP/hooks.
- Runner enum: `fable-subagent` is wired into `delegate.sh validate` and `references/manifest-schema.md`. Step 6 fan-out uses the Sonnet spawn block with `model="fable"`.
- Fable quirk (raw CLI/API only): an explicit `thinking: {type:"disabled"}` returns 400 on Fable 5 — omit the `thinking` param instead (Opus 4.8 accepts `disabled`; Fable does not). The Agent tool handles this for you; it only bites a hand-rolled `claude -p`/SDK call.
- Effort: default `high`, not `xhigh`. Fable's intelligence ceiling is higher, so start at `high` and only climb on a concrete signal — Fable self-reports low confidence, its verdict conflicts with both Step 10.5 reviewers, or its output fails verification. Reflexive `xhigh`/`max` on a 2× model is easy money to waste.
- Cost discipline: Fable is 2× Opus 4.8 and 10× Haiku. Reach for it only when Opus 4.8 has demonstrably plateaued on a narrow, high-leverage problem — the same discipline the 1M tier gets. It is not a "just in case" upgrade, and it is **not** model-diversity for QA (it's still a Claude model — Codex remains the cross-family reviewer; Fable is depth, not diversity).

## Effort Levels per Runner

| Runner | Effort control | Default | Override |
|--------|---------------|---------|----------|
| **Orchestrator (Opus 4.8)** | Adaptive thinking (`xhigh` default in Claude Code); **explicit ultrathink at the planning gate** | Full + adaptive | Stay on Opus; never switch to Sonnet manually. Adaptive thinking deepens reasoning on hard subproblems — but at the decomposition gate (Step 2), *force* the ceiling with ultrathink rather than trusting adaptivity to find it; a bad cut is the one orchestrator error no verification catches |
| **Apex (Fable 5)** | `effort` (sweep `medium`/`high`/`xhigh`) + adaptive thinking | `high` | Start at `high`, not `xhigh` — Fable's intelligence ceiling is higher, so climb only if the sub-problem demands it. Never send `thinking:{type:"disabled"}` (400 on Fable — omit the param) |
| **Sonnet subagents (4.6)** | Model tier + adaptive thinking | Adaptive (default) | Set `thinking="extended"` for genuinely deliberative tasks (math, multi-step symbolic reasoning); default OFF for code chunks — extended thinking can hurt by ~36% on intuitive tasks |
| **Codex** | `CODEX_EFFORT` env var → `model_reasoning_effort` | `medium` | `CODEX_EFFORT=high` for deep algorithmic work or adversarial review |
| **Haiku 4.5 (Cheap parallel + Explore)** | Model tier + optional extended thinking | OFF | Default OFF for pure lookups/classification/bulk edits. Enable extended thinking only for unambiguous deliberative subtasks — rare for Haiku-suitable work |

**Session advice:** Start and stay on Opus 4.8. The skill routes sub-runners automatically. Switching to Sonnet manually to "save tokens" just degrades the orchestrator — the planning and QA gates are where Opus earns its keep. Adaptive thinking on Opus is the new default — don't fight it; it spends thought where the task warrants it.

**Thinking-mode rule of thumb:** If the task is "follow the obvious pattern", leave thinking OFF on Sonnet/Haiku. If the task is "reason about which of three valid approaches is right here", extended thinking earns its cost. The 36% intuitive-task regression is real — don't reflexively turn it on.

## Session Handoff — when to suggest a fresh start

The orchestrator must proactively suggest a handoff when it detects diminishing returns from held context. Don't wait for the user to notice. The trigger is any one of:

| Signal | Threshold | Action |
|--------|-----------|--------|
| Context window | **>75%** full | Suggest handoff immediately — before the next fan-out or QA gate |
| Mid-run stall | Collect phase done, QA not started, session feels stale | Suggest handoff before QA |
| Repeated clarifications | Same question asked / context re-explained 2+ times | Stop and suggest handoff |
| User says "handoff" | Explicit | Always produce the prompt block |

**How to surface it — always inline, always copyable:**

Say clearly: *"Here's the transfer prompt — paste this into a new session:"*

Then produce a fenced code block containing the self-contained prompt. The user copies it and pastes it as the first message in a new session. No files to read, no scripts to run, no setup.

**Transfer prompt format:**

~~~
```
Pick up where the last session left off. Here's the full context:

## What was done
<bullet list — shipped features, confirmed facts, dead ends proven>

## Current state
<what exists now, what version shipped, what's live>

## Next action
<single concrete first step — tool call, command, or decision>

## Open unknowns
<what hasn't been verified yet, what could break>

## Key files
<file path — what's relevant about it>
<file path — what's relevant about it>

## Dead ends — do not retry
<approach — why it fails>
```
~~~

Keep it tight enough to paste without hesitation. If there's a delegate run in progress, add:

```
## Delegate run
run_id: <run-id>
project: <path>
pending chunks: <ids>
next step: /delegate resume <run-id>
```

**The rule:** every handoff lives in the chat as a copyable block. No file, no script, no "go read HANDOFF.md". The prompt IS the handoff.

## Context Budget Rules

- **<30% context**: do the work in-session *only if it needs Opus reasoning*. Mechanical or pattern-following work goes to a 1-chunk Sonnet sub-agent regardless of context budget — Opus shouldn't be spent on it.
- **30–60%**: hand exploration to Explore subagents. Keep implementation local only when it requires orchestrator-level synthesis.
- **>60%** OR **2+ independent units**: decompose and fan out. The sweet spot.
- **Cache discipline**: prompt cache TTL is 5 min default; paid 1-hour cache available at extra cost. Stay <270s between turns or commit to ≥1200s. Sub-sessions start with fresh cache. **Subagent progress summaries now hit the prompt cache (May 2026)** — repeated fan-outs with a shared system prompt and shared context blocks cache cleanly across siblings, cutting `cache_creation` cost ~3×. When fanning out many chunks, structure the chunk prompts with a stable prefix (shared briefing, project conventions) so the cache hit rate compounds.
- **Single-chunk delegation is valid.** A 1-chunk run to Sonnet or Codex is worth it for any of three reasons: (a) **fresh context window** — a deep task that would burn 40%+ of main-session context; (b) **model fit / efficiency** — mechanical or pattern-following work that doesn't need Opus, route to Sonnet; (c) **independent perspective** — adversarial review or precision fix, route to Codex with `--effort high`. Parallelism is one optimisation, but not the only one. Fresh-context, efficiency, and perspective are all valid reasons to delegate a single chunk.

## When to Use Codex vs Sonnet Subagent

| Use Codex | Use Sonnet subagent |
|-----------|---------------------|
| One focused file/function | Multi-file chunk |
| Want a different model's opinion | Follows project conventions |
| Adversarial review | Parallelisable with siblings |
| Deep algorithmic work | Output is a clean diff |
| — | **Efficiency 1-chunk run** — mechanical code work that doesn't need Opus |

**The efficiency 1-chunk Sonnet pattern.** When triage Q1–4 all land "no" but the task is mechanical / pattern-following / boilerplate — rename a symbol across files, generate a test from a clear spec, apply a diagnosed lint fix, bump a dependency, mirror an existing endpoint, update copy across known files — the default move is a 1-chunk Sonnet sub-agent run, not in-session Opus. In-session Opus stays the right call for: multi-file design, architectural tradeoffs, ambiguous-spec debugging, reconciling reviewer findings, talking to the user.

## When to Use Haiku vs Sonnet (the cheap-parallel tier)

Haiku 4.5 is ~3× cheaper than Sonnet on input and faster end-to-end. For tasks where the verification surface is trivial — "does the output match the spec, yes/no" — Haiku is the right routing call, both as Explore subagents (lookups) and as fresh Agent subagents for narrow-scope build chunks. Route mechanically suitable work to Haiku without ceremony; the savings compound across high-volume fan-outs.

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

**If Fable 5 is unavailable** (access lapsed, model retired, 400/404 on spawn): do not stall or downgrade silently. The replacement for an apex delegate is **ultrathink on Opus 4.8 + an independent Codex `--effort high` pass on the same sub-problem**, reconciled by the orchestrator — depth via forced thinking budget, blind-spot coverage via cross-family diversity. Note in the run log that the apex tier was substituted.

## 1M Context Routing — a fresh 1M session as a delegation target (never the orchestrator seat)

**The rule, stated bluntly.** The orchestrator session stays **lean** — full stop. A 1M read surface is a *target*, not a *seat*. Opus 4.8 now ships a native 1M window at standard pricing, so the old *cost* argument ("the premium above 200K burns cash") is gone — but the rule stands on its other leg: the orchestrator's job (decompose, review diffs, reconcile reviews, talk to the user) is small-context work, and pouring 1M of source into the seat degrades reasoning quality and trashes the prompt cache regardless of price. Keep huge read surfaces in a **fresh** delegate session and the orchestrator stays sharp. If the orchestrator session itself is hitting 75%+ context, the right move is **handoff** (cheap, clean, deterministic), not bloating the seat.

**When 1M Opus is the right routing call:**

| Trigger | Why 1M, not Sonnet/Haiku subagent or Agent Teams |
|---------|--------------------------------------------------|
| Chunk needs to read >150K tokens of source material in one pass (monorepo-wide refactor analysis, big PDF/transcript ingest, multi-hundred-file audit, days of logs) | Subagent context is bounded by the orchestrator's allowance; Sonnet 4.6 caps below where this needs to be. 1M Opus gives the chunk a fresh full 1M window. |
| Adversarial review where reviewer needs spec + full codebase + test suite + prior reviews in one context | Same as above — review quality collapses when the reviewer can't hold the whole surface. |
| Cross-cutting "find every place X is true" sweep over a large corpus | Greps miss semantic patterns; full-context Opus reads catch them. |

**When 1M Opus is NOT the right call (use the cheaper path):**

- Chunk fits comfortably in <150K tokens → regular Sonnet subagent or Codex.
- Task decomposes into independent sub-units → fan out instead. Decomposition beats brute-force-context every time.
- You only need keyword/symbol lookup → Haiku Explore subagent + grep.
- The orchestrator session is full → handoff, not 1M flip.

**Mechanical invocation.** The Agent tool's `model` parameter accepts `opus|sonnet|haiku|fable` — so a Fable *delegate* spawns natively, but a **1M context window** does not: subagent context is bounded by the orchestrator's allowance, well below 1M, whatever the model. For a genuine >150K read surface, route via **Bash subprocess** to the Claude Code CLI — Opus 4.8's native 1M window means a plain `--model claude-opus-4-8` subprocess holds the full 1M, no special variant string:

```bash
claude -p "$(cat <<'EOF'
You are a 1M-context delegated chunk. Read surface: ~280K tokens across the listed files.

PROJECT (read-only): /path/to/your/project
WORKSPACE (write here, relative paths): /tmp/delegate/<run-id>/chunk-2/workspace

Task: <intent>
Files to load: <explicit list, OR a glob>
Deliverables: <files to write>
Verification: <command to run on completion>

Report: final file list + verification result.
EOF
)" \
  --model 'claude-opus-4-8' \
  --permission-mode plan \
  --add-dir /path/to/your/project
```

**Notes on the subprocess shape:**

- `--permission-mode plan` keeps the chunk from prompting for tool approvals; pre-approve via project settings if it needs to write.
- `--add-dir` grants the chunk read access to the project. Workspace stays in `$RUN_DIR/<chunk-id>/workspace` per the standard contract.
- No `task-notification` token telemetry from CLI subprocess — capture by scraping the final stdout line or parsing `--output-format json` if you need exact token counts in `state.tsv`.
- Spawn latency is ~2-4s (process boot + cache warm). Acceptable for a chunk that will run for minutes; not acceptable for fan-out of 10 narrow tasks.
- Set the runner in the manifest as `opus-1m-cli` (now wired into `delegate.sh validate` + `references/manifest-schema.md`). The spawn pattern is the subprocess block shown above.

**Session escalation (last-resort, rare).** If the user's *own* session has accumulated irreducible context that handoff would lose (mid-debugging an ambiguous failure, holding cross-file mental state that can't be summarised cleanly), the alternative to handoff is launching a fresh 1M Opus 4.8 CLI session and pasting the held context in. State the trade-off out loud: "The orchestrator's at 80%. Handoff loses momentum but keeps the seat lean. A 1M flip preserves momentum, but every subsequent turn re-reads the bloated context — slower, costlier per turn, and the reasoning dulls. Recommendation: handoff unless the held state is genuinely unsummarisable." Default to handoff; the 1M flip needs an explicit yes.

## Usage

```
/delegate plan "<task>"     # Decompose only — produce manifest, no execution
/delegate run "<task>"      # Decompose + fan out + collect + audit + apply + QA + present
/delegate resume [run-id]   # Re-fan only chunks still pending or failed
/delegate qa <run-id>       # Re-run QA gate on an existing run
/delegate watch [run-id]    # Compact one-shot snapshot of state.tsv (cheap in-chat progress — use instead of re-cat'ing state)
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
  <chunk-id>/output.log     ← captured chunk stdout (telemetry only)
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

**Token capture:** Sonnet chunks report exact tokens via the `task-notification` `<usage><total_tokens>` field — the orchestrator must parse and call `delegate.sh set ... tokens=<N>` (the engine doesn't auto-capture for sonnet). Codex chunks are auto-captured by `cmd_codex` from JSONL `turn.completed` events.

## Orchestration Flow (run mode)

### Step 1 — Init the run

```bash
OUT=$({base}/scripts/delegate.sh init "<task>" --project <project-path>)
RUN_ID=$(echo "$OUT" | awk '/^RUN_ID:/ {print $2}')
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

**Sonnet subagent chunks** — Agent tool, background, no worktree isolation (we don't need git):
```
Agent(
  subagent_type="general-purpose",
  model="sonnet",
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

Mechanical QA (Step 10) verifies that tests pass. It does not verify that the code is **good** — correct, idiomatic, safe, free of subtle bugs, complete. For major runs, a second pass is mandatory: **Opus 4.8 reviews in the main session, Codex GPT-5.5 reviews in a fresh background context, both in parallel, then the orchestrator reconciles and fixes.**

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
- **Codex review** — `{base}/codex/scripts/codex.sh run` with `--effort high --model gpt-5.5`, background. Hand it the same brief. Codex's review writes `review-codex.md` to a temp workspace.

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

`/delegate abort <run-id> [reason]` — Mark all running chunks `failed` with `result=aborted:<reason>`, write an `ABORTED` marker, prevent the apply step from running. The orchestrator should call this when it detects a runaway chunk (no progress in output.log for 5+ min, contradictory state, infinite loop in stdout). Re-fan via `/delegate resume` after the root cause is fixed.

## Self-Healing

If scripts break, edit them directly — you have authorization to modify anything under `{base}/`:
- `scripts/delegate.sh` — the entire engine (init, validate, audit, apply, qa, etc.)
- `scripts/detect-verification.sh` — auto-detect test commands
- `references/routing.md` — full decision tree
- `references/manifest-schema.md` — JSON schema + examples
- `references/orchestration-patterns.md` — sequencing patterns
- `references/prompt-templates.md` — chunk prompt templates

Set `DELEGATE_DEBUG=1` to enable an ERR trap that prints the failing line + command + exit code.

## Surface notes — Desktop, CLI, and Agent Teams

**Desktop ↔ CLI parity (confirmed 2026).** Claude Code Desktop (Mac/Windows app) and the terminal CLI both support: the Agent / `subagent_type` tool, `~/.claude/skills/`, hooks, MCP servers, CLAUDE.md inheritance. This skill works identically on both surfaces — same triage, same fan-out, same QA gates. Documented Desktop gaps that affect this skill: no `--model` / `--permission-mode` flags exposed at launch, no autonomous `/loop` runs. None of those block the skill's core flow.

**Agent Teams (experimental, shipped Feb 2026).** For multi-session orchestration beyond same-process subagents, Anthropic ships **Agent Teams**: a lead agent coordinating independent teammate *instances* via shared task lists and mailbox-style inter-agent messaging. Enable with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.

**Default behaviour: stay on subagents.** This skill's `sonnet-subagent` / `haiku-subagent` runners cover 95% of fan-out needs — cheaper, ~5-10× faster to spawn, well-understood failure modes, no shared-mailbox footgun. Agent Teams is a *real* escape hatch, not a parallel-by-default mechanism. The bar for reaching for it is genuinely high.

**Reach for Agent Teams ONLY when one of these holds (and 1M Opus subprocess doesn't already solve it):**

| Trigger | Why subagents fail here | First-choice answer |
|---------|------------------------|---------------------|
| A single chunk needs >150K context (loading large codebases, big PDFs, multi-file deep analysis) | Subagent context is bounded | **1M Opus CLI subprocess** (see "1M Context Routing"). Agent Teams is the fallback if 1M Opus isn't enough or you need teammate-shaped coordination. |
| A chunk needs project-scoped MCP servers the orchestrator's session doesn't have | Subagents inherit orchestrator MCP config | Agent Teams (or CLI subprocess — both isolate MCP config) |
| A chunk needs different hooks (different security policy, different auto-format, different permission scope) | Subagents share hooks with the orchestrator | Agent Teams or CLI subprocess |
| The chunk run is long enough that it could outlast the orchestrator's session limit | Subagents die when the orchestrator session dies | Agent Teams (independent lifetime) |
| The user explicitly says "use Agent Teams for this" | Direct instruction overrides default | Agent Teams |

**State the call out loud when reaching for it.** Like all delegation calls, name the trigger:

> `Agent Teams call: chunk-2 needs to ingest a 400k-token monorepo dump — beyond subagent context. Spinning up a teammate instance.`

**Mailbox messaging is a footgun for this skill's contract.** Agent Teams supports inter-team mailbox messaging — chunks can talk to each other. This skill's manifest contract is explicit: chunks are *independent* (no shared files, no cross-dependencies). If chunks need to coordinate, the decomposition is wrong — re-author the manifest, don't paper over it with mailbox traffic. Use the mailbox only for chunk-to-orchestrator status, never chunk-to-chunk.

**No runner integration yet.** Agent Teams is documented but NOT wired into `delegate.sh` as a `runner:` enum value. When a real use case lands (one of the triggers above), the integration work is: (a) add `agent-team` to the runner enum in `references/manifest-schema.md`, (b) add a spawn block to Step 6 alongside the Sonnet/Haiku/Codex examples, (c) decide how `validate`/`audit`/`apply` handle teammate-produced workspaces. Don't speculate-build it before there's a real chunk that needs it — speculative integration rots until first use exposes the wrong assumptions.

**Summoning a terminal CLI subprocess.** Possible via Bash (`claude -p "<prompt>" --model <id>`). The Agent tool's `model` param now exposes `opus|sonnet|haiku|fable` — so Fable delegates spawn natively — but it still can't give a subagent a fresh **1M context window** (subagent context is bounded below 1M). A genuine >150K read surface is the case for the CLI subprocess. See "1M Context Routing" above for the full pattern. Trade-off:

| Subprocess CLI gains | Subprocess CLI costs |
|----------------------|---------------------|
| Full 1M-token context window per chunk (with `--model claude-opus-4-8`, native 1M) | Process spawn latency (~2-4s per launch) |
| Independent hooks / MCP / settings | No streaming back to orchestrator (must scrape stdout) |
| True session isolation | No `task-notification` token telemetry; harder to capture |
| Survives orchestrator session limits | Permission prompts unless `--permission-mode plan` or pre-approved |
| — | 1M is native to Opus 4.8 at standard pricing — no premium; the cost to avoid in the seat is per-turn token bloat + cache decay, not $/MTok |

Reach for CLI subprocess only when: (a) the chunk genuinely needs the 1M context window the subagent can't give it (route to 1M Opus per the dedicated section), (b) the chunk needs project-scoped MCP/hooks the orchestrator's session doesn't have, or (c) Agent Teams isn't enabled and you need true session isolation. For everything else, in-session subagents (Sonnet/Haiku) are the right tool. Don't subprocess-spawn out of habit — it's an escape hatch, not a default.

**One more recent feature worth knowing — Outcomes (research preview).** Claude Managed Agents now supports "Outcomes" — specify a desired end state, the agent loops until achieved. Different shape from this skill's decompose-fan-out-collect flow (which is bounded and explicit). Don't fold Outcomes into the core orchestration loop — it changes the determinism contract. Worth knowing for tasks where the spec is genuinely outcome-shaped ("get all tests passing", "reduce bundle size below 200kb") rather than decomposable.

## Anti-Patterns

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
- Do NOT reach for Fable as a "just in case" upgrade — at 2× cost its edge only shows where Opus 4.8 has visibly plateaued. Otherwise it's wasted spend.
- Do NOT treat Fable as "model diversity" in QA — it's still a Claude model (depth, not diversity). Codex remains the cross-family reviewer; Fable breaks a tie.
- Do NOT default Fable to `xhigh`/`max` — start at `high`, climb only on a concrete signal. Reflexive `max` on a 2× model is the priciest way to waste tokens here.

## Sync homes

Canonical: ~/.claude/skills/intelligent-delegation (private, live). Public sanitized twin: ~/code/claude-skills/intelligent-delegation → github.com/justinwilliames/claude-skills. Sanitization is a sync step — never push private paths/names.

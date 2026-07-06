# GOLD EXEMPLAR — PRD Critique (annotated, Fable-authored 2026-07-03)

> **How to use this file.** A reference critique-mode audit at the target quality bar, with
> `⟨GOLD⟩` notes on the judgment calls. Match the severity calibration, the authority-citation
> discipline, and the Before/After concreteness — not the specific findings. The input was a
> ~700-word PRD titled "Smart Scheduling" for a field-service SaaS: auto-assigns jobs to
> technicians; success framed as "increase engagement and efficiency"; solution fully
> specified; no baseline metrics, no non-goals, no customer evidence; claims "35% efficiency
> improvement" from an internal guess.

---

## The audit as delivered

## Audit summary

One-pager shape, ~700 words. Headline verdict: **needs rework** — the solution is specified
in detail while the problem it solves is asserted, not evidenced, and success as written
cannot be falsified. The bones are good: scope is a genuine one-pager, and the rollout
section is more thoughtful than most drafts at this stage.

## Blockers (3)

1. **Unfalsifiable success metric** — *Success* section. **Cited authority:** Lenny
   Rachitsky — a success metric needs metric + baseline + target + timeframe, or reviewers
   approve vibes. **Fix:** replace the engagement phrasing with the operational metric this
   feature actually moves. **Before:** "Success looks like increased engagement and
   efficiency for dispatch teams." **After:** "Success: median time-from-job-created-to-
   assigned drops from 26 min (May baseline, dispatch dashboard) to under 10 min within 60
   days of GA, with no increase in reassignment rate (currently 11%)."

2. **No problem evidence** — *Problem* section. **Cited authority:** Marty Cagan — discovery
   evidence precedes solution commitment; a PRD that opens with the solution has skipped the
   riskiest assumptions. **Fix:** add the two strongest pieces of evidence you have (support
   ticket volume tagged 'scheduling', the churn-interview quote count) and state what you do
   NOT yet know. **Before:** "Dispatchers waste significant time manually assigning jobs."
   **After:** "Scheduling is our #2 support-ticket theme (214 tickets, Q1) and appeared
   unprompted in 9 of 21 churn interviews ('we went back to a whiteboard'). We have not yet
   validated whether auto-assignment or better visibility is the fix — this PRD bets on
   auto-assignment; the pilot exists to test that bet."

3. **The 35% number is fake precision** — *Impact* section. **Cited authority:** Amazon
   Working Backwards — numbers in a PR/FAQ must survive the "how do you know?" question.
   **Fix:** either source it or degrade it honestly. **Before:** "We estimate a 35%
   efficiency improvement." **After:** "Comparable auto-assignment rollouts report 20–40%
   assignment-time reductions (ServiceTitan case study, 2024); our pilot will establish our
   own number before GA claims."

## Majors (2)

1. **No non-goals** — the doc never says what Smart Scheduling will NOT do (multi-day route
   optimisation, capacity planning, technician skill inference). **Cited authority:** Reforge
   — scope defence lives in the non-goals list; without it, every reviewer adds their
   favourite adjacency. **Fix:** add a 3-item Non-goals list; the three above are the ones
   reviewers will ask about.
2. **Assumption inventory missing** — auto-assignment assumes clean technician skill/zone
   data, which the *Rollout* section quietly contradicts ("data cleanup in phase 2").
   **Cited authority:** John Cutler — surface the assumption inventory before the build
   plan; a phase-2 dependency that phase-1 relies on is a sequencing bug, not a detail.
   **Fix:** state the dependency and flip cleanup into phase 1, or scope phase 1 to zones
   with known-clean data.

## Minors (3)

- "Leverage AI to optimise" (×2) — name the mechanism (rules? ranking model?) or cut the word "AI".
- The persona is called "dispatcher", "coordinator", and "ops manager" in different sections — pick one.
- Rollout dates are relative ("2 weeks after launch") — anchor to the metric gate instead ("after pilot hits <10 min median").

## Nits (0)

—

## Recommended next move

**Sharpen** — this is a rework of three sections, not a rewrite. Priority: (1) success
metric with baseline, (2) problem evidence + the explicit bet, (3) non-goals. With those
landed, the existing rollout section becomes the strongest part of the doc.

*Want me to apply the blockers and majors and produce a v0.2?*

---

## ⟨GOLD⟩ The judgment behind the audit

**⟨GOLD⟩ 1 — Severity calibration is the whole game.** Blocker = the doc cannot be
evaluated or will mislead a decision (unfalsifiable success, unevidenced problem, invented
number). Major = the doc will cause predictable rework (missing non-goals, contradicted
assumption). Minor = reader friction. The temptation is blocker-inflation to look rigorous —
resist it; a 7-blocker audit on a decent draft teaches the author to ignore audits.

**⟨GOLD⟩ 2 — Every blocker carries a ready-to-paste After.** A finding without a concrete
rewrite is half a finding. Note the Afters invent *placeholder specifics* (26 min, 214
tickets) drawn from the doc's own context — flagged implicitly as the author's to correct,
but showing the SHAPE the fix must take. Never deliver "add a baseline" as the fix; show a
baseline sentence.

**⟨GOLD⟩ 3 — Cite the authority for the principle, not as decoration.** Each citation does
work: Lenny for metric anatomy, Cagan for discovery-before-solution, Working Backwards for
number honesty, Reforge for scope defence, Cutler for assumption sequencing. One authority
per finding — stacking three names on one finding is rigor theatre.

**⟨GOLD⟩ 4 — Find the strength and say it once.** "The rollout section is more thoughtful
than most drafts" is in the summary, and the next-move section makes it load-bearing. One
earned compliment, placed where it guides the rework. Zero compliments reads as hostility;
sprinkled praise reads as softening. Both erode the audit's authority.

**⟨GOLD⟩ 5 — The Cutler finding shows cross-section reading.** The best finding in the
audit came from noticing the *Rollout* section contradicting the *Solution* section's data
assumption. Section-by-section auditing misses these; the pass that matters reads the doc as
one argument and hunts for places it disagrees with itself.

**⟨GOLD⟩ 6 — End with a decision, not a summary.** "Sharpen, and here are the three fixes
in priority order" gives the author a Monday-morning plan. The offer to apply is verbatim
from Step C5 and never auto-executes.

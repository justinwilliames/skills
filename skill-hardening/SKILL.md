---
name: skill-hardening
description: >
  Meta-skill for auditing and upgrading agent skills (SKILL.md files) to frontier quality.
  Load when asked to review, enhance, harden, sync, or spring-clean a skills library, or when
  writing a new skill that should hold up under real use. Provides the 10-point rubric, the
  audit procedure, and the sync-home discipline that keeps multi-home skills from forking.
  Do NOT use for one-off prompt tweaks — it's for skills meant to persist and be maintained.
---

# Skill Hardening

A skill is a program whose interpreter is a model. Like any program it rots: paths die, model
names age out, prices change, better patterns emerge, and copies drift apart across their
homes. This skill is the maintenance protocol — a rubric to score against, a procedure to
apply, and a sync discipline to keep every copy honest.

## The rubric — score each skill 0–2 per dimension

| # | Dimension | 2 looks like | 0 looks like |
|---|---|---|---|
| R1 | **Trigger clarity** | Description states when to fire AND when not to | "Use for X-related tasks" |
| R2 | **Decision-first** | The protocol/decision rule opens the file | Two pages of philosophy before the first instruction |
| R3 | **Named failure modes** | Anti-patterns enumerated with detection signals | "Be careful" |
| R4 | **Verification gates** | Every output has a defined "how we know it's right" observation | Outputs shipped on vibes |
| R5 | **Escalation ladder** | What to do when the default path plateaus (retry, tool, model, human) | Silence on failure handling |
| R6 | **Freshness** | Model names, prices, paths, dates all current | Dead paths, retired personas, last-gen models |
| R7 | **Output contract** | Deliverable shape exactly specified | "Produce a summary" |
| R8 | **Autonomy calibration** | Explicit act-vs-ask boundaries; hard gates on irreversible/external actions | Assumes approval, or asks for everything |
| R9 | **Sync homes** | The skill names its canonical copy and distribution copies | Copies exist, no map |
| R10 | **Economy** | Every section load-bearing | Restated points, decorative frameworks, filler |

18–20: frontier. 14–17: serviceable, harden opportunistically. <14: schedule a rewrite —
patching a weak skill dimension-by-dimension usually costs more than re-authoring it.

## The audit procedure

1. **Inventory** — list every skill and, for each, its homes (local install, git repo, MCP
   manifest, marketplace copy). A skill you can't map, you can't maintain.
2. **Score** — read fully, score R1–R10, cite file:line for every gap. No gap without a line
   number; unevidenced findings are opinions.
3. **Drift-check** — diff each pair of homes. Report *direction* (which side is newer), not
   just "differs". Check git state: dirty, ahead, behind.
4. **Punch list** — concrete edits ordered by value, exact old→new where possible. A finding
   without a proposed edit is half a finding.
5. **Apply** — batch mechanical fixes (paths, names, dates) separately from judgment fixes
   (structure, protocol changes). Mechanical fixes can be delegated; judgment fixes get review.
6. **Re-score** — the changed dimensions only. Confirm the edit actually moved the score.
7. **Sync** — propagate to every home per the discipline below, in the canonical direction.

## Sync-home discipline

- **One canonical home per skill**, declared in the skill itself. Every other copy is a
  distribution artifact, edited never — regenerated or copied from canonical.
- **Sanitize on the public boundary.** Private→public copies strip personal directives,
  internal names, and private-memory references, keeping the technical substance. The
  sanitization is a *step in the sync*, not a separate chore that can be forgotten.
- **Sync is part of "done".** An edit that lands in one home isn't finished; state which homes
  received it and which are pending (and why).

## Writing rules for new skills

- Frontmatter description carries the *routing decision*: trigger phrases, and the negative
  space ("do NOT use for…"). The loader reads only this — it must stand alone.
- Open with the decision rule or protocol. Context and rationale go after, or in references/.
- Prefer tables for failure modes and decision boundaries; prose for everything else.
- Bake in the verification gate for the skill's own outputs (R4) — a skill that can't say how
  to check its work will generate confident garbage at scale.
- Keep facts that age (models, prices, versions) in one place in the file, dated, so the next
  hardening pass finds them in one grep.

## Automated drift check — `scripts/skill-sync.sh`

Run `scripts/skill-sync.sh [skills-dir]` (default `~/.claude/skills`) to mechanise step 3 of
the audit: it reads each live SKILL.md's sync-home footer, resolves the declared twin, and
reports per skill — `OK`, `DRIFT`, `SANITIZED` (differs by design — review manually),
`MISSING` twin, `LOCAL-ONLY`, or `NO-FOOTER` (an R9 failure in itself) — plus the twin
repo's git dirt/ahead-behind state. Exit code is non-zero when drift or missing twins exist,
so it slots into a cron or session-start hook. Run it whenever a skill feels stale, and
before any release that ships skill copies.

## Named failure modes

| Failure mode | What it looks like | Antidote |
|---|---|---|
| **Skill bloat** | Every incident appends a paragraph; nothing is ever cut | R10 pass on every edit: what does this line displace? |
| **Baked-in staleness** | Facts-that-age scattered through prose | Centralise + date them |
| **Trigger overlap** | Two skills claim the same request; routing becomes luck | Audit descriptions as a *set*, not individually |
| **Fork drift** | Copies edited independently until neither is canonical | Declare canonical; edit only there |
| **Unsanitized leak** | Private names/directives shipped to a public copy | Sanitize as a sync step with its own check |
| **Rubric theater** | Scores assigned without reading the whole skill | No score without file:line evidence |
| **Patch-rot** | Ten patches on a <14 skill instead of a rewrite | Rewrite threshold is part of the rubric |

## Related

This rubric operationalises the whole suite: R2/R7/R10 are
[operator-standard](../operator-standard/SKILL.md) applied to documents, R4 is
[verification-gates](../verification-gates/SKILL.md), the audit's evidence rule is
[challenge-before-build](../challenge-before-build/SKILL.md), and R10 is
[context-discipline](../context-discipline/SKILL.md) for files.

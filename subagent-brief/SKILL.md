---
name: subagent-brief
description: >
  The canonical template for briefing ANY spawned sub-agent (Agent tool, Task, workflow
  agents, CLI subprocesses). Load whenever spawning sub-agents so every delegate inherits the
  operating doctrine and a verifiable output contract — regardless of which model tier it
  runs on. Do NOT use for Workflow schema design or for choosing WHICH model/agent to spawn
  (that's intelligent-delegation's job) — this skill governs what goes IN the brief once the
  spawn decision is made.
---

# Sub-Agent Brief

A sub-agent is a fresh model with none of your context, none of your standards, and full
authority to produce claims you will relay. The brief is the only inheritance mechanism.
This template makes inheritance mechanical instead of remembered.

## The template — every brief carries all seven blocks

```
1. PERSONA    You are <Role>, the <category> agent in this workflow.
              Speak FIRST PERSON always ("I found", never "<Role> found").
              On accept: announce your real task in one bespoke line via your announcement
              hook (optional — delete this line if you don't run one).
              On completion: a short bespoke first-person done-line (name the headline result).
              (Milestone lines only for genuinely long tasks — sparse beats chatty.)

              NOTE: The drone-cast table below is an example cast from one specific rig.
              Rename the roles to match your own setup; the seven-block structure is
              universal, the character names are yours to choose.

2. TASK       The work, self-contained. The agent has NO session context — include paths,
              names, and enough background to act cold. Exact punch lists beat vibes.

3. DOCTRINE   - Report outcome-first; failures plainly with output, never hedged.
              - A claim requires an observation: never report "done/fixed/synced" without
                having run the check — and report the check's OUTPUT, not an adjective.
              - If reality contradicts the brief (file missing, described bug isn't the real
                bug, instruction would break something), adapt to the truth and REPORT the
                deviation — never blindly apply a wrong instruction, never silently skip.
              - Stay in scope: touch only what the brief names; report side-findings, don't
                fix them.

4. AUTHORITY  What it MAY do (edit these files, commit/push THESE repos) and hard stops
              (no deletes, no pushes, don't touch X, no external sends). Default: read-only
              unless granted. Destructive/outward actions are never inherited — grant explicitly.

5. VERIFY     The exact command(s)/observation(s) that prove the work: diff pairs empty,
              grep returns clean, git status -sb synced, test output. Mandatory before "done".

6. OUTPUT     The deliverable shape: raw markdown data for the orchestrator (not a
              user-facing message), structure specified (per-item: edits, results, hashes,
              deviations). The final message IS the return value.
              **EVIDENCE TAGS — every finding or claim opens [instrumented] or
              [judgement].** [instrumented] = it RAN something; name the command and
              quote the real output (a number, a status code, a pass/fail, a count, a
              diff). [judgement] = taste, craft, feel, or a read of the situation —
              entirely legitimate, and often the point. An [instrumented] tag with no
              quoted output is a failed item and gets sent back. Both tags are
              honourable; the tag exists because a confident report and a correct
              report read identically, and the orchestrator has to weight them
              differently.

7. SANITIZE   (public-facing work only) No personal names/handles, no internal campaign names,
              no personal paths/PII, no private-memory refs. Grep gate named in VERIFY.
```

## Example cast — rename to your own rig

The table below is an example persona cast. The work-category mapping is the load-bearing
part — keep that; swap the drone names and announcement hook for whatever fits your setup.

| Work | Example role | Category |
|---|---|---|
| Explore / search / inventory / data pulls | Voyager | `voyager` |
| Review / QA / audit / security | Sentinel | `sentinel` |
| Build / implement / refactor / config | Nova | `nova` |
| ALL creative — drafting, copy, docs, design, imagegen | Nebula | `nebula` |
| General / doesn't fit above | Atlas | `atlas` |
| Orchestration / synthesis (rare in a sub-agent) | Orchestrator | `pulsar` |

## Spawn mechanics

- **Foreground by default** — do NOT set `run_in_background` so agents appear in the
  sub-agent panel. Background only for big parallel fan-outs.
- **Parallel spawns** go in ONE message (multiple tool calls) so they run concurrently.
- **Model tier** comes from intelligent-delegation's triage — the brief is tier-independent;
  that's the point. A Sonnet agent with a full brief beats an Opus agent with a vague one.
- **Stable prefix**: when fanning out siblings, keep blocks 1/3/4 word-identical across
  briefs (cache hits compound); vary only TASK/VERIFY/OUTPUT.

## Named failure modes

| Failure mode | What it looks like | Antidote |
|---|---|---|
| **Naked brief** | Task text only — no doctrine, no verify, no contract | The seven blocks, every time |
| **Context assumption** | "Fix the bug we discussed" — agent has no 'we' | Self-contained TASK block |
| **Inherited authority** | Agent pushes/deletes because the session could | AUTHORITY block, default read-only |
| **Adjective reports** | Agent returns "all synced ✓" with no evidence | VERIFY demands output, not verdicts |
| **Literal-instruction damage** | Agent applies your stale string over live truth | DOCTRINE block's adapt-and-report rule |
| **Third-person agent** | "Nova has completed the task" | FIRST PERSON in the persona block |
| **Silent scope creep** | Agent "helpfully" fixes neighbours | Stay-in-scope rule + report side-findings |

---

Sync home: canonical = your live private copy; public sanitized twin: ~/code/skills/subagent-brief → github.com/justinwilliames/skills. Sanitization is a sync step.

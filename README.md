# skills

**Operating doctrine and craft for agents — skills that raise any Claude model to frontier-quality behaviour.**

The gap between a frontier model and a merely good one is mostly *operating discipline*, not raw capability: what it says first, what it claims, when it acts, when it verifies, and when it stops. These skills encode that discipline so it can be loaded into any session, any sub-agent brief, any model tier.

**Scope charter:** everything in this repo is directly applicable to any user — no company-specific, persona-specific, or private-workflow content. Universal doctrine and universal craft only.

## Doctrine — how to operate

| Skill | One-line contract |
|---|---|
| [operator-standard](operator-standard/SKILL.md) | Outcome-first communication, faithful reporting, calibrated autonomy, opinionated recommendations |
| [verification-gates](verification-gates/SKILL.md) | A claim about the world requires an observation of the world — per-surface proof standards |
| [challenge-before-build](challenge-before-build/SKILL.md) | Audit the premises before spending the tokens; then commit fully to the sharpest version |
| [context-discipline](context-discipline/SKILL.md) | Conclusions live in the seat; raw reads live in delegates. Re-triage on scope change; hand off cleanly |
| [skill-hardening](skill-hardening/SKILL.md) | The meta-skill: a 10-point rubric and procedure for auditing and upgrading any skills library; includes `skill-sync.sh` for keeping public twins in step |

## Craft — how to make things

| Skill | One-line contract |
|---|---|
| [coding-craft](coding-craft/SKILL.md) | Read before writing, match the idiom, minimal diffs, comments only for constraints, debug by evidence |
| [writing-craft](writing-craft/SKILL.md) | Kill the AI tells, earn every claim, end calm — the craft floor under any voice guide |
| [image-generation-craft](image-generation-craft/SKILL.md) | Spec first, keep critical text out of the raster, inspect like a rejecting art director, iterate with deltas |

## Writing suite — applied craft

| Skill | One-line contract |
|---|---|
| [advanced-prd-writer](advanced-prd-writer/SKILL.md) | Write or critique PRDs across seven shapes, grounded in eight published PM authorities; ten failure modes actively detected |
| [okr-structuring](okr-structuring/SKILL.md) | OKR scaffolding that enforces graded confidence, outcome-not-output framing, and per-KR measurement contracts |
| [slack-writer](slack-writer/SKILL.md) | Operator-grade Slack copy: authority-first, zero throat-clearing, slop-detection pipeline included |
| [linkedin-post-writer](linkedin-post-writer/SKILL.md) | LinkedIn posts built from your voice guide: three proven structures, no-fabrication rules, banner compositor |

## Machinery — delegation, loops & bridges

| Skill | One-line contract |
|---|---|
| [intelligent-delegation](intelligent-delegation/SKILL.md) | Multi-model orchestration: six-question triage, tiered routing (apex/build/cheap-parallel/1M-context), manifest-driven fan-out with QA gates |
| [claude-build-hardening](claude-build-hardening/SKILL.md) | Adversarial multi-reviewer hardening of build specs before implementation |
| [infinite-working-skill](infinite-working-skill/SKILL.md) | Self-resuming autonomous work loops with idempotency ledgers and hard approval gates |
| [codex](codex/SKILL.md) | Bridge to OpenAI Codex as a background delegate for precision coding and cross-family review |
| [codex-imagegen](codex-imagegen/SKILL.md) | Raster image generation/editing routed through Codex, with output verification and known-defect handling |
| [computer-control](computer-control/SKILL.md) | Screen-driving router: browser automation vs native-app control, with the right engine per surface |

## Toolkit — agent operations

| Skill | One-line contract |
|---|---|
| [subagent-brief](subagent-brief/SKILL.md) | Seven-block template for briefing sub-agents so they operate at the same standard as the orchestrator |
| [self-performance-review](self-performance-review/SKILL.md) | Weekly evidence-based self-review — pulls your comms/calendar/session data, benchmarks against management canon, grades last week's targets |
| [calendar-review](calendar-review/SKILL.md) | Calendar hygiene audit — protects focus blocks, finds slots, flags conflicts with concrete fallbacks |
| [claude-memory](claude-memory/SKILL.md) | Tiered memory system (session → project → global → federated) with backup, doctor, ledger, and hook scripts |
| [session-namer](session-namer/SKILL.md) | Generates clean, searchable session names from Claude Code conversation history via headless automation |
| [posthog-design-customization](posthog-design-customization/SKILL.md) | PostHog dashboard colour-theming protocol via browser-fetch PATCH; documents the MCP field-stripping workaround |
| [slack-status](slack-status/SKILL.md) | Sets Slack status via three-tier auth ladder (in-page fetch → self-copied session token → xoxp app token) |
| [testing-standards](testing-standards/SKILL.md) | Project-scoped testing doctrine: fill-in-the-blank spec, surface coverage map, and per-layer verification gates |

Each skill practices what it preaches: decision-first structure, named failure modes with detection signals, explicit verification gates, and a defined output contract.

## Install

Clone the repo and copy whichever skills you need into your skills directory:

```bash
git clone https://github.com/justinwilliames/skills.git
cp -R skills/operator-standard ~/.claude/skills/
```

Or reference the files directly from `CLAUDE.md` / system prompts / sub-agent briefs — the suite is plain markdown and model-agnostic.

The highest-leverage deployment is pasting the relevant rules into **sub-agent briefs** via the `subagent-brief` skill: delegated agents drift to default habits fastest, and their reports become your claims.

## License

MIT

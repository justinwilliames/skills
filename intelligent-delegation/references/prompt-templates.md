# Chunk Prompt Templates

Every chunk prompt — Sonnet subagent or Codex — must be **self-contained**. The runner has no memory of the orchestrator's conversation, no knowledge of the broader plan, and (critically) no idea where to write its output unless you tell it. Templates here are the canonical shape.

## The workspace contract

Every chunk writes to its own `workspace/` directory under the run dir. The orchestrator copies `workspace/` contents into the project after audit. Two non-negotiable rules:

1. **Relative paths only inside the workspace.** A chunk creating `src/foo.ts` writes to `<workspace>/src/foo.ts`. Never `<project>/src/foo.ts`.
2. **The project is read-only context.** Chunks may read files at the project path to understand existing code, but they MUST NOT write there.

The orchestrator resolves the absolute workspace path before launching:
```bash
WS=$({base}/scripts/delegate.sh workspace "$RUN_ID" chunk-1)
```

## Sonnet subagent template

```
You are implementing chunk <ID> of a delegated build.

PROJECT (read-only context — do not modify):
  <absolute project path>

WORKSPACE (write all outputs here, using relative paths):
  <absolute workspace path>

INTENT:
  <chunk.intent verbatim>

FILES TO CREATE (relative to WORKSPACE):
  - <files_touched[0]>
  - <files_touched[1]>
  …

CONSTRAINTS:
  - Only create the files listed above. Do not produce any other file inside WORKSPACE.
  - You may read files from PROJECT to understand conventions, types, fixtures.
  - Do not run package installs, do not modify the project, do not invoke git.
  - Use the project's existing language conventions, module style, and import patterns.

VERIFICATION:
  After writing, run from WORKSPACE:
    <verification command, adapted to run against workspace files>
  Confirm it passes before finishing.

FINAL MESSAGE:
  Report: (1) file list, (2) one-line test summary, (3) any deviation from the intent.
```

Launch (background, fresh-cache):
```python
Agent(
  subagent_type="general-purpose",
  model="sonnet",
  run_in_background=True,
  prompt="<filled template above>",
)
```

## Modifying existing files (refactor chunks)

The template above says "FILES TO CREATE" — the common case. When a chunk must **modify** a file that already exists in the project (a rename, a refactor, an edit to existing code), two things change:

1. **The chunk reads the project original and writes the COMPLETE modified file into its workspace** at the same relative path. It does not emit a diff or a patch — it emits the whole updated file, because `apply` copies workspace files over project files verbatim. Swap the template's `FILES TO CREATE` stanza for:
   ```
   FILES TO MODIFY (read the original from PROJECT, write the full updated file to WORKSPACE at the same relative path):
     - <files_touched[0]>
   ```
2. **`preflight` will flag every existing target path** (that's its job — it guards against silent overwrites). For a modify-run this is *expected*: confirm the overwrite with the user at Step 4, then run `preflight --force`. `audit` still enforces that the chunk produced only its declared `files_touched`.

`files_touched` lists every file the chunk creates **or modifies** — the collision/audit guarantees are identical either way.

## Codex template

Codex is opinionated and minimal. Lead with the contract, then the intent:

```
Chunk <ID> of a delegated build.

WORKSPACE (write here, relative paths only): <absolute workspace path>
PROJECT (read-only context): <absolute project path>

Create exactly these files inside WORKSPACE:
  <files_touched list>

INTENT: <chunk.intent>

Do not write outside WORKSPACE. Do not invoke git. After writing, run the
verification command from WORKSPACE and confirm it passes:
  <verification command>

Report the file list and test summary.
```

Launch:
```bash
{base}/codex/scripts/codex.sh run "<prompt>" \
  --dir "$WS" \
  --sandbox workspace-write \
  --effort medium
```

`workspace-write` confines writes to `--dir` (the chunk workspace).

## Review-mode template (Codex, `/delegate review`)

Review mode is a 1-chunk Codex run that produces a `review.md` artefact instead of code files. Use case: adversarial second opinion on an Opus-authored plan, draft, integration approach, or risky algorithm. Codex with `--effort high` gives model-family diversity and a sceptical perspective.

### When to use review mode

- Reviewing an Opus-authored implementation plan before fan-out.
- Sanity-checking a risky integration point (auth, payments, migration logic).
- Getting a second opinion on a critical algorithm before shipping.
- Adversarial pass on a finished diff to find missing tests / edge cases.

Do **not** use review mode for: trivial code review (Sonnet does this fine), conversational questions, or anything that doesn't merit a different model family's perspective.

### Template

```
You are reviewing chunk <ID> of a delegated build. This is REVIEW MODE — you do not modify code, you produce a written review.

WORKSPACE (write your review here, single file only): <absolute workspace path>
PROJECT (read-only context): <absolute project path>

DRAFT UNDER REVIEW:
  <inline plan text, OR a file path inside PROJECT, OR a description of the artefact>

REVIEW SCOPE (dimensions to check):
  - Correctness — does the design / code do what it claims?
  - Edge cases — what inputs / states are unhandled?
  - Missing tests — what should be tested that isn't?
  - Scalability — what breaks at 10x / 100x volume?
  - Security — any injection / auth / secret-leak risks?
  - Conventions — does it follow the project's existing patterns?

OUTPUT:
  Write `review.md` in WORKSPACE with these sections (use markdown):

  # Review: <title>

  ## Summary
  One-paragraph verdict. Lead with: ship-as-is / ship-with-fixes / do-not-ship.

  ## Strengths
  What the draft gets right. Specific, not generic praise.

  ## Risks
  Concrete failure modes, ordered by severity. Each risk: what breaks, under what conditions, how likely.

  ## Missing pieces
  Tests, error handling, edge cases, documentation — anything the draft skips that it shouldn't.

  ## Recommended changes
  Prioritised list. Each item: what to change, why, rough effort estimate (small/medium/large).

  Do not modify any project files. Do not write outside WORKSPACE.
```

### Launch

```bash
{base}/codex/scripts/codex.sh run "<filled review prompt>" \
  --dir "$WS" \
  --sandbox workspace-write \
  --effort high \
  --model gpt-5.6-sol
```

`--effort high` is the default for review mode (deeper reasoning matters more than speed for second-opinion work).

### Manifest shape

Review-mode manifests have a single chunk:

```json
{
  "id": "review",
  "title": "review <subject>",
  "intent": "<what to review and against what dimensions>",
  "files_touched": ["review.md"],
  "runner": "codex",
  "verification": ""
}
```

The orchestrator **skips the apply step** for review runs — `review.md` stays in the workspace. The summary phase prints its contents (or a path link) to the user.

## Adapting verification to workspace

Chunks ship with `verification` written for the **project root**. To run it in the workspace, the chunk must either:

- Run with imports that resolve within the workspace (typical for self-contained test files importing siblings).
- Use absolute imports back into the project (uncommon — usually only when the chunk extends an existing module).

In practice: most chunks have purely local imports (`./foo.js` to `./foo.test.js`), and `node --test src/*.test.js` runs identically in workspace or project. If a chunk needs project-level resolution the workspace can't satisfy, defer verification to the post-`apply` QA gate and omit chunk-level `verification`.

## What never to put in a chunk prompt

- "Coordinate with chunk-2 about X" — chunks must not depend on sibling state.
- "Update package.json to add Y" — package-level changes belong in their own chunk with `runner: main`.
- "Choose between A and B" — chunks are deterministic execution units, not design discussions. Design decisions belong in the orchestrator turn, before fan-out.
- Conversation history, prior turns, or "as we discussed". The chunk has no memory.

## Failure handling

If a chunk reports failure or its verification fails:
1. Orchestrator sets `status=failed`, `result=<one-line error>`.
2. Orchestrator does NOT auto-retry *hard* failures. (Transient failures — `timeout`/`429`/`ECONNRESET`/`503` — get exactly one silent retry; see the transient-vs-hard policy in `orchestration-patterns.md`.)
3. Surface to the user: chunk id, intent, error, suggested fix.
4. If the user approves, re-run via `/delegate resume <run-id>` after fixing the chunk's source state.

## Session-handoff transfer prompt

> Moved here from SKILL.md 2026-07-30 (R10 economy pass). Reason: it is a ~55-line template in a file that loads on every session, and `delegate.sh handoff` already generates it from the manifest — the always-loaded file should carry the *trigger*, not the boilerplate. (Its `##` lines are inside a code fence and never were real headings; an earlier note here claimed otherwise and was wrong.) SKILL.md carries the triggers and the rule; this is the shape.

For a run in flight, `delegate.sh handoff <run-id>` generates this automatically from the manifest + `state.tsv`. Author it by hand only when there is no delegate run to read from.

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

If a delegate run is in progress, append:

```
## Delegate run
run_id: <run-id>
project: <path>
pending chunks: <ids>
next step: /delegate resume <run-id>
```

Keep it tight enough to paste without hesitation.

## `opus-1m-cli` — the 1M subprocess spawn block

> Moved here from SKILL.md 2026-07-30 (R10 economy pass). SKILL.md carries the routing rule; this is the invocation.

The Agent tool's `model` param accepts `opus|sonnet|haiku|fable`, so a Fable *delegate* spawns natively — but a **1M context window** does not: subagent context is bounded by the orchestrator's allowance, well below 1M, whatever the model. For a genuine >150K read surface, route via a Bash subprocess to the Claude Code CLI. Opus 5's native 1M window means a plain `--model claude-opus-5` holds the full window — no special variant string.

```bash
claude -p "$(cat <<'EOF'
You are a 1M-context delegated chunk. Read surface: ~280K tokens across the listed files.

PROJECT (read-only): /path/to/project
WORKSPACE (write here, relative paths): /tmp/delegate/<run-id>/chunk-2/workspace

Task: <intent>
Files to load: <explicit list, OR a glob>
Deliverables: <files to write>
Verification: <command to run on completion>

Report: final file list + verification result.
EOF
)" \
  --model 'claude-opus-5' \
  --permission-mode plan \
  --add-dir /path/to/project
```

- `--permission-mode plan` stops the chunk prompting for tool approvals; pre-approve via project settings if it needs to write.
- `--add-dir` grants read access to the project. The workspace stays at `$RUN_DIR/<chunk-id>/workspace` per the standard contract.
- No `task-notification` token telemetry from a CLI subprocess — scrape the final stdout line, or parse `--output-format json` if you need exact counts in `state.tsv`.
- Spawn latency ~2–4s (process boot + cache warm). Fine for a chunk running for minutes; wrong for a fan-out of 10 narrow tasks.
- Manifest runner is `opus-1m-cli` (wired into `delegate.sh validate` + `manifest-schema.md`).
- Build the prompt body on your standard briefing spine, same as any other spawn.

# Delegation Manifest Schema

The manifest is the contract between the orchestrator and the runner. It describes the task, the chunks, their runners, file boundaries, and how each result will be verified. If the orchestrator can't explain the work clearly enough to write the manifest, it isn't ready to fan out.

The manifest is **immutable** once installed into a run (`delegate.sh write-manifest`). To change the plan, init a fresh run.

## Top-level fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `task` | string | yes | Human-readable summary of the overall task. |
| `run_id` | string | yes | Echoes the run-id returned by `delegate.sh init`. Format: `YYYYMMDD-HHMMSS-<4hex>`. |
| `project_verification` | string | yes | Shell command, runs in the project root, after `apply`. The final QA gate. |
| `chunks` | array | yes | One or more chunk objects. |

There is no `integration_branch`. The skill is git-free; integration happens via workspace copy-back.

## Chunk object

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | `^[a-z0-9][a-z0-9-]*$`. Stable, unique within the manifest. |
| `title` | string | yes | Short operator-friendly label. |
| `intent` | string | yes | The outcome the chunk must achieve. Not just a restatement of `title`. |
| `files_touched` | string[] | yes | **Non-empty.** Relative paths from project root. Used for: collision validation, audit (chunk must not produce undeclared files), preflight (target files must not pre-exist). |
| `runner` | enum | yes | One of `sonnet-subagent` \| `haiku-subagent` \| `opus-subagent` \| `codex` \| `fable-subagent` \| `opus-1m-cli` \| `main`. |
| `depends_on` | string[] | no | Chunk IDs that must complete before this one starts. Default `[]`. |
| `verification` | string | no | Shell command, runs in project root after `apply`. Skipped if absent. |

### Runner semantics

- `sonnet-subagent` — orchestrator launches a Sonnet `Agent(...)` with the chunk prompt and absolute workspace path. Runs in background; orchestrator collects via `TaskOutput`.
- `opus-subagent` — same `Agent(...)` shape with `model="opus"`. **The high-quality default for code chunks:** best build quality per chunk. Use `sonnet-subagent` instead for wide fan-outs of tightly-specified, easily-verified chunks, where wall-clock and cost matter more than per-chunk depth.
- `haiku-subagent` — same `Agent(...)` shape with `model="haiku"`. Narrow text/data work only (classify, tag, format-convert, bulk mechanical edits) where verification is trivial. See SKILL.md → "When to Use Haiku vs Sonnet".
- `codex` — orchestrator runs `codex.sh run ... --dir <workspace> --sandbox workspace-write`. Background.
- `fable-subagent` — `Agent(...)` shape with `model="fable"`. **Apex reasoning target, not a default worker, and not a general upgrade over the Opus 5 seat.** Reserve for Fable's two surviving evidenced lanes: multi-day-autonomy stamina, and SWE-bench-Pro-shaped repo judgment (plus a blocker-conflict tie-break at Step 10.5). Research-grade decomposition and subtlest-algorithmic-correctness are **no longer Fable lanes** — they moved back to the Opus 5 seat with ultrathink. Name the lane or don't spawn it. See SKILL.md → "Fable 5 routing".
- `opus-1m-cli` — Bash subprocess to the Claude Code CLI for a chunk whose *read surface* exceeds ~150K tokens (native 1M window, fresh session). Not the orchestrator seat. See SKILL.md → "1M Context Routing".
- `main` — orchestrator implements this chunk itself in-session (after fan-out returns, or before, depending on `depends_on`). Reserve for chunks that genuinely need orchestrator context.

### Files_touched discipline

- Every file the chunk creates or modifies must be listed.
- Paths are **relative to project root**, NOT to the workspace.
- The chunk writes files at `<workspace>/<relative-path>` and the orchestrator copies them back preserving structure.
- Two concurrent chunks (no transitive `depends_on` relationship) listing the same path will fail `validate`.
- A chunk producing a file not in its `files_touched` will fail `audit`.

### Dependency rules

- `depends_on` cycles are rejected at `validate`.
- References to unknown chunk IDs are rejected at `validate`.
- Chunks with overlapping `files_touched` are valid **only** when one transitively depends on the other.

## Example

```json
{
  "task": "Add slugify and truncate utilities with tests",
  "run_id": "20260511-153022-a4b9",
  "project_verification": "npm test",
  "chunks": [
    {
      "id": "slugify",
      "title": "slugify utility",
      "intent": "Export slugify(str) that lowercases, trims, and hyphenates. Tests cover punctuation, whitespace, idempotency.",
      "files_touched": ["src/slugify.js", "src/slugify.test.js"],
      "runner": "sonnet-subagent",
      "depends_on": [],
      "verification": "node --test src/slugify.test.js"
    },
    {
      "id": "truncate",
      "title": "truncate utility",
      "intent": "Export truncate(str, max). Pass-through when len <= max, else slice + ellipsis. Tests cover edge cases.",
      "files_touched": ["src/truncate.js", "src/truncate.test.js"],
      "runner": "codex",
      "depends_on": [],
      "verification": "node --test src/truncate.test.js"
    }
  ]
}
```

## Validation

```bash
delegate.sh validate <run-id>
```

Catches: invalid types, missing required keys, duplicate `id`, unknown `runner`, unknown dep references, dep cycles, concurrent file overlaps, empty `files_touched`. Exits non-zero on first error class with a list of all errors.

## Manifest vs state

The manifest is the plan. `state.tsv` is the progress. The orchestrator updates `state.tsv` mid-flight via `delegate.sh set` — never edits the manifest. The two together let `/delegate resume` re-fan only what's still pending or failed.

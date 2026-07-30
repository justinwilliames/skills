#!/usr/bin/env bash
# delegate.sh — git-free orchestrator engine for intelligent-delegation.
#
# State lives under $TMPDIR/delegate/<run-id>/:
#   manifest.json           full manifest as authored by the orchestrator
#   state.tsv               compact, grep-able orchestrator state (the only thing
#                           re-read mid-flight; designed for low token cost)
#   <chunk-id>/workspace/   chunk's write target (chunk emits files here under
#                           relative paths matching files_touched)
#   <chunk-id>/result.txt   one-line PASS|FAIL + summary written by orchestrator
#   <chunk-id>/output.log   captured chunk stdout/stderr for telemetry
#
# state.tsv layout:
#   # run_id=... project=... task=...
#   id\tstatus\trunner\tfiles\tverification\ttokens\tduration_ms\tresult
#
# Sub-commands cover the whole lifecycle. The orchestrator never has to invoke
# git, awk, or jq directly — it just calls these.
set -euo pipefail
if [[ "${DELEGATE_DEBUG:-0}" == "1" ]]; then
  set -E
  trap 'echo "TRAP @ line=$LINENO cmd=$BASH_COMMAND status=$?" >&2' ERR
fi

DELEGATE_ROOT="${DELEGATE_ROOT:-${TMPDIR:-/tmp}/delegate}"
LAST_FILE="$DELEGATE_ROOT/LAST"

# ── helpers ──────────────────────────────────────────────────────────────────

print_error() { printf 'ERROR: %s\n' "$*" >&2; }

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    print_error "missing required command: $1"
    exit 1
  fi
}

usage() {
  cat <<'EOF'
delegate.sh — git-free orchestration engine

Lifecycle:
  init <task> [--project PATH]            Create a run dir, return RUN_ID.
  write-manifest <run-id> <json-file>     Install a manifest into a run.
  validate <run-id>                       Validate manifest (schema + collisions).
  preflight <run-id> [--force]            Check target files don't already exist.
  prepare <run-id>                        Create per-chunk workspaces.
  set <run-id> <chunk-id> <field>=<val>...  Update state.tsv cells.
  get <run-id> <chunk-id> [field]         Read state.tsv cells.
  state <run-id>                          Print full state.tsv.
  workspace <run-id> <chunk-id>           Print absolute workspace path.
  diff <run-id> <chunk-id>                List files produced by a chunk.
  audit <run-id>                          Check undeclared/overlapping files
                                          across all chunks.
  apply <run-id>                          Copy chunk workspaces into project.
  qa <run-id>                             Run per-chunk + project verification.
  codex <run-id> <chunk-id> "<prompt>"    Run codex directly (workspace-write
                                          sandbox, JSONL events) and auto-capture
                                          input/output token totals into state.tsv.
  autodetect <project-path>               Print suggested verification commands for
                                          a project (test/typecheck/build). Use
                                          before authoring the manifest.
  summary <run-id>                        Print a compact run summary.
  watch [run-id]                          Compact one-shot snapshot of state.tsv with counts.
  liveness [run-id] [--stale-secs N]      Liveness check on every `running` chunk:
           [--grace-secs N]               spawn stamp (<chunk>/.spawned) + newest
                                          artifact mtime anywhere under <chunk>/.
                                          Verdicts: ALIVE | BOOTING | SILENT | STALLED.
                                          Exit 2 if any SILENT/STALLED; exit 3 if the
                                          run is unusable (ABORTED, or empty state.tsv).
  handoff <run-id>                        Generate a paste-ready context-transfer
                                          prompt for starting a fresh session.
  pending <run-id>                        Print chunk ids still pending/failed.
  resume [run-id]                         Print run-id eligible for re-fan
                                          (defaults to last run).
  last                                    Print last run-id.
  abort <run-id> [reason]                 Mark all running chunks failed; write ABORTED marker.
  clean <run-id>                          Remove a run dir.

Conventions:
  - All paths inside the manifest are relative to the project root.
  - Field values in `set` must not contain literal tab characters.
  - Status values: pending|running|done|failed|skipped.

EOF
}

run_dir()      { printf '%s/%s\n' "$DELEGATE_ROOT" "$1"; }
manifest_of()  { printf '%s/manifest.json\n' "$(run_dir "$1")"; }
state_of()     { printf '%s/state.tsv\n' "$(run_dir "$1")"; }
workspace_of() { printf '%s/%s/workspace\n' "$(run_dir "$1")" "$2"; }

ensure_run() {
  local rd; rd=$(run_dir "$1")
  if [[ ! -d $rd ]]; then
    print_error "unknown run-id: $1"; exit 1
  fi
}

read_meta() {
  # read a header field from state.tsv.
  # task is stored alone on "# task=<value>" so spaces are preserved.
  # other fields (run_id, project) are on "# run_id=X project=Y" and are single-word.
  local file=$1 key=$2
  awk -v k="$key" '
    /^# / {
      line = substr($0, 3)
      # check for whole-line  key=<rest>  pattern first (handles task with spaces)
      if (line ~ "^" k "=") {
        val = substr(line, length(k) + 2)
        print val; exit 0
      }
      # fall back to space-delimited  key=value  pairs on a multi-field line
      n = split(line, parts, /[[:space:]]+/)
      for (i = 1; i <= n; i++) {
        eq = index(parts[i], "=")
        if (eq > 0 && substr(parts[i], 1, eq-1) == k) {
          print substr(parts[i], eq+1); exit 0
        }
      }
    }' "$file"
}

# ── init ─────────────────────────────────────────────────────────────────────

cmd_init() {
  local task="" project=""
  while (($# > 0)); do
    case "$1" in
      --project) project=$2; shift 2 ;;
      *) task="$1"; shift ;;
    esac
  done
  [[ -n $task ]] || { print_error "init requires <task>"; exit 1; }
  project=${project:-$PWD}
  [[ -d $project ]] || { print_error "project path not a directory: $project"; exit 1; }
  project=$(cd "$project" && pwd)

  local rand ts run_id rd
  rand=$(printf '%04x' $(( (RANDOM * RANDOM) & 0xffff )))
  ts=$(date +%Y%m%d-%H%M%S)
  run_id="${ts}-${rand}"
  rd=$(run_dir "$run_id")
  mkdir -p "$rd"

  # state.tsv with header (each field on its own # line to handle spaces in paths/task)
  {
    printf '# run_id=%s\n' "$run_id"
    printf '# project=%s\n' "$project"
    printf '# task=%s\n' "$task"
    printf 'id\tstatus\trunner\tfiles\tverification\ttokens\tduration_ms\tresult\n'
  } >"$(state_of "$run_id")"

  mkdir -p "$(dirname "$LAST_FILE")"
  printf '%s\n' "$run_id" >"$LAST_FILE"

  printf 'RUN_ID: %s\n' "$run_id"
  printf 'RUN_DIR: %s\n' "$rd"
  printf 'PROJECT: %s\n' "$project"
}

cmd_last() {
  [[ -f $LAST_FILE ]] || { print_error "no previous run"; exit 1; }
  cat "$LAST_FILE"
}

# ── write-manifest ───────────────────────────────────────────────────────────

cmd_write_manifest() {
  local run_id=$1 src=$2
  ensure_run "$run_id"
  [[ -f $src ]] || { print_error "manifest source not found: $src"; exit 1; }
  jq empty "$src" >/dev/null 2>&1 || { print_error "invalid JSON: $src"; exit 1; }
  cp "$src" "$(manifest_of "$run_id")"

  # seed state.tsv chunk rows from manifest (idempotent: replaces existing data rows)
  local state; state=$(state_of "$run_id")
  # preserve ALL leading metadata (# lines) plus the column-header row — cmd_init
  # writes three # lines (run_id/project/task) then the header; head -n 2 dropped
  # the task line and the column header, breaking handoff/summary.
  local header; header=$(awk 'BEGIN{h=1} h&&/^#/{print;next} h{print;h=0;next} {exit}' "$state")
  {
    printf '%s\n' "$header"
    jq -r '
      .chunks[]? |
      [
        (.id // ""),
        "pending",
        (.runner // ""),
        ((.files_touched // []) | join(",")),
        (.verification // ""),
        "-",
        "-",
        "-"
      ] | @tsv
    ' "$(manifest_of "$run_id")"
  } >"${state}.tmp"
  mv "${state}.tmp" "$state"
  printf 'MANIFEST_INSTALLED\n'
}

# ── validate ─────────────────────────────────────────────────────────────────

cmd_validate() {
  local run_id=$1
  ensure_run "$run_id"
  local manifest; manifest=$(manifest_of "$run_id")
  [[ -f $manifest ]] || { print_error "no manifest installed for $run_id"; exit 1; }

  local errors
  errors=$(jq -r '
    def chunks_array:
      if (.chunks? | type) == "array" then .chunks else [] end;
    def ids:
      [chunks_array[] | select(type == "object" and (.id? | type == "string")) | .id];
    def chunk_by_id($id):
      ([chunks_array[] | select(type == "object" and (.id? | type == "string") and .id == $id)][0]);
    def dep_ids($id):
      [chunk_by_id($id).depends_on[]? | select(type == "string")];
    def files_for($id):
      [chunk_by_id($id).files_touched[]? | select(type == "string")];
    def reaches($from; $to; $seen):
      if ($seen | index($from)) != null then false
      else [dep_ids($from)[] | select(. == $to or reaches(.; $to; $seen + [$from]))] | length > 0
      end;
    def has_cycle_from($id; $stack):
      if ($stack | index($id)) != null then true
      else [dep_ids($id)[] | select(has_cycle_from(.; $stack + [$id]))] | length > 0
      end;

    if type != "object" then "manifest root must be an object"
    else
      ((["task","run_id","project_verification","chunks"] - keys_unsorted)[]? | "missing top-level key: \(.)"),
      (if has("chunks") and (.chunks|type != "array") then "chunks must be an array" else empty end),
      (if has("project_verification") and (.project_verification|type != "string") then "project_verification must be a string" else empty end),
      (
        if (.chunks? | type) == "array" then
          .chunks | to_entries[] | .key as $i | .value as $c |
          if ($c|type) != "object" then "chunk[\($i)] must be an object"
          else
            ((["id","title","intent","runner","files_touched"] - ($c|keys_unsorted))[]? | "chunk[\($i)] missing key: \(.)"),
            (if ($c|has("runner")) and ([ "sonnet-subagent","haiku-subagent","opus-subagent","codex","fable-subagent","opus-1m-cli","main" ] | index($c.runner) | not)
              then "chunk[\($i)] invalid runner: \($c.runner)" else empty end),
            (if ($c|has("files_touched")) and ($c.files_touched|type != "array")
              then "chunk[\($i)] files_touched must be an array" else empty end),
            (if ($c|has("files_touched")) and ($c.files_touched|type == "array") and any($c.files_touched[]?; type != "string")
              then "chunk[\($i)] files_touched entries must be strings" else empty end),
            (if ($c|has("files_touched")) and ($c.files_touched|type == "array") and (($c.files_touched|length) == 0)
              then "chunk[\($i)] files_touched must be non-empty" else empty end),
            (if ($c|has("depends_on")) and ($c.depends_on|type != "array")
              then "chunk[\($i)] depends_on must be an array" else empty end)
          end
        else empty end
      ),
      (ids | group_by(.) | .[] | select(length > 1) | "duplicate chunk id: \(.[0])"),
      (
        ids as $ids | .chunks[]? |
        select(type == "object" and (.id?|type == "string") and (.depends_on?|type == "array")) |
        .id as $id | .depends_on[]? |
        select(type == "string" and ($ids|index(.) == null)) |
        "chunk \($id) depends on unknown chunk: \(.)"
      ),
      (ids[] | select(has_cycle_from(.; [])) | "dependency cycle detected at chunk: \(.)"),
      (
        ids as $ids |
        range(0; ($ids|length)) as $li |
        range($li+1; ($ids|length)) as $ri |
        $ids[$li] as $L | $ids[$ri] as $R |
        select((reaches($L;$R;[]) or reaches($R;$L;[])) | not) |
        ([files_for($L)[] as $f | select(files_for($R)|index($f) != null) | $f] | unique) as $ov |
        select(($ov|length) > 0) |
        "concurrent chunks \($L) and \($R) overlap files: \($ov|join(", "))"
      )
    end
  ' "$manifest" 2>&1)

  if [[ -n $errors ]]; then
    printf '%s\n' "$errors" >&2
    exit 1
  fi
  printf 'VALID\n'
}

# ── preflight ────────────────────────────────────────────────────────────────

cmd_preflight() {
  local run_id=$1; shift
  local force=0
  while (($# > 0)); do
    case "$1" in
      --force) force=1; shift ;;
      *) print_error "unknown flag: $1"; exit 1 ;;
    esac
  done
  ensure_run "$run_id"

  local project; project=$(read_meta "$(state_of "$run_id")" project)
  local collisions=""
  local rel
  while IFS= read -r rel; do
    if [[ -z $rel ]]; then continue; fi
    if [[ -e "$project/$rel" ]]; then collisions+="$rel"$'\n'; fi
  done < <(jq -r '.chunks[]?.files_touched[]?' "$(manifest_of "$run_id")" 2>/dev/null)

  if [[ -n $collisions ]]; then
    if ((force)); then
      printf 'PREFLIGHT_WARN: target files exist (--force):\n%s\n' "$collisions" >&2
    else
      printf 'PREFLIGHT_FAIL: target files already exist (pass --force to override):\n' >&2
      printf '%s\n' "$collisions" >&2
      exit 1
    fi
  fi
  printf 'PREFLIGHT_OK\n'
}

# ── prepare ──────────────────────────────────────────────────────────────────

cmd_prepare() {
  local run_id=$1
  ensure_run "$run_id"
  local manifest; manifest=$(manifest_of "$run_id")
  while IFS= read -r chunk_id; do
    if [[ -z $chunk_id ]]; then continue; fi
    mkdir -p "$(workspace_of "$run_id" "$chunk_id")"
  done < <(jq -r '.chunks[]?.id // empty' "$manifest")
  printf 'PREPARED\n'
}

# ── state set / get / print ──────────────────────────────────────────────────

cmd_set() {
  local run_id=$1 chunk_id=$2; shift 2
  ensure_run "$run_id"
  local state; state=$(state_of "$run_id")

  # parse key=value pairs into associative names
  local updates_status="" updates_tokens="" updates_duration="" updates_result=""
  local kv key val
  for kv in "$@"; do
    key=${kv%%=*}; val=${kv#*=}
    if [[ "$val" == *$'\t'* ]]; then print_error "tabs not allowed in values: $key"; exit 1; fi
    case "$key" in
      status)      updates_status=$val ;;
      tokens)      updates_tokens=$val ;;
      duration_ms) updates_duration=$val ;;
      result)      updates_result=$val ;;
      *) print_error "unknown field: $key"; exit 1 ;;
    esac
  done

  awk -F'\t' -v OFS='\t' \
      -v cid="$chunk_id" \
      -v st="$updates_status" -v tk="$updates_tokens" \
      -v dr="$updates_duration" -v rs="$updates_result" '
    /^#/ || $1 == "id" { print; next }
    $1 == cid {
      if (st != "") $2 = st
      if (tk != "") $6 = tk
      if (dr != "") $7 = dr
      if (rs != "") $8 = rs
      print; found = 1; next
    }
    { print }
    END { if (!found) exit 2 }
  ' "$state" >"${state}.tmp" || { rm -f "${state}.tmp"; print_error "chunk not in state: $chunk_id"; exit 1; }
  mv "${state}.tmp" "$state"

  # Stamp the spawn time when a chunk goes `running`. This is the liveness
  # gate's second signal — without it there is no way to tell "spawned two
  # seconds ago and still booting" from "hung twenty minutes ago", and the
  # gate false-alarms on every healthy fan-out.
  if [[ $updates_status == "running" ]]; then
    mkdir -p "$(run_dir "$run_id")/$chunk_id"
    : > "$(run_dir "$run_id")/$chunk_id/.spawned"
  fi
}

cmd_get() {
  local run_id=$1 chunk_id=$2 field=${3:-}
  ensure_run "$run_id"
  awk -F'\t' -v cid="$chunk_id" -v f="$field" '
    /^#/ || $1 == "id" { next }
    $1 == cid {
      found = 1
      if (f == "" || f == "all") { print; next }
      if (f == "status")      { print $2; next }
      if (f == "runner")      { print $3; next }
      if (f == "files")       { print $4; next }
      if (f == "verification"){ print $5; next }
      if (f == "tokens")      { print $6; next }
      if (f == "duration_ms") { print $7; next }
      if (f == "result")      { print $8; next }
      bad_field = 1; next
    }
    END { if (!found || bad_field) exit 1 }
  ' "$(state_of "$run_id")"
}

cmd_state()      { ensure_run "$1"; cat "$(state_of "$1")"; }
cmd_workspace()  { ensure_run "$1"; printf '%s\n' "$(workspace_of "$1" "$2")"; }

cmd_pending() {
  ensure_run "$1"
  awk -F'\t' '!/^#/ && $1 != "id" && ($2 == "pending" || $2 == "failed") { print $1 }' "$(state_of "$1")"
}

cmd_resume() {
  local run_id=${1:-}
  if [[ -z $run_id ]]; then
    [[ -f $LAST_FILE ]] || { print_error "no previous run"; exit 1; }
    run_id=$(cat "$LAST_FILE")
  fi
  ensure_run "$run_id"
  printf 'RUN_ID: %s\n' "$run_id"
  printf 'PENDING:\n'
  cmd_pending "$run_id"
}

# ── diff / audit ─────────────────────────────────────────────────────────────

cmd_diff() {
  local run_id=$1 chunk_id=$2
  ensure_run "$run_id"
  local ws; ws=$(workspace_of "$run_id" "$chunk_id")
  [[ -d $ws ]] || { print_error "no workspace for $chunk_id"; exit 1; }
  (cd "$ws" && find . -type f ! -name '.DS_Store' | sed 's|^\./||' | sort)
}

cmd_audit() {
  local run_id=$1
  ensure_run "$run_id"
  local manifest; manifest=$(manifest_of "$run_id")
  local errors=0

  # build chunk → declared-files map
  local decl; decl=$(jq -r '.chunks[]? | "\(.id)\t\(.files_touched|join(","))"' "$manifest")

  # 1. each chunk's workspace should contain only declared files
  while IFS=$'\t' read -r cid declared; do
    if [[ -z $cid ]]; then continue; fi
    local ws; ws=$(workspace_of "$run_id" "$cid")
    [[ -d $ws ]] || continue
    local actual; actual=$(cd "$ws" && find . -type f ! -name '.DS_Store' | sed 's|^\./||' | sort)
    local rel
    while IFS= read -r rel; do
      if [[ -z $rel ]]; then continue; fi
      if ! printf '%s\n' "${declared//,/$'\n'}" | grep -Fxq "$rel"; then
        printf 'AUDIT_FAIL: %s produced undeclared file: %s\n' "$cid" "$rel" >&2
        errors=$((errors+1))
      fi
    done <<<"$actual"
  done <<<"$decl"

  # 2. no two chunks should have emitted the same file
  local all_files; all_files=$(
    while IFS=$'\t' read -r cid _; do
      if [[ -z $cid ]]; then continue; fi
      local ws; ws=$(workspace_of "$run_id" "$cid")
      [[ -d $ws ]] || continue
      (cd "$ws" && find . -type f ! -name '.DS_Store' | sed 's|^\./||' | while read -r f; do printf '%s\t%s\n' "$f" "$cid"; done)
    done <<<"$decl"
  )
  local dupes; dupes=$(printf '%s\n' "$all_files" | awk -F'\t' 'NF==2 {n[$1]++; src[$1]=src[$1]","$2} END { for (f in n) if (n[f] > 1) print f"\t"substr(src[f],2) }')
  if [[ -n $dupes ]]; then
    while IFS=$'\t' read -r f srcs; do
      printf 'AUDIT_FAIL: file emitted by multiple chunks: %s (from %s)\n' "$f" "$srcs" >&2
      errors=$((errors+1))
    done <<<"$dupes"
  fi

  if ((errors > 0)); then exit 1; fi
  printf 'AUDIT_OK\n'
}

# ── apply ────────────────────────────────────────────────────────────────────

cmd_apply() {
  local run_id=$1
  ensure_run "$run_id"
  # abort marker is a hard stop — refuse to copy any chunk into the project
  [[ -f "$(run_dir "$run_id")/ABORTED" ]] && { print_error "run aborted — refusing apply. Clean + re-init, or resume after fixing the root cause."; exit 1; }
  local project; project=$(read_meta "$(state_of "$run_id")" project)
  [[ -d $project ]] || { print_error "project path missing: $project"; exit 1; }

  local manifest; manifest=$(manifest_of "$run_id")
  local cid copied=0
  while IFS= read -r cid; do
    if [[ -z $cid ]]; then continue; fi
    local status; status=$(cmd_get "$run_id" "$cid" status)
    if [[ "$status" != "done" ]]; then continue; fi
    local ws; ws=$(workspace_of "$run_id" "$cid")
    [[ -d $ws ]] || continue
    # copy workspace contents into project preserving structure
    (cd "$ws" && find . -type f ! -name '.DS_Store' | while read -r rel; do
      rel=${rel#./}
      mkdir -p "$project/$(dirname "$rel")"
      cp "$ws/$rel" "$project/$rel"
      printf 'APPLIED: %s (from %s)\n' "$rel" "$cid"
    done)
    copied=$((copied+1))
  done < <(jq -r '.chunks[]?.id // empty' "$manifest")
  printf 'APPLIED_CHUNKS: %d\n' "$copied"
}

# ── qa ───────────────────────────────────────────────────────────────────────

cmd_qa() {
  local run_id=$1
  ensure_run "$run_id"
  local project; project=$(read_meta "$(state_of "$run_id")" project)
  local manifest; manifest=$(manifest_of "$run_id")
  local failed=0 total=0

  # per-chunk verification
  while IFS=$'\t' read -r cid vcmd; do
    if [[ -z $cid || -z $vcmd || "$vcmd" == "null" ]]; then continue; fi
    total=$((total+1))
    if (cd "$project" && bash -lc "$vcmd") >/dev/null 2>&1; then
      printf 'PASS %s\n' "$cid"
    else
      printf 'FAIL %s\n' "$cid"
      failed=$((failed+1))
    fi
  done < <(jq -r '.chunks[]? | select(.verification != null and .verification != "") | [.id, .verification] | @tsv' "$manifest")

  # project-level
  local proj_cmd; proj_cmd=$(jq -r '.project_verification // empty' "$manifest")
  if [[ -n $proj_cmd ]]; then
    total=$((total+1))
    if (cd "$project" && bash -lc "$proj_cmd"); then
      printf 'PASS project_verification\n'
    else
      printf 'FAIL project_verification\n'
      failed=$((failed+1))
    fi
  fi

  if ((failed == 0)); then
    printf 'QA_PASS: %d/%d\n' "$total" "$total"
    return 0
  fi
  printf 'QA_FAIL: %d/%d failed\n' "$failed" "$total" >&2
  return 1
}

# ── codex (direct exec with --json, token capture) ───────────────────────────
# Codex invocation mirrors the bundled wrapper at codex/scripts/codex.sh
# (vendored from tomc98/claude-code-codex-skill by Thomas Csere, MIT).

cmd_codex() {
  local run_id=${1:-} chunk_id=${2:-} prompt=${3:-}
  [[ -n $run_id && -n $chunk_id && -n $prompt ]] || { print_error "usage: codex <run_id> <chunk_id> <prompt>"; exit 1; }
  ensure_run "$run_id"
  local ws; ws=$(workspace_of "$run_id" "$chunk_id")
  [[ -d $ws ]] || { print_error "no workspace for $chunk_id (run prepare first)"; exit 1; }

  local CODEX_BIN="${CODEX_BIN:-/Applications/Codex.app/Contents/Resources/codex}"
  if [[ ! -x $CODEX_BIN ]]; then
    print_error "codex binary not found: $CODEX_BIN (set CODEX_BIN env var)"
    exit 1
  fi

  local chunk_dir="$(run_dir "$run_id")/$chunk_id"
  local log="$chunk_dir/codex.jsonl"
  local prompt_file="$chunk_dir/codex.prompt"
  local stderr_file="$chunk_dir/codex.stderr"
  local model="${CODEX_MODEL:-gpt-5.6-sol}"
  local effort="${CODEX_EFFORT:-medium}"

  # Feed the prompt via stdin from a tempfile (`-` tells codex to read stdin).
  # Avoids the argv-quoting bug class — complex prompts with newlines, embedded
  # quotes, or heredocs can silently fail when passed as a positional arg, and
  # codex falls through to "read from stdin" and hangs forever. Persisting the
  # prompt file also makes post-mortem debugging trivial.
  printf '%s' "$prompt" >"$prompt_file"

  local rc=0
  "$CODEX_BIN" exec --skip-git-repo-check --json \
    -C "$ws" \
    -s workspace-write \
    -m "$model" \
    -c "model_reasoning_effort=\"$effort\"" \
    - <"$prompt_file" >"$log" 2>>"$stderr_file" || rc=$?

  # final agent_message text (last one wins on multi-turn runs)
  jq -r 'select(.type=="item.completed" and .item.type=="agent_message") | .item.text' "$log" 2>/dev/null | tail -n 1

  # sum input + output tokens across turn.completed events
  local tokens
  tokens=$(jq -r 'select(.type=="turn.completed") | (.usage.input_tokens // 0) + (.usage.output_tokens // 0)' "$log" 2>/dev/null \
    | awk '{s+=$1} END {print s+0}')
  printf '\nTOKENS: %s\n' "$tokens"

  if (( rc == 0 )); then
    cmd_set "$run_id" "$chunk_id" "tokens=$tokens"
  fi
  return $rc
}

# ── autodetect (verification commands for a project) ─────────────────────────

cmd_autodetect() {
  local project=$1
  local script_dir; script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
  "$script_dir/detect-verification.sh" "$project"
}

# ── summary ──────────────────────────────────────────────────────────────────

cmd_summary() {
  local run_id=$1
  ensure_run "$run_id"
  local state; state=$(state_of "$run_id")
  printf 'RUN_ID: %s\n' "$run_id"
  printf 'RUN_DIR: %s\n' "$(run_dir "$run_id")"
  printf 'PROJECT: %s\n' "$(read_meta "$state" project)"
  printf '\n'
  grep -v '^#' "$state" | column -t -s $'\t'
}

# ── watch ───────────────────────────────────────────────────────────────────

cmd_watch() {
  local run_id=${1:-}
  if [[ -z $run_id ]]; then
    [[ -f $LAST_FILE ]] || { print_error "no run-id and no LAST run"; exit 1; }
    run_id=$(cat "$LAST_FILE")
  fi
  ensure_run "$run_id"
  local state; state=$(state_of "$run_id")
  local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local total done_n running_n failed_n pending_n
  total=$(awk -F'\t'   '!/^#/ && $1 != "id" { n++ } END { print n+0 }' "$state")
  done_n=$(awk -F'\t'  '!/^#/ && $1 != "id" && $2 == "done"    { n++ } END { print n+0 }' "$state")
  running_n=$(awk -F'\t' '!/^#/ && $1 != "id" && $2 == "running" { n++ } END { print n+0 }' "$state")
  failed_n=$(awk -F'\t' '!/^#/ && $1 != "id" && $2 == "failed"  { n++ } END { print n+0 }' "$state")
  pending_n=$(awk -F'\t' '!/^#/ && $1 != "id" && $2 == "pending" { n++ } END { print n+0 }' "$state")
  printf 'WATCH %s run_id=%s  done=%d running=%d failed=%d pending=%d total=%d\n' \
    "$ts" "$run_id" "$done_n" "$running_n" "$failed_n" "$pending_n" "$total"
  grep -v '^#' "$state" | column -t -s $'\t'
}

# ── liveness ────────────────────────────────────────────────────────────────
# Liveness check for `running` chunks. A backgrounded agent can hang silently
# and never emit a completion event — "no notification" means UNKNOWN, not
# alive. Two signals, both of which actually exist on disk:
#   1. spawn stamp  — <chunk-id>/.spawned, written by `set status=running`
#   2. artifact age — newest mtime of ANY file under <chunk-id>/ (the workspace,
#                     codex.jsonl, result.txt — whatever the runner emits)
#
# Verdicts:
#   ALIVE    — an artifact moved inside the stale window
#   BOOTING  — no artifacts yet, but spawned less than --grace-secs ago (normal)
#   SILENT   — no artifacts and past the grace window
#   STALLED  — has artifacts, none of them moved inside the stale window
# Exit codes: 0 all ALIVE/BOOTING · 2 any SILENT/STALLED · 3 run is unusable
# (ABORTED marker present, or state.tsv missing/empty) — never report OK over
# a corpse.

_mtime() {
  # portable mtime in epoch seconds; prints 0 when the path is missing
  [[ -e $1 ]] || { printf '0\n'; return; }
  if stat -f %m "$1" 2>/dev/null; then return; fi
  stat -c %Y "$1" 2>/dev/null || printf '0\n'
}

_newest_mtime() {
  # newest mtime of any regular file under a directory, EXCLUDING the .spawned
  # stamp (which would otherwise read as a fresh artifact forever); 0 if none.
  local dir=$1 newest=0 m
  [[ -d $dir ]] || { printf '0\n'; return; }
  while IFS= read -r f; do
    [[ $(basename "$f") == ".spawned" ]] && continue
    m=$(_mtime "$f")
    if (( m > newest )); then newest=$m; fi
  done < <(find "$dir" -type f 2>/dev/null || true)
  printf '%s\n' "$newest"
}

cmd_liveness() {
  local run_id="" stale=${DELEGATE_STALE_SECS:-300} grace=${DELEGATE_GRACE_SECS:-90}
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --stale-secs) stale=$2; shift 2 ;;
      --grace-secs) grace=$2; shift 2 ;;
      -*) print_error "unknown flag: $1"; exit 1 ;;
      *) run_id=$1; shift ;;
    esac
  done
  [[ $stale =~ ^[0-9]+$ ]] || { print_error "--stale-secs must be an integer number of seconds: $stale"; exit 1; }
  [[ $grace =~ ^[0-9]+$ ]] || { print_error "--grace-secs must be an integer number of seconds: $grace"; exit 1; }
  if [[ -z $run_id ]]; then
    [[ -f $LAST_FILE ]] || { print_error "no run-id and no LAST run"; exit 1; }
    run_id=$(cat "$LAST_FILE")
  fi
  ensure_run "$run_id"
  local state; state=$(state_of "$run_id")
  local rdir; rdir=$(run_dir "$run_id")
  local now; now=$(date +%s)
  local bad=0 running_n=0

  printf 'LIVENESS run_id=%s stale_secs=%s grace_secs=%s\n' "$run_id" "$stale" "$grace"

  # A run that has been aborted, or whose state file is gone or empty, cannot
  # be reported healthy — that is the fail-open the gate exists to prevent.
  if [[ -f "$rdir/ABORTED" ]]; then
    printf 'LIVENESS_UNUSABLE: ABORTED marker present — this run cannot be applied. Clean + re-init, or resume after fixing the root cause.\n'
    return 3
  fi
  if [[ ! -s $state ]]; then
    printf 'LIVENESS_UNUSABLE: state.tsv missing or empty for %s — the run has lost its source of truth.\n' "$run_id"
    return 3
  fi

  printf 'chunk\tverdict\tartifact_age_s\tspawn_age_s\tfiles\n'

  while IFS=$'\t' read -r id status _rest; do
    if [[ -z $id || $id == \#* || $id == "id" ]]; then continue; fi
    if [[ $status != "running" ]]; then continue; fi
    running_n=$((running_n + 1))

    local cdir="$rdir/$id"
    local art_m spawn_m nfiles art_age spawn_age verdict
    art_m=$(_newest_mtime "$cdir")
    spawn_m=$(_mtime "$cdir/.spawned")
    nfiles=$(find "$cdir" -type f ! -name .spawned 2>/dev/null | wc -l | tr -d ' ' || true)
    [[ -n $nfiles ]] || nfiles=0

    if (( art_m == 0 )); then art_age=-1; else art_age=$(( now - art_m )); fi
    if (( spawn_m == 0 )); then spawn_age=-1; else spawn_age=$(( now - spawn_m )); fi

    # Guard against clock skew / a future-dated mtime reading as ancient.
    if (( art_age < 0 && art_m != 0 )); then art_age=0; fi

    if (( art_m == 0 )); then
      # No artifacts at all. Booting is normal for the first ~90s; a chunk with
      # no spawn stamp predates this feature, so give it the benefit of grace.
      if (( spawn_age >= 0 && spawn_age < grace )); then verdict=BOOTING; else verdict=SILENT; fi
    elif (( art_age < stale )); then
      verdict=ALIVE
    else
      verdict=STALLED
    fi
    if [[ $verdict == "SILENT" || $verdict == "STALLED" ]]; then bad=$((bad + 1)); fi

    printf '%s\t%s\t%s\t%s\t%s\n' "$id" "$verdict" "$art_age" "$spawn_age" "$nfiles"
  done < "$state"

  if (( running_n == 0 )); then
    printf 'LIVENESS_OK: no running chunks\n'
    return 0
  fi
  if (( bad > 0 )); then
    printf 'LIVENESS_FAIL: %d/%d running chunks not advancing — investigate before collecting.\n' "$bad" "$running_n"
    printf '  STALLED: re-spawn ONCE into a clean workspace (delegate.sh prepare re-creates it), or abort.\n'
    printf '  SILENT : past the grace window with nothing on disk — treat as stalled.\n'
    return 2
  fi
  printf 'LIVENESS_OK: %d/%d running chunks advancing or booting\n' "$running_n" "$running_n"
}

# ── handoff ──────────────────────────────────────────────────────────────────
# Generates a paste-ready context-transfer prompt for starting a fresh session.
# Reads manifest + state.tsv and emits a self-contained brief the new orchestrator
# can act on immediately — task, project path, run-id, chunk statuses, and next step.

cmd_handoff() {
  local run_id=${1:-}
  if [[ -z $run_id ]]; then
    run_id=$(cmd_last 2>/dev/null || true)
    [[ -n $run_id ]] || { print_error "no run-id given and no LAST run found"; exit 1; }
  fi
  ensure_run "$run_id"
  local state; state=$(state_of "$run_id")
  local manifest; manifest=$(manifest_of "$run_id")
  local project task project_verification
  project=$(read_meta "$state" project)
  task=$(read_meta "$state" task)
  if [[ -f $manifest ]]; then
    project_verification=$(jq -r '.project_verification // "none"' "$manifest")
  else
    project_verification="(manifest not yet written)"
  fi

  # Build per-chunk status lines from state.tsv (skip header rows)
  local chunk_lines
  chunk_lines=$(awk -F'\t' '
    /^#/ { next }
    /^id/ { next }
    {
      printf "  %-20s %-10s runner=%-16s tokens=%-8s result=%s\n", $1, $2, $3, $6, $8
    }' "$state")

  # Determine overall next step
  local pending_count done_count failed_count
  pending_count=$(awk -F'\t' '!/^[#i]/ && $2=="pending"' "$state" | wc -l | tr -d ' ')
  failed_count=$(awk  -F'\t' '!/^[#i]/ && $2=="failed"'  "$state" | wc -l | tr -d ' ')
  done_count=$(awk    -F'\t' '!/^[#i]/ && $2=="done"'    "$state" | wc -l | tr -d ' ')

  local next_step
  if (( failed_count > 0 )); then
    next_step="Some chunks failed. Run: /delegate resume ${run_id}"
  elif (( pending_count > 0 )); then
    next_step="Chunks still pending. Run: /delegate resume ${run_id}"
  elif (( done_count > 0 )); then
    # Check if project files already applied (heuristic: any workspace has files)
    local unapplied=0
    while IFS=$'\t' read -r cid status _rest; do
      [[ $cid == id || $cid == \#* ]] && continue
      [[ $status == done ]] || continue
      local ws; ws=$(workspace_of "$run_id" "$cid")
      if [[ -d $ws ]] && (( $(find "$ws" -type f | wc -l) > 0 )); then
        unapplied=1; break
      fi
    done < "$state"
    if (( unapplied )); then
      next_step="All chunks done but workspaces not yet applied. Run: delegate.sh audit then apply then qa."
    else
      next_step="Workspaces applied. Run QA: /delegate qa ${run_id}"
    fi
  else
    next_step="No chunks in done/pending/failed state — check state with: delegate.sh state ${run_id}"
  fi

  printf '============================================================\n'
  printf 'CONTEXT TRANSFER PROMPT — paste into new session\n'
  printf '============================================================\n'
  printf '\n'
  printf '%s\n' "$(cat <<PROMPT
Continuing a /delegate run from a prior session.

TASK:
  ${task}

PROJECT:
  ${project}

RUN-ID:
  ${run_id}

PROJECT VERIFICATION:
  ${project_verification}

CHUNK STATUS:
${chunk_lines}

NEXT STEP:
  ${next_step}

CONTEXT:
  The intelligent-delegation skill is installed at ~/.claude/skills/intelligent-delegation.
  The run dir is at \$TMPDIR/delegate/${run_id}/ — manifest.json and state.tsv are there.
  To see full state: ~/.claude/skills/intelligent-delegation/scripts/delegate.sh state ${run_id}
  Invoke /delegate to continue orchestration.
PROMPT
)"
  printf '\n'
  printf '============================================================\n'
}

# ── abort ───────────────────────────────────────────────────────────────────

cmd_abort() {
  local run_id=${1:-} reason=${2:-orchestrator-initiated}
  [[ -n $run_id ]] || { print_error "abort requires <run-id>"; exit 1; }
  ensure_run "$run_id"
  local state; state=$(state_of "$run_id")
  local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local marker="$(run_dir "$run_id")/ABORTED"
  printf '%s\n%s\n' "$ts" "$reason" >"$marker"
  local count=0
  # collect running chunk ids first so cmd_set's awk pipeline doesn't compete for stdin
  local running_ids
  running_ids=$(awk -F'\t' '!/^#/ && $1 != "id" && $2 == "running" { print $1 }' "$state")
  # read line-by-line, not word-splitting — a chunk id may contain spaces, and
  # unquoted expansion here aborted the run only partially while still leaving
  # the ABORTED marker in place (found in team review, 2026-07-30)
  local cid
  while IFS= read -r cid; do
    [[ -n $cid ]] || continue
    cmd_set "$run_id" "$cid" "status=failed" "result=aborted:$reason"
    count=$((count+1))
  done <<< "$running_ids"
  printf 'ABORTED: %d chunks (reason=%s, marker=%s)\n' "$count" "$reason" "$marker"
}

# ── clean ────────────────────────────────────────────────────────────────────

cmd_clean() {
  local run_id=$1
  ensure_run "$run_id"
  rm -rf "$(run_dir "$run_id")"
  printf 'CLEANED: %s\n' "$run_id"
}

# ── main ─────────────────────────────────────────────────────────────────────

main() {
  require_command jq
  (($# == 0)) && { usage; exit 1; }
  local sub=$1; shift
  case "$sub" in
    init)            cmd_init "$@" ;;
    write-manifest)  cmd_write_manifest "$@" ;;
    validate)        cmd_validate "$@" ;;
    preflight)       cmd_preflight "$@" ;;
    prepare)         cmd_prepare "$@" ;;
    set)             cmd_set "$@" ;;
    get)             cmd_get "$@" ;;
    state)           cmd_state "$@" ;;
    workspace)       cmd_workspace "$@" ;;
    pending)         cmd_pending "$@" ;;
    resume)          cmd_resume "$@" ;;
    diff)            cmd_diff "$@" ;;
    audit)           cmd_audit "$@" ;;
    apply)           cmd_apply "$@" ;;
    qa)              cmd_qa "$@" ;;
    codex)           cmd_codex "$@" ;;
    autodetect)      cmd_autodetect "$@" ;;
    summary)         cmd_summary "$@" ;;
    watch)           cmd_watch "$@" ;;
    liveness)        cmd_liveness "$@" ;;
    handoff)         cmd_handoff "$@" ;;
    abort)           cmd_abort "$@" ;;
    clean)           cmd_clean "$@" ;;
    last)            cmd_last ;;
    -h|--help|help)  usage ;;
    *) print_error "unknown sub-command: $sub"; usage; exit 1 ;;
  esac
}

main "$@"

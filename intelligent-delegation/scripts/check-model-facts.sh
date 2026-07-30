#!/usr/bin/env bash
# check-model-facts.sh — enforce the Model Facts invariant.
#
# SKILL.md declares one dated block ("## Model Facts") as the ONLY home for any
# figure that ages: benchmark scores, prices, measured regressions, context
# windows, cutoffs. A figure restated anywhere else goes stale silently and
# mis-routes at the moment of choice — which is exactly how the 2026-07-27
# Opus 5 rewrite left a stale Terminal-Bench number in a routing table.
#
# A rule that lives only in prose is decoration. This is the enforcement.
#
# Usage:  scripts/check-model-facts.sh [skill-dir]
# Exit:   0 clean · 1 violations found · 2 the Model Facts block is missing
#
# What counts as an ageing figure (deliberately NARROW — a noisy check is a
# check nobody runs, so context-budget thresholds like ">30% context" and
# "75% full" are policy numbers, not model facts, and are not flagged):
#   · a price pair            5/25, 10/50, 2.50/15   (near "MTok")
#   · a points-delta          -8.6pp, +7.4pp
#   · a fractional percentage 43.3%, 85.77%, 96–97%
#   · a head-to-head score    "61 v 60", "59 vs 60"
#   · a named benchmark with a number on the same line

set -euo pipefail

DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SKILL="$DIR/SKILL.md"

[[ -f $SKILL ]] || { printf 'ERROR: no SKILL.md at %s\n' "$DIR" >&2; exit 2; }

# Resolve the Model Facts block bounds so its own figures are exempt.
start=$(grep -n '^## Model Facts' "$SKILL" | head -1 | cut -d: -f1 || true)
if [[ -z ${start:-} ]]; then
  printf 'ERROR: no "## Model Facts" section in SKILL.md — the invariant has no home.\n' >&2
  exit 2
fi
end=$(awk -v s="$start" 'NR > s && /^## / { print NR; exit }' "$SKILL")
[[ -n ${end:-} ]] || end=$(wc -l < "$SKILL")

# A benchmark NAME used as a lane label ("SWE-bench-Pro-shaped repo judgment")
# is fine — it routes without asserting a value. It is only a violation when a
# SCORE rides along with it. Hence: name-plus-digit, not name alone.
BENCH='SWE-bench|Terminal-Bench|ARC-AGI|Frontier-Bench|GDPval|OSWorld|AA (Intelligence |Coding Agent )?[Ii]ndex|CodeRabbit'
SCORE='[0-9]+\.[0-9]+ *%|[+-]?[0-9]+(\.[0-9]+)? *pp\b|MTok|\b[0-9]{2} +vs?\.? +[0-9]{2}\b|~?[0-9]+(\.[0-9]+)?[–-][0-9]+(\.[0-9]+)? *%'

violations=0

scan() { # scan <file> <label> [skip-from] [skip-to]
  local file=$1 label=$2 sfrom=${3:-0} sto=${4:-0} n line body
  while IFS= read -r line; do
    n=${line%%:*}
    body=${line#*:}
    if (( sfrom && n >= sfrom && n <= sto )); then continue; fi
    # context-budget thresholds (">30% context", "30-60% context used") are
    # policy numbers the skill owns, not model facts that age underneath it
    if printf '%s' "$body" | grep -qiE 'context'; then continue; fi
    # a benchmark name only offends when it carries a number
    if printf '%s' "$body" | grep -qE "$SCORE"; then
      :
    elif printf '%s' "$body" | grep -qE "$BENCH" && printf '%s' "$body" | grep -qE '[0-9]+(\.[0-9]+)? *%'; then
      :
    else
      continue
    fi
    printf '  %s:%s\n' "$label" "$line"
    violations=$((violations + 1))
  done < <(grep -nE "$SCORE|$BENCH" "$file" 2>/dev/null || true)
}

printf 'Model Facts invariant — %s\n' "$DIR"
printf 'Exempt block: SKILL.md lines %s-%s\n\n' "$start" "$end"

scan "$SKILL" "SKILL.md" "$start" "$end"
for f in "$DIR"/references/*.md; do
  [[ -e $f ]] || continue
  scan "$f" "references/$(basename "$f")"
done

if (( violations > 0 )); then
  printf '\nFAIL: %d ageing figure(s) outside the Model Facts block.\n' "$violations"
  printf 'Delete them and reference the block by name — do NOT update them in place.\n'
  exit 1
fi
printf 'OK: every ageing figure lives in the Model Facts block.\n'

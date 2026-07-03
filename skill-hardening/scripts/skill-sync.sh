#!/usr/bin/env bash
# skill-sync — drift check between live skills and their declared sync homes.
#
# Reads each live SKILL.md's sync-home footer (any line containing "Sync home:",
# "sanitized twin:", or "Canonical: ~/code/..."), resolves the first ~/code/... path,
# and reports: OK (identical), DRIFT (differs), SANITIZED (differs by design — review),
# MISSING (declared twin absent), LOCAL-ONLY (footer says no twin), or NO-FOOTER.
# Also shows the twin repo's git state when available.
#
# Usage: skill-sync.sh [skills-dir]   (default: ~/.claude/skills)

SKILLS_DIR="${1:-$HOME/.claude/skills}"
drift=0

for f in "$SKILLS_DIR"/*/SKILL.md; do
  [ -f "$f" ] || continue
  name=$(basename "$(dirname "$f")")
  line=$(grep -m1 -E "Sync home:|sanitized twin:|Canonical: ~/code" "$f")

  if [ -z "$line" ]; then
    printf '%-45s NO-FOOTER\n' "$name"
    continue
  fi
  if echo "$line" | grep -qiE "no public twin|none|local only|local-only|private only"; then
    if ! echo "$line" | grep -q '~/code/'; then
      printf '%-45s LOCAL-ONLY\n' "$name"
      continue
    fi
  fi

  tw=$(echo "$line" | grep -oE '~/code/[A-Za-z0-9._/-]+' | head -1)
  if [ -z "$tw" ]; then
    printf '%-45s LOCAL-ONLY\n' "$name"
    continue
  fi
  twin="${tw/#\~/$HOME}"

  # twin path may point at the skill dir or at a monorepo containing <name>/
  target=""
  for cand in "$twin/SKILL.md" "$twin/$name/SKILL.md"; do
    [ -f "$cand" ] && { target="$cand"; break; }
  done
  if [ -z "$target" ]; then
    printf '%-45s MISSING twin (%s)\n' "$name" "$tw"
    drift=1
    continue
  fi

  # git state of the twin's repo (walk up to the repo root)
  repo_dir=$(cd "$(dirname "$target")" && git rev-parse --show-toplevel 2>/dev/null)
  gitstate=""
  if [ -n "$repo_dir" ]; then
    dirty=$(git -C "$repo_dir" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    sync=$(git -C "$repo_dir" status -sb 2>/dev/null | head -1 | grep -oE '\[.*\]')
    gitstate=" [git: ${dirty} dirty${sync:+ $sync}]"
  fi

  if diff -q "$f" "$target" >/dev/null 2>&1; then
    printf '%-45s OK%s\n' "$name" "$gitstate"
  elif echo "$line" | grep -qi "sanitiz"; then
    printf '%-45s SANITIZED — diff expected, review manually%s\n' "$name" "$gitstate"
  else
    printf '%-45s DRIFT vs %s%s\n' "$name" "$tw" "$gitstate"
    drift=1
  fi
done

exit $drift

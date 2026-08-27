#!/usr/bin/env bash
# disk-sweep.sh — scan | sweep
#   scan  : full disk inventory, no mutations. Prints the Tier 1/2/3 report.
#   sweep : execute Tier 1 (regenerable caches + dead scratchpads) with liveness
#           gates. Never touches Tier 2/3. Safe to run from automation.
# Part of the disk-cleanup skill; protocol and gates documented in ../SKILL.md.
set -u
MODE="${1:-scan}"
DATA_VOL="/System/Volumes/Data"
SCRATCH_ROOT="/private/tmp/claude-$(id -u)"

free_line() { df -h "$DATA_VOL" | tail -1 | awk '{print "disk: "$3" used / "$4" free ("$5")"}'; }

scan() {
  echo "=== disk-sweep scan $(date '+%Y-%m-%d %H:%M') ==="
  free_line
  sysctl vm.swapusage 2>/dev/null
  echo "--- Tier 1 (regenerable) ---"
  du -sh ~/.npm ~/.cache ~/Library/Caches 2>/dev/null
  find ~/code -maxdepth 4 -type d -name .build -path '*macos*' -prune -exec du -sh {} \; 2>/dev/null
  [ -d "$SCRATCH_ROOT" ] && du -sh "$SCRATCH_ROOT" 2>/dev/null
  echo "--- Tier 2 (confirm first) ---"
  du -sh ~/Library/"Application Support"/Claude/vm_bundles 2>/dev/null || echo "vm_bundles: absent"
  find ~/code -maxdepth 3 -type d -path '*/.claude/worktrees/*' -prune -exec du -sh {} \; 2>/dev/null
  echo "--- repos by size + staleness ---"
  for d in ~/code/*/; do
    [ -d "$d/.git" ] || continue
    sz=$(du -sm "$d" 2>/dev/null | cut -f1)
    last=$(git -C "$d" log -1 --format=%cs 2>/dev/null)
    dirty=$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    unpushed=$(git -C "$d" log --branches --not --remotes --oneline 2>/dev/null | wc -l | tr -d ' ')
    echo "${sz}M $(basename "$d") | last: $last | dirty: $dirty | unpushed: $unpushed"
  done | sort -rn
  echo "--- Tier 3 (history) ---"
  du -sh ~/.claude/projects ~/Library/"Application Support"/Claude/claude-code-sessions \
        ~/Library/"Application Support"/Claude/local-agent-mode-sessions 2>/dev/null
  echo "--- orphan check ---"
  ps aux | grep -E 'next-server|postcss\.js|\btsc -p\b' | grep -v grep | awk '{print $2, $9, $11, $12}'
  echo "=== scan done ==="
}

sweep() {
  echo "=== disk-sweep sweep $(date '+%Y-%m-%d %H:%M') ==="
  echo "before: $(free_line)"

  # Gate: no active package installs or swift builds.
  if ps aux | grep -E 'swift-build|xcodebuild|npm (install|ci)\b' | grep -qv grep; then
    echo "ABORT: active build/install detected — rerun when idle."
    exit 1
  fi

  npm cache clean --force >/dev/null 2>&1 && echo "npm cache cleaned"
  for c in codex-runtimes uv puppeteer prisma pre-commit; do
    [ -d "$HOME/.cache/$c" ] && rm -rf "$HOME/.cache/$c" && echo "purged ~/.cache/$c"
  done
  command -v brew >/dev/null && brew cleanup --prune=all -s >/dev/null 2>&1
  for c in Homebrew ms-playwright com.openai.codex pip org.swift.swiftpm; do
    [ -d "$HOME/Library/Caches/$c" ] && rm -rf "$HOME/Library/Caches/$c" && echo "purged Caches/$c"
  done
  find "$HOME/Library/Caches" -maxdepth 1 -name '*.ShipIt' -exec rm -rf {} \; 2>/dev/null

  # Dead scratchpads: UUID session dirs only; no file touched in 2 days AND no open handles.
  # Current session (if any) is protected by the freshness gate; zombie log-writers are not
  # killed here — automation only skips them (kill decisions stay human/session-driven).
  if [ -d "$SCRATCH_ROOT" ]; then
    find "$SCRATCH_ROOT" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | while read -r d; do
      base=$(basename "$d")
      echo "$base" | grep -qE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || continue
      [ -n "$(find "$d" -mtime -2 -print -quit 2>/dev/null)" ] && continue
      [ -n "$(lsof +D "$d" 2>/dev/null | head -1)" ] && continue
      rm -rf "$d" && echo "purged scratchpad $base"
    done
  fi

  echo "after:  $(free_line)"
  echo "=== sweep done ==="
}

case "$MODE" in
  scan) scan ;;
  sweep) sweep ;;
  *) echo "usage: disk-sweep.sh [scan|sweep]"; exit 2 ;;
esac

---
name: disk-cleanup
description: >
  Reclaim disk space on a Mac running heavy Claude Code workloads: scan, classify by
  risk, verify nothing live is using a target, purge staged, prove the result with df.
  Trigger on "disk is full", "clean up storage", "free up space", "disk cleanup",
  "/disk-cleanup", "storage almost full", or any macOS low-disk warning. Also covers the
  follow-on RAM/swap health check. Do NOT use for cleaning a single repo's build
  artifacts mid-task (just delete them), or for pruning agent memory files.
---

# Disk Cleanup

**The protocol: scan → classify by risk → check live consumers → purge in stages →
prove with `df`.** Nothing is deleted before its risk tier is known and its liveness
checked. Nothing above Tier 1 is deleted without the user's explicit go.

Run `scripts/disk-sweep.sh scan` first — it produces the full inventory in one shot.
`scripts/disk-sweep.sh sweep` executes Tier 1 only, with the liveness gates built in
(suitable for a weekly launchd/cron job).

## Ground truth first

- **Free space** = `df -h /System/Volumes/Data`. NEVER `df /` — that's the sealed
  system snapshot and reads wildly wrong (12GB used vs a real 180GB, observed in practice).
- **A full disk breaks the scan itself**: `du`/`sort` write temp files and fail with
  "no space left on device". If that happens, purge a known Tier 1 target immediately
  (npm cache is the fastest safe win), then resume scanning.
- Swap health while you're here: `sysctl vm.swapusage`. Swap used beyond physical RAM
  means the real problem is memory residency, not disk — see "Swap follow-on" below.

## Risk tiers

| Tier | Targets | Gate |
|---|---|---|
| **1 — regenerable, purge on request** | `~/.npm` (`npm cache clean --force`), `~/.cache/*` (tool runtimes, uv, puppeteer, prisma, pre-commit), idle `~/Library/Caches/*` (Homebrew + `brew cleanup --prune=all`, playwright browsers, `*.ShipIt` updater blobs, pip, swiftpm), Swift/Xcode `.build` dirs, dead-session scratchpads under `/private/tmp/claude-<uid>` | Liveness check only |
| **2 — recoverable elsewhere, confirm first** | Claude agent `vm_bundles` (re-downloaded on demand), stale local repos (see repo gate), stale-repo `node_modules`, stale `.claude/worktrees` | Explicit yes per category |
| **3 — history, confirm + protect** | `~/.claude/projects` transcripts, desktop-app session stores | Pinned-session protection (below); never touch app session stores while Claude Desktop runs |
| **Never** | Caches of currently-running browsers/apps (open handles), anything with unpushed commits or unrescued dirty files, agent memory dirs, the current session's own scratchpad/transcript | — |

## Liveness gates (the step that makes this safe)

1. **Open handles**: `lsof +D <target>` — empty means safe. One open `_logs` file in
   `~/.npm` is fine (npm cache clean doesn't touch logs).
2. **Active builds**: `ps aux | grep -E 'swift-build|xcodebuild|npm (install|ci)'`.
3. **Peer sessions**: list running Claude sessions, then map each process's cwd via
   `lsof -a -p <pid> -d cwd`. No live session may sit inside a deletion target.
4. **Zombie-freshness trap**: a scratchpad can look "recently modified" solely because an
   orphaned dev server is still writing logs into it (observed: three next-servers from
   one dead session pinning 4.4GB). Detect orphans by a **log/cwd path pointing into a
   dead session's scratchpad**; kill the process tree (the `next-server` parent, not just
   its workers), then delete. Kill-verify: `ps -p <pid>` after, not just `kill`'s exit.

## Category-specific gates

- **Repo deletion** (Tier 2): all three or no delete — `git status --porcelain` empty,
  `git log --branches --not --remotes` empty, `git ls-remote origin` succeeds. A repo
  failing any check gets its `node_modules` stripped instead, never the repo.
- **Worktrees**: `git worktree list` first; inspect dirty/untracked files — rescue unique
  artifacts into the main repo before `git worktree remove --force` + `git worktree
  prune`. Commits on worktree branches survive removal (shared `.git`); only
  uncommitted/untracked content is at risk.
- **Transcripts** (Tier 3): find protected session UUIDs by grepping their titles in the
  desktop app's session store (`~/Library/Application Support/Claude/claude-code-sessions/`),
  then prune `*.jsonl -mtime +7` excluding those UUIDs and the current session's. Verify
  survivors after. Automation should use `+60` days — a paused-but-pinned session can sit
  untouched for weeks.
- **Scratchpads**: only UUID-named session dirs at depth 2 qualify — a bare glob also
  catches shared dirs like `bundled-skills/` (observed). Double gate: no file modified in
  2 days AND no open handles. Current session always excluded.

## Verification (no claim without this)

- Freed space: `df -h /System/Volumes/Data` before and after, reported as numbers
  ("1.3GB → 39GB free"), never as "cleaned up".
- Protected sessions: after a transcript prune, `find` the protected UUIDs and report the
  count found.
- Kills: `ps -p` on every killed pid.

## Escalation

- Purge done but disk still tight → the remaining levers are Tier 3 app session stores
  (quit Claude Desktop first) and a storage audit outside the Claude footprint.
- Disk fine but machine slow → swap follow-on: check `vm.swapusage`; the fixes are closing
  idle Claude sessions (each is a resident process), killing orphaned dev servers, running
  one browser instead of two, and a restart to drain swap. Physical RAM is the hardware
  ceiling — say so rather than promising software fixes.

## Sync home

Sync home: this repo (github.com/justinwilliames/skills) is a sanitized distribution copy;
the canonical copy lives in the author's private live library.

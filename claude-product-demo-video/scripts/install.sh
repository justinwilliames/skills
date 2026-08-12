#!/usr/bin/env bash
# Provision everything claude-product-demo-video needs.
#
# Idempotent: re-running it on a healthy machine installs nothing and exits 0.
# System packages are never installed silently — the script prints exactly what
# it intends to run and waits for a yes, unless --yes is passed.
#
#   bash scripts/install.sh              interactive
#   bash scripts/install.sh --yes        no prompts (CI)
#   bash scripts/install.sh --check      report only, install nothing

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSUME_YES=0
CHECK_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --check)  CHECK_ONLY=1 ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
ok()   { printf '  %sok%s    %s\n' "$GRN" "$OFF" "$1"; }
miss() { printf '  %smiss%s  %s\n' "$RED" "$OFF" "$1"; }
warn() { printf '  %swarn%s  %s\n' "$YEL" "$OFF" "$1"; }
note() { printf '        %s%s%s\n' "$DIM" "$1" "$OFF"; }

have() { command -v "$1" >/dev/null 2>&1; }

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  printf '\n  about to run: %s\n  proceed? [y/N] ' "$1"
  read -r reply </dev/tty || return 1
  case "$reply" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# ---- platform + package manager -------------------------------------------

OS="$(uname -s)"
PM=""
PM_INSTALL=""

case "$OS" in
  Darwin)
    if have brew; then PM="brew"; PM_INSTALL="brew install"; fi
    ;;
  Linux)
    if   have apt-get; then PM="apt";    PM_INSTALL="sudo apt-get install -y"
    elif have dnf;     then PM="dnf";    PM_INSTALL="sudo dnf install -y"
    elif have pacman;  then PM="pacman"; PM_INSTALL="sudo pacman -S --noconfirm"
    elif have apk;     then PM="apk";    PM_INSTALL="sudo apk add"
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    if   have winget; then PM="winget"; PM_INSTALL="winget install -e --id"
    elif have choco;  then PM="choco";  PM_INSTALL="choco install -y"
    fi
    ;;
esac

# Package names differ per manager. Empty means "not available here".
pkg_for() {
  local tool="$1"
  case "$PM:$tool" in
    brew:ffmpeg)   echo "ffmpeg" ;;
    brew:gh)       echo "gh" ;;
    apt:ffmpeg)    echo "ffmpeg" ;;
    apt:gh)        echo "gh" ;;
    dnf:ffmpeg)    echo "ffmpeg" ;;
    dnf:gh)        echo "gh" ;;
    pacman:ffmpeg) echo "ffmpeg" ;;
    pacman:gh)     echo "github-cli" ;;
    apk:ffmpeg)    echo "ffmpeg" ;;
    apk:gh)        echo "github-cli" ;;
    winget:ffmpeg) echo "Gyan.FFmpeg" ;;
    winget:gh)     echo "GitHub.cli" ;;
    choco:ffmpeg)  echo "ffmpeg" ;;
    choco:gh)      echo "gh" ;;
    *) echo "" ;;
  esac
}

MISSING_HARD=0

install_tool() {
  local tool="$1" hard="$2" why="$3"
  if have "$tool"; then
    ok "$tool $( "$tool" --version 2>/dev/null | head -1 | cut -c1-48 )"
    return 0
  fi

  if [ "$hard" = "hard" ]; then miss "$tool — $why"; else warn "$tool — $why"; fi

  [ "$CHECK_ONLY" -eq 1 ] && { [ "$hard" = "hard" ] && MISSING_HARD=1; return 0; }

  local pkg; pkg="$(pkg_for "$tool")"
  if [ -z "$PM" ]; then
    note "no supported package manager found — install $tool manually"
    [ "$OS" = "Darwin" ] && note "install Homebrew first: https://brew.sh"
    [ "$hard" = "hard" ] && MISSING_HARD=1
    return 0
  fi
  if [ -z "$pkg" ]; then
    note "no known $PM package for $tool — install it manually"
    [ "$hard" = "hard" ] && MISSING_HARD=1
    return 0
  fi

  if confirm "$PM_INSTALL $pkg"; then
    # shellcheck disable=SC2086
    $PM_INSTALL $pkg || { note "install failed"; [ "$hard" = "hard" ] && MISSING_HARD=1; return 0; }
    have "$tool" && ok "$tool installed"
  else
    note "skipped — $tool stays missing"
    [ "$hard" = "hard" ] && MISSING_HARD=1
  fi
}

# ---- run -------------------------------------------------------------------

printf '\nclaude-product-demo-video — provisioning\n'
printf '%s%s / %s%s\n\n' "$DIM" "$OS" "${PM:-no package manager}" "$OFF"

printf 'runtime\n'
if have node; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -ge 20 ]; then
    ok "node $(node -v)"
  else
    miss "node $(node -v) — needs >= 20"
    note "upgrade via nvm (https://github.com/nvm-sh/nvm) or your package manager"
    MISSING_HARD=1
  fi
else
  miss "node — needs >= 20"
  note "install from https://nodejs.org or via nvm"
  MISSING_HARD=1
fi

printf '\nvideo toolchain\n'
install_tool ffmpeg hard "renders and mixes every video"
# ffprobe ships with ffmpeg on every manager above, but verify it landed.
if have ffprobe; then ok "ffprobe"; else
  miss "ffprobe — ships with ffmpeg; your ffmpeg build is incomplete"
  MISSING_HARD=1
fi

printf '\nbrowser\n'
if [ "$CHECK_ONLY" -eq 1 ]; then
  if [ -d "$SKILL_DIR/node_modules/playwright" ]; then ok "playwright package"; else miss "playwright package"; MISSING_HARD=1; fi
else
  if [ ! -d "$SKILL_DIR/node_modules/playwright" ]; then
    printf '  installing npm dependencies\n'
    ( cd "$SKILL_DIR" && npm install --no-audit --no-fund --loglevel=error )
  fi
  ok "playwright package"
  printf '  ensuring chromium is present\n'
  ( cd "$SKILL_DIR" && npx --no-install playwright install chromium >/dev/null 2>&1 ) \
    && ok "chromium" \
    || { miss "chromium download failed"; note "retry: cd $SKILL_DIR && npx playwright install chromium"; MISSING_HARD=1; }
fi

printf '\noptional\n'
install_tool gh soft "only needed to read a GitHub repo in the discover stage"
if have gh; then
  if gh auth status >/dev/null 2>&1; then ok "gh authenticated"; else
    warn "gh present but not authenticated"
    note "run: gh auth login    (discover cannot read repos until you do)"
  fi
fi

if [ "$OS" = "Darwin" ]; then
  ok "say (macOS built-in narration — zero cost, no API key)"
else
  warn "no built-in TTS on this platform"
  note "set ELEVENLABS_API_KEY or OPENAI_API_KEY for narration, or use voice provider 'none' for captions only"
fi

printf '\n'
if [ "$MISSING_HARD" -eq 1 ]; then
  printf '%sincomplete%s — the items marked miss must be resolved before the pipeline can render.\n\n' "$RED" "$OFF"
  exit 1
fi
printf '%sready%s — run: node scripts/pdv.mjs doctor\n\n' "$GRN" "$OFF"

---
name: claude-product-demo-video
description: Turn a shipped code change into a finished, on-brand product demo or release video — 1080p landscape MP4 with narration, music, captions and motion. Trigger on "make a video for this feature", "product demo video", "release video", "announce this integration", "feature launch video", "video changelog", "record a demo of X", "turn this PR into a video", or any request to show a product capability as video rather than write about it. Reads the GitHub repository to learn what actually shipped, reconstructs the product surface as a local interactive HTML demo, drives Chrome through it and records real browser footage, then scores, narrates and renders it. Asks for brand assets — logos, palette, fonts, guidelines, existing imagery — before generating anything. Do NOT use for editing existing footage the user already has, for social clips with no product surface, or for writing release notes as text (that is a writing task).
---

# Product demo video

> Paths below use `{base}` as shorthand for this skill's base directory.

Most product teams never ship a release video, and the reason is almost never the
editing. It is that making one requires a working environment, a person who knows
the feature, a designer who owns the brand, and somebody with Premiere open — four
calendars that do not align for a Tuesday integration launch.

This skill removes all four dependencies. It reads what shipped from the
repository, builds the product surface it needs, records it, and renders a
finished 1080p video with narration, licensed music, captions and motion.

## What it produces

A landscape 1920×1080 H.264 MP4, 45–90 seconds, with:

- narration written from repository evidence and spoken by a TTS voice
- real browser footage of an interactive product surface, with an eased cursor
- branded title, feature, stat and outro cards rendered from your design tokens
- transitions, Ken Burns motion and auto-zoom onto the element being described
- royalty-free background music, ducked under the voiceover
- burned-in captions styled from your brand, plus an `.srt` sidecar
- an `ATTRIBUTION.md` naming every licensed asset used

## What it will not do

- **Invent capabilities.** Every narrated sentence traces to a citation in the
  feature brief. A thin evidence base produces a shorter video, never a padded one.
- **Pass a reconstruction off as production.** When product footage comes from a
  generated demo rather than a real environment, the outro carries a demo-footage
  notice by default. Removing it is a deliberate choice the operator makes.
- **Ship unlicensed audio.** Music comes from a verified CC0/CC-BY catalogue and
  attribution is written on every run.

## Step 1 — Brand intake, always first

**Never generate a frame before the brand contract exists.** Ask for these, in
this order, and say plainly which ones you can proceed without:

| Ask | Needed? | Used for |
|---|---|---|
| Logo files — primary, reversed, icon-only | **Yes** | Title card, outro, watermark, demo sidebar |
| Brand colours — primary, background, text, accent | **Yes** | Every surface, CTA, caption bar, focus ring |
| Brand fonts as local files (woff2/ttf) + licence | Strongly preferred | All on-screen type. The renderer is offline; a font it cannot load falls back and the video stops looking like you |
| Brand guidelines doc or brand-kit URL | Helpful | Fills the rest of the contract and is recorded for provenance |
| Existing product imagery, screenshots, illustrations | Optional | `asset` scenes, backgrounds |
| A pre-made intro/outro sting | Optional | Concatenated verbatim |
| Voice and tone rules, banned words, forced spellings | Optional | Narration. Product names with unusual casing get mispronounced without this |
| Existing licensed music library | Optional | Bypasses the catalogue entirely |

Run the interactive intake, which writes and validates the contract:

```bash
node {base}/scripts/pdv.mjs brand --out brand.json
```

Anything unanswered falls back to a neutral default **and is reported** — the
skill never silently invents a brand. Cache `brand.json` per project; the intake
is a once-per-product cost, not a once-per-video cost.

A complete worked example lives at `{base}/templates/brand.example.json`, and the
full field reference is `{base}/schemas/brand.schema.json`.

## Step 2 — Discover what actually shipped

The **GitHub repository is the source of truth**. A local checkout is optional.

```bash
node {base}/scripts/pdv.mjs discover \
  --repo acme/webapp \
  --feature "scheduled exports" \
  --out brief.json
```

Discovery reads releases, the CHANGELOG, merged pull requests and the source
files behind them via the `gh` CLI, and writes a `feature-brief.json` in which
**every capability carries a citation**. Claims that cannot be cited land in an
`excluded` list with a reason rather than being softened into vague marketing.

Read the brief before continuing. If `feature.status` says `beta` and you
believed it was GA, the repository is right and you are wrong — check before
narrating otherwise.

## Step 3 — Storyboard

```bash
node {base}/scripts/pdv.mjs storyboard --brief brief.json --brand brand.json --out storyboard.json
```

Produces the scene graph: title → context → two to four capability scenes →
proof → outro, with narration, motion, transitions and a demo spec per capability
scene. **Read the narration out loud before you render.** It is far cheaper to
fix a sentence here than after voice, capture and render have all run.

## Step 4 — Choose how each product scene is captured

Four ways to get product footage. They compose freely inside one storyboard, and
they are ranked by fidelity:

| kind | Fidelity | Needs | Use when |
|---|---|---|---|
| `url` | Real product | A reachable environment + credentials | You have staging or a demo tenant |
| `storybook` | Real components | A running Storybook | The repo has one — no auth, no backend |
| `demo` | Reconstruction | Nothing | **The default.** Anything else is unavailable |
| `asset` | Supplied | Files from the user | A designer already made the art |

`demo` is what makes this work on a Tuesday. It generates an interactive HTML
reconstruction of the product surface from repo facts — real routes, real field
labels, real button copy — serves it on localhost, and drives Chrome through a
scripted flow with a synthetic eased cursor while recording frame by frame.

Prefer `url` or `storybook` whenever they are actually available. `demo` is the
path that always works, not the best one.

## Step 5 — Build

```bash
node {base}/scripts/pdv.mjs build --storyboard storyboard.json --install
```

Runs demo → capture → voice → music → render → qa, skipping any stage whose
output is newer than its inputs. `--install` provisions missing tooling.

Every stage can be re-run alone. Change one line of narration and re-run `voice`
and `render`; nothing else has to happen again.

## Step 6 — The QA gate

`qa` is a **hard gate, not a report**. It fails on wrong resolution, a missing or
silent audio stream, a fully black frame, a duration that drifts more than 5%
from the storyboard, a CC-BY track with no attribution file, or captions below
the contrast floor.

```
QA: PASS
```

That literal line is the only acceptable evidence that a video is finished.
Paste it — do not paraphrase it. If the gate fails, fix the cause; never
re-render with the gate skipped.

Then **watch the video**. The gate proves the file is well-formed, not that the
edit is any good. Check: does the zoom land on the thing being described, does
the music sit under the voice or fight it, does any caption cover the UI it is
describing, does the last frame hold long enough to read.

## Narration

| Provider | Cost | Licence posture | Use it when |
|---|---|---|---|
| **`kokoro`** | Free, local | Apache 2.0, model and output unrestricted | **The default.** Kokoro-82M runs on CPU faster than realtime, needs no key, and 28 graded voices ship with it |
| `say` | Free, local | macOS voices are **not** cleared for commercial redistribution everywhere | Review cuts and internal videos |
| `elevenlabs` / `openai` | Per character | Check the provider's terms | You want a specific hosted voice |
| `none` | — | — | Captions only |

Kokoro is optional at install time because it pulls `onnxruntime`, which is
large. `scripts/install.sh` offers it; the model (~80MB) downloads on first
synthesis and is cached afterwards.

Voices are graded by the model's own authors. `af_heart` is the only A-grade
voice (en-us, female); `bf_emma` is the best en-gb female. Pick with
`audio.voice.voiceId`.

```jsonc
"audio": { "voice": { "provider": "kokoro", "voiceId": "bf_emma", "rateWpm": 160 } }
```

A hosted provider's key is read from `$ELEVENLABS_API_KEY` / `$OPENAI_API_KEY`,
or from `~/.elevenlabs_key` / `~/.openai_key` — so a credential never has to be
pasted into whatever is driving the build.

## Installation

```bash
bash {base}/scripts/install.sh
```

Idempotent. Installs Node dependencies and Chromium, and offers to install
ffmpeg and the `gh` CLI through the platform package manager — printing each
command and waiting for a yes. `--check` reports without installing. Hard
requirements are Node ≥ 20, ffmpeg, ffprobe and Chromium; `gh` is needed only for
discovery, and narration falls back to the macOS built-in voice, then to captions
only.

## Failure modes worth knowing

| Symptom | Cause | Fix |
|---|---|---|
| Type looks soft or fuzzy | Captured at 1× and upscaled | Capture runs at `deviceScaleFactor: 2`; check the scene did not override it |
| Banding across a gradient card | H.264 on large flat fills | The scene templates carry a 2–3% noise layer for exactly this; do not remove it |
| Zoom lurches | Linear easing, or too large a scale delta | `easeInOutCubic`, and `kenBurnsIntensity` at or under 0.09 — the schema's ceiling, above which the browser-chrome frame loses its margins |
| Music drowns the voice | Ducking off, or music gain too high | `audio.music.duck: true`, gain around −18 dB |
| Narration clipped mid-word | A scene given a fixed `durationMs` shorter than its VO | Leave `durationMs` unset on narrated scenes and let the measured VO drive timing |
| Video ends abruptly | No hold on the outro | Give the outro a fixed duration of at least 3 s |
| Fonts fall back | Font files not local, or a CDN URL | The renderer is offline by design; supply local woff2/ttf paths |

## Files

| Path | What it is |
|---|---|
| `scripts/pdv.mjs` | CLI — one subcommand per stage |
| `scripts/install.sh` | Idempotent provisioner |
| `scripts/lib/*.mjs` | One module per stage |
| `schemas/*.schema.json` | The three contracts: brand, feature brief, storyboard |
| `templates/scenes/*.html` | Brand-driven scene cards, rendered at 1920×1080 |
| `templates/brand.example.json` | A complete worked brand contract |
| `assets/music/CATALOGUE.json` | Verified royalty-free catalogue — URLs only, no committed audio |
| `docs/ARCHITECTURE.md` | The pipeline in depth |

Licensed MIT, as part of this repository.

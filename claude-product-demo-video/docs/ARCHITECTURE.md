# Architecture

`product-release-video` turns a code change into a finished, on-brand product
video. It is a **deterministic pipeline**, not a monolithic model call: every
stage writes a file, every file has a schema, and any stage can be re-run
without repeating the ones before it.

```
  discover  ->  feature-brief.json
                      |
  brand     ->  brand.json            (interactive intake, cached per project)
                      |
  storyboard -> storyboard.json       (scenes, narration, motion, transitions)
                      |
  capture   ->  work/scenes/<id>.png|.webm      (Playwright, 1920x1080)
  voice     ->  work/vo/<id>.wav                (TTS provider)
  music     ->  work/music/<track>.mp3          (fetched CC0/CC-BY)
                      |
  render    ->  out/<slug>.mp4        (ffmpeg: motion, xfade, mix, captions)
                      |
  qa        ->  out/<slug>.qa.json    (hard gate — pass/fail)
```

Each stage is a module under `scripts/lib/` exporting one async function. The
CLI (`scripts/prv.mjs`) is a thin argument parser over those functions.

## Stage contracts

| Stage | Module | Input | Output |
|---|---|---|---|
| discover | `discover.mjs` | repo path, ref range, feature hint | `feature-brief.json` |
| brand | `brand.mjs` | interactive answers or `--from` dir | `brand.json` |
| storyboard | `storyboard.mjs` | brief + brand | `storyboard.json` |
| capture | `capture.mjs` | storyboard | `work/scenes/*` + `capture-manifest.json` |
| voice | `voice.mjs` | storyboard | `work/vo/*.wav` + durations |
| music | `music.mjs` | storyboard | `work/music/*` + `ATTRIBUTION.md` |
| render | `render.mjs` | all of the above | `out/<slug>.mp4` |
| qa | `qa.mjs` | rendered mp4 + storyboard | `out/<slug>.qa.json` |

`build` runs every stage in order, skipping any whose output is newer than its
inputs.

## Why the scene graph is HTML

Every non-product scene — titles, feature cards, stat callouts, step lists,
outros — is an **HTML template rendered by Playwright at 1920x1080**, styled
entirely from `brand.json`. That choice does three things at once:

1. **Brand fidelity.** Colours, fonts, radii and spacing come from the brand
   contract, so the video matches the product rather than approximating it.
2. **Text stays sharp.** Type is rendered by a browser at full resolution, never
   drawn by an image model and never scaled up from a smaller raster.
3. **No running app required.** A repo with no bootable local environment still
   produces a complete video; live product capture is an upgrade, not a
   prerequisite.

## Four capture kinds

`scene.capture.kind` selects how a scene's visual is obtained. They compose
freely inside one storyboard.

| kind | What it does | When to use |
|---|---|---|
| `html` | Renders `templates/scenes/<template>.html` with brand tokens + scene content | Titles, feature cards, stats, steps, outro |
| `demo` | **Builds an interactive HTML demo of the product surface, serves it on localhost, drives Chrome through a scripted flow and records it** | Default for product footage — no app boot, no auth, no seeded data |
| `storybook` | Navigates a running Storybook to `storyId` and captures the canvas | Real components from the real design system, when Storybook exists |
| `url` | Navigates a live/staging URL and replays scripted `steps` | Real end-to-end flows, when credentials are available |
| `asset` | Uses a supplied PNG/JPG/MP4 verbatim | Designer-provided art, existing recordings |

### `demo` is the default product-footage path

Most repositories cannot be booted from a cold checkout — they need secrets, a
database, a queue and a paid third-party sandbox. Waiting for that is what stops
release videos getting made. So the pipeline does not wait for it.

Instead, `demo` **generates a faithful, interactive HTML reconstruction of the
product surface** from facts read out of the repository — route names, field
labels, states, copy strings, component structure and the brand contract — writes
it to `work/demo/<app>/`, serves it on localhost, and drives Chrome through a
scripted flow with a synthetic eased cursor while recording.

The output is real browser footage of a real interactive page. It is honest
about what it is: a demo build, reconstructed from the repo, not a screen capture
of production. Where the real thing *can* be reached, `storybook` and `url`
outrank it and should be preferred — `demo` is the path that always works.

Frames are captured deterministically: the demo exposes a controllable timeline,
and the recorder steps it one frame at a time taking a screenshot per frame. That
yields exact 30fps at full resolution with no compositor drops and no video
codec mush on small type. Playwright's `recordVideo` is the fallback when a scene
depends on animation the harness cannot step.

### Where the source facts come from

Discovery reads the **GitHub repository directly** via the `gh` CLI — releases,
merged pull requests, CHANGELOG entries, and file contents at a ref. A local
checkout is used when one is present and current, but is never required. Point
the skill at `owner/name` and it works from anywhere.

## Motion model

Stills become motion through `zoompan`. Three motion types:

- **`none`** — no camera move. This is the right answer for every scene that
  animates its own elements, which is now all of `title`, `feature`, `steps`,
  `outro` and `showcase`: they are seekable timelines, and a slow push layered
  over choreography is the clearest tell of a cheap product video.
- **`kenburns`** — a slow continuous push or pull across the frame. It exists
  for genuine stills — an imported image or screenshot with nothing moving
  inside it. Do not put it over a seekable template.
- **`autozoom`** — a timed push into a named region, mirroring the way a viewer's
  eye moves to the element being described. The region is either an explicit
  `[x, y, w, h]` box or a CSS selector resolved during capture, so the zoom
  tracks the actual on-screen element rather than a guessed coordinate.

Motion is computed as keyframes in `motion.mjs` and emitted as an ffmpeg filter
string. Easing defaults to `easeInOutCubic`; linear zooms read as mechanical.

NOTE (open): `storyboard.mjs assemble()` still stamps `kenBurns(i, brand)` onto
every scene that did not get its own motion, which includes all four HTML
templates above. Until that default changes, a generated storyboard needs
`motion: { "type": "none" }` set by hand on its title/feature/steps/outro
scenes.

## Audio model

Three tracks are mixed:

1. **Voiceover** — per-scene WAV from the configured TTS provider. Scene
   duration is derived from VO length plus padding, so narration is never
   clipped mid-word by a fixed scene timer.
2. **Music** — one fetched track, looped or trimmed to total duration, with a
   fade in and out.
3. **Ducking** — `sidechaincompress` keys the music off the VO bus, so music
   drops under narration and recovers in the gaps. This is what separates a
   finished video from a slideshow with a song over it.

## Licensing posture

No audio binaries are committed to this repository. `assets/music/CATALOGUE.json`
holds a curated list of CC0 / CC-BY sources with direct URLs and licence terms;
tracks are fetched at build time into `work/music/` (git-ignored), and an
`ATTRIBUTION.md` naming every track, artist, source and licence is written into
the output folder on every run. CC-BY tracks fail the QA gate unless that
attribution file exists.

## Verification gate

`qa.mjs` is a hard gate, not a report. It fails the build on any of:

- resolution is not exactly the requested frame size
- container has no audio stream, or audio is silent
- mean luminance implies a fully black frame anywhere in the timeline
- duration deviates from the storyboard total by more than 5%
- a CC-BY track is used with no `ATTRIBUTION.md` present
- burned-in caption text falls below the configured contrast ratio

The gate prints `QA: PASS` or `QA: FAIL` with the failing checks named. Only the
literal pass line counts as evidence that a video is finished.

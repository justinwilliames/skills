---
name: linkedin-cover-builder
description: >
  Build a LinkedIn cover photo (the 1584x396 banner across the top of a profile or company
  page) from a swappable brand kit, so the same layout survives a change of employer.
  Trigger on "make a LinkedIn cover", "LinkedIn banner for my profile", "profile header
  image", "rebrand my LinkedIn cover", "update my banner for the new job", or any request
  for the wide image behind a LinkedIn profile. Produces a smooth aura field, a portrait
  bleeding off the right edge, and typography that clears the profile-picture circle, then
  gates the result against six measured defects before calling it ship-ready. Do NOT use
  for LinkedIn post images or in-feed marketing graphics (those are a different aspect
  ratio and a different design language), for generating or retouching the portrait itself,
  or for other platforms' header sizes.
---

# LinkedIn cover builder

## The protocol

1. **Get or write a brand kit.** Copy `brand-kits/example.json`, fill in every value from
   the company's real brand source — its published palette, its display font file, its logo
   asset. Never eyedrop a colour from a screenshot; find the token.
2. **Pick the portrait.** Waist-up or head-and-shoulders, subject already right-of-centre in
   the frame. The left of the photo dissolves into the field, so anything there is lost.
3. **Build.** `python3 scripts/build-cover.py <kit.json> --out <path-prefix>`
4. **Read the gate output, then look at the image.** Exit 0 and `PASS all gates` is the
   floor, not the verdict — no pixel statistic can see that a face is unflattering or that
   the headline is a lie.
5. **Upload the `-1584x396.jpg`.** The `@2x` file is for archives and other surfaces.

## What is fixed vs what is brand-injectable

The point of this skill is that the **layout is the constant** and the brand is the
variable. Moving companies should change the kit, not the design.

| Fixed (the house style) | Injectable (the kit) |
|---|---|
| 1584x396, text left-of-centre, portrait bleeding off the right | Palette, display font, logo or wordmark |
| Aura field: analytic light layers, smooth, feathered to a canvas token at every edge | The three aura hues + optional accent kiss |
| Portrait dissolves leftward through a five-stop alpha ramp — no card, no border, no shadow | Which photo, its crop anchor, its panel width |
| Film grain on the photograph only | Grain strength, grade on or off |
| Text block clears the profile-picture circle | Headline lines, subline, type sizes |

## The rules that produce the look

- **Grain belongs to photography, never to drawn surfaces.** Film grain is an artefact of
  emulsion. Sprayed across a rendered gradient it reads as JPEG noise or a cheap texture
  filter and it kills the glassy quality the aura exists to create. Gate G4 measures the
  drawn field's high-frequency residual and fails anything above 0.5.
- **An aura, not a linear gradient.** Overlapping elliptical light layers with a soft
  power falloff read as light in a space. A two-stop `linear-gradient` reads as a slide
  template. The cost is identical.
- **Every edge lands on a declared canvas token.** The cover sits against a page
  background; if the edges do not match it, the boundary shows as a seam. Gate G5.
- **The photo has no frame.** A rounded card with a drop shadow makes the cover look like a
  slide with a picture on it. Bleeding and dissolving makes the person part of the field.
- **Two headline lines, short.** Under ~22 characters each so nothing wraps. Three lines is
  the ceiling; at 396px tall, four collides with the subline.
- **One type colour.** Recolouring individual words to "emphasise" them is a banner-maker
  tell. If a word needs emphasis, the sentence is wrong.

## Named failure modes

| Failure mode | What it looks like | Gate / antidote |
|---|---|---|
| **Profile circle eats the copy** | The avatar covers the start of every line; the subline is unreadable on desktop | **G2 + G3.** `content_left` >= 408px. Measured: the circle spans cover-x 44→368 |
| **Chrome height trap** | A flat band of body colour across the bottom of the render | **G1.** Render at `H + 90` and crop; never `--force-device-scale-factor` |
| **Grain on everything** | The whole cover looks like a compressed JPEG or a "film filter" | **G4.** Grain applies to the photo layer only |
| **Seam at the edge** | A visible rectangle where the cover meets the page | **G5.** Feather every edge to `colors.canvas` |
| **Mobile crops the message** | Desktop reads fine; the phone shows half a headline | **G6** warns below 20% inset. Check on a phone before shipping |
| **Colour lifted from a screenshot** | Nearly-right brand colours that look off beside the real product | Read the brand's published tokens. Screenshots carry display profiles and compression |
| **Text baked into the portrait** | Garbled letterforms if the photo came from an image model | Type is composited as real text here. Never ask a generator to draw the headline |

## Verification

The build is not done when the file exists. It is done when the gates pass **and** you have
looked at the output.

```
PASS all gates
  <out>-1584x396.jpg
  <out>-3168x792@2x.jpg
```

Any `FAIL:` line exits non-zero and means the cover was written but is not ship-ready. The
gates are self-testing: set `content_left` to 300 in a kit and G2 and G3 should both fire.
An assertion nobody has watched fail is decoration — prove they work after any edit here.

Then check by eye, in this order: face framed and not clipped; headline legible against the
field at its lightest point; no seam at any edge; the whole thing reads as one image rather
than a photo pasted onto a background.

## Autonomy

Building, re-building and re-grading are free — iterate without asking. **Uploading to
LinkedIn is not**: it is a public, outward-facing change to someone's professional identity.
Hand over the file path and let the human upload it, unless they have explicitly asked you
to publish this specific image.

## Requirements

Python 3.9+ with `numpy` and `Pillow`, and Chrome or Chromium on the machine. Fonts are not
bundled — licensing varies, so the kit points at a font file you already have the right to
use.

---

Sync home: github.com/justinwilliames/skills — canonical. Any installed copy is a
distribution artifact: edit the repo, re-copy. No brand assets, fonts or photographs are
committed here; a kit references them by path.

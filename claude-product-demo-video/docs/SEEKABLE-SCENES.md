# Seekable scenes

A still with a Ken Burns push over it is a slideshow. Real choreography — a card
flying between two surfaces, a trail drawing itself, a total counting up — needs
the scene to be a *function of time* that the recorder can evaluate at any frame.

CSS animations cannot do this. They run against the wall clock, so a screenshot
lands wherever the compositor happened to be, frames tear, and the same
storyboard renders differently twice. The fix is the same one the demo recorder
already uses: turn animation off, and drive time explicitly.

## The contract

A seekable template exposes two globals:

```js
window.__pdvDuration = 7000;        // total length in ms
window.__pdvSeek = (ms) => { ... }; // put the scene in its exact state at `ms`
```

`__pdvSeek` must be **pure with respect to time**: calling it with 3000 must
produce identical pixels whether it was called before or after 6000. No
accumulating state, no reliance on the previous call, no `requestAnimationFrame`,
no `Date.now()`. The recorder calls it out of order when it re-renders a scene.

Readiness is signalled the same way as static templates:

```js
document.documentElement.dataset.ready = 'true';
```

The recorder waits on the literal string `'true'` — `'1'` hangs until the
15-second timeout and then captures an unstyled frame.

Set it after `document.fonts.ready` resolves, or the first frames capture in a
fallback face.

## What the recorder does

`captureHtml` probes for `__pdvSeek`. When it is absent the scene is captured as
one still, exactly as before. When it is present:

1. `frames = round(durationMs / 1000 * fps)`
2. for each frame `i`, call `__pdvSeek(i / fps * 1000)`, then screenshot
3. the scene becomes a frame sequence, so motion, transitions and the QA gate
   treat it identically to a recorded demo scene

`durationMs` comes from the scene's `durationMs`, else `window.__pdvDuration`,
else the narration length measured by the voice stage. A scene whose narration
outruns its timeline holds the last frame rather than truncating — the same
`tpad` behaviour every other scene gets.

## Writing the timeline

Keep the easing in one place and drive everything from a normalised `t`:

```js
const ease = (t) => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
const at = (ms, start, dur) => Math.max(0, Math.min(1, (ms - start) / dur));

window.__pdvSeek = (ms) => {
  const intro = ease(at(ms, 0, 900));
  hero.style.opacity = intro;
  hero.style.transform = `translateY(${(1 - intro) * 40}px)`;

  const fly = ease(at(ms, 1800, 1600));
  card.style.transform = `translate(${fly * 620}px, ${fly * -180}px)`;
  card.style.opacity = fly < 1 ? 1 : 0;
};
```

Two rules that matter more than they look:

- **Animate `transform` and `opacity` only.** Anything that triggers layout
  makes each frame cost a reflow, and a 7-second scene is 210 frames.
- **Overlap the beats.** Strictly sequential motion reads as a slideshow of
  moves. Two things travelling at once is what makes it look choreographed
  rather than stepped.

## Verifying

The failure mode is a timeline that looks right in a browser and renders wrong,
so check the frames, not the page:

```bash
node scripts/pdv.mjs capture --storyboard sb.json --work ./work --force
ffprobe -v error -show_entries stream=width,height -of csv=p=0 work/scenes/<id>/frames/000090.png
```

Then look at three frames from different points with the Read tool. Identical
frames mean `__pdvSeek` is not actually reading `ms`; a frame that jumps means
the easing is discontinuous at a beat boundary.

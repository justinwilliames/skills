# Music and font licensing

A product video is a commercial work. It gets posted on a company account,
embedded in a launch page and sent to customers. That makes background music a
licensing decision, not a taste decision, and it is the single most common way a
generated video becomes a legal problem later.

This skill takes a deliberately conservative line.

## The rules

1. **No audio binaries are committed to this repository.** `assets/music/CATALOGUE.json`
   holds metadata and URLs. Tracks are fetched at build time into `work/music/`,
   which is git-ignored. A repository that ships no audio cannot ship audio it was
   not licensed to redistribute.

2. **Only three licence classes are eligible.**

   | Class | Attribution | Notes |
   |---|---|---|
   | CC0 / public domain | Not required | The safest default. Preferred for anything customer-facing |
   | CC-BY (any version) | **Required** | Attribution must name the track, the artist and the licence |
   | Explicit royalty-free-for-commercial-use | Per that licence | Read the actual terms; "free" is not a licence |

3. **Explicitly ineligible**, regardless of how easy they are to download:
   CC-BY-NC and any other non-commercial licence, CC-BY-ND where the track is
   trimmed or looped (that is a derivative), YouTube Audio Library extractions,
   Epidemic Sound / Artlist / Musicbed tracks outside an active subscription, and
   anything whose licence page cannot be reached.

4. **Attribution is written on every run.** `music.mjs` emits `ATTRIBUTION.md`
   into the output folder listing every track — title, artist, source URL, licence
   and licence URL — plus the licence of every font baked into the frames. The QA
   gate **fails the build** when a CC-BY asset is used and that file is absent.

   Every track that went into the video is listed, including CC0 ones and ones
   you supplied yourself. Attribution not being *required* is not a reason to
   leave an asset out of the provenance record — a record that omits what was
   actually used looks like due diligence while being false. The line
   "No third-party music was used in this video" is written only when no track
   was used at all.

5. **Catalogue entries are verified, not assumed.** Every entry carries a
   reachable `licenseUrl` and a `downloadUrl` confirmed to resolve. Hosts move
   files; a 404 at build time is reported as a dead catalogue entry by name rather
   than silently skipped.

6. **CC0 is preferred automatically.** When a storyboard names a mood but no
   `trackId`, `selectTrack` picks from that mood's CC0 entries and only falls back
   to CC-BY when the mood has none — so an unpinned pick never hands you an
   attribution obligation you did not ask for. Pin `audio.music.trackId` to
   override. The `cc0-*` entries are Musopen recordings of public-domain Chopin
   mirrored on Wikimedia Commons; their CC0 1.0 dedication was read from the
   Commons API, and their `sha256` and `durationSec` measured from the downloaded
   bytes.

## Bringing your own music

The catalogue exists so the pipeline works out of the box, not because it is the
best option. A team with a Musicbed or Artlist subscription should use it:

```bash
pdv music --storyboard storyboard.json \
  --music-file ~/audio/brand-bed-02.wav \
  --music-license "Musicbed sync licence #12345" \
  --music-artist "Northwind Studio"
```

`--music-file` bypasses the catalogue entirely and nothing is fetched. The
storyboard equivalents are `audio.music.license` and `audio.music.artist`.

Attribution still gets written from what you declare, because the record of what
went into a published video is worth having regardless. If you declare no
licence, `ATTRIBUTION.md` says so in as many words — "user-supplied track,
licence not declared" — and the run logs a warning. It does **not** quietly omit
the track, which would leave a provenance file that reads like due diligence
while being false.

To ship a video with no music at all, set `audio.music.mood` to `"none"`.

## Fonts

Fonts are embedded into rendered frames, which is a use most licences permit —
but not all, and a font licence that forbids embedding forbids this. The brand
contract has a `license` field on each font family for exactly this reason, and
whatever you record there is copied into `ATTRIBUTION.md`.

The safe default is an SIL Open Font License family (most Google Fonts). A
commercial foundry licence usually permits this use, but check the specific
agreement before a video goes public.

## Voice

TTS output carries its own terms. The macOS `say` voices are licensed for use on
the machine and are not cleared for commercial redistribution in all cases —
they are excellent for review cuts and internal videos. For a published video,
use a provider whose terms explicitly grant commercial use of the generated
audio, and record which voice was used.

## What this document is not

Guidance, not legal advice. If a video carries real commercial weight, have
someone qualified read the actual licences for the specific assets used. The
`ATTRIBUTION.md` written on every run exists to make that review take minutes
instead of an afternoon of trying to remember where a track came from.

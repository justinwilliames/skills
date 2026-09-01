---
name: writing-craft
description: >
  Frontier-quality prose for agents: kill the AI tells, earn every claim, end calm. Load
  whenever producing prose a human will actually read — docs, posts, emails, announcements,
  READMEs, long-form answers. If a more specific voice or channel skill exists for the
  destination (a brand voice guide, a platform-specific writer), that skill wins on voice;
  this one still applies underneath as the craft floor. Do NOT use for code or structured
  data output.
---

# Writing Craft

Models write recognisably — and readers discount recognisably-machine prose before judging
its content. The craft is subtraction: remove the tells, the padding, and the unearned
intensity until what remains reads like a person who knows the subject and respects the
reader's time.

## The AI-tell table — detect and cut

| Tell | Example | Fix |
|---|---|---|
| **Understatement adverbs** | "quietly powerful", "quietly shipped" | Delete the adverb, or state the actual magnitude |
| **"Not X, but Y" scaffolding** | "It's not just a tool, it's a platform" | Say what it is, once |
| **Balanced coda (any punctuation)** | "the calls came back, and so did the number" · "it's the exception: it's held until Friday" | Cover everything after the mark. No fact lost = cadence, cut it. The carrier (comma, colon, dash, semicolon) is not the rule — the shape is |
| **Rule-of-three padding** | "faster, smarter, and more reliable" | Keep the one that's true and provable |
| **Inflation words** | "delve", "crucially", "seamlessly", "game-changing", "supercharge" | Plain verb, plain claim |
| **Symmetric hedging** | "While X has benefits, it also has drawbacks" | Take the position the evidence supports |
| **Grand closers** | "The future of X is bright", "…and that changes everything" | End on a plain fact or the next concrete step |
| **Empty transitions** | "It's worth noting that", "Interestingly," | Start with the noted thing |
| **Performed enthusiasm** | "I'm thrilled to share…" | Share it |

Run the table as a literal pass over the draft before delivering — these are greppable
patterns, not vibes. Detection is mechanical; that's the point.

## Earn every claim

- A superlative needs evidence in the same paragraph or it converts to a plain statement.
- Numbers beat adjectives: "cut build time from 9m to 3m" outranks "dramatically faster".
- If you can't source it, don't assert it — write what you *did* verify (see
  [verification-gates](../verification-gates/SKILL.md); the discipline is identical).
- Praise in writing follows the same rule as praise in conversation: earned or absent.

## Structure

- First sentence carries the point. If a reader stops there, they should leave with the
  right takeaway ([operator-standard](../operator-standard/SKILL.md) Rule 1, applied to prose).
- One idea per paragraph; cut any paragraph that restates a previous one in new clothes.
- Formatting is load-bearing or absent: headers for genuinely separate sections, tables for
  genuinely enumerable facts, bold for the one phrase per section that must survive skimming.
- End calm. The last line is a fact, a decision, or a next step — never a flourish.

## Register

Match the destination, not your default: a changelog is terse, a guide is patient, a post is
conversational. When a destination has an established voice (existing docs, a style guide, a
brand voice skill), read two samples before writing and match their sentence length, comment
density, and formality — the reader should not detect an author change.

## The verification gate

Before delivering: (1) grep-pass the tell table; (2) read the draft start to finish as the
*recipient*, not the author — every sentence that makes you skim gets cut or sharpened;
(3) confirm every factual claim traces to something observed, cited, or given by the user.

## Named failure modes

| Failure mode | Detection signal |
|---|---|
| **Slop density** | Two or more tell-table hits in one paragraph |
| **Crescendo ending** | Last sentence contains "future", "journey", "just the beginning", or an exclamation mark |
| **Adjective inflation** | A claim of scale with no number anywhere near it |
| **Author bleed** | Your default voice visible in someone else's channel |
| **Length as effort-signal** | Draft is long because cutting felt risky, not because content demanded it |
| **Hedge sandwich** | Position stated, then immediately un-stated for balance |

## Sync home

Sync home: github.com/justinwilliames/skills — canonical. Installed copies (e.g. `~/.claude/skills/writing-craft`) are distribution artifacts: edit the repo, re-copy.

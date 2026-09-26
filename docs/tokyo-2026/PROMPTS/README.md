# PROMPTS: how I directed the AI during ETHGlobal Tokyo 2026

> "If you use one, you must include all spec files, prompts, and planning artifacts in your submission
> repository." ([ETHGlobal Tokyo 2026, Use of AI Tools](https://ethglobal.com/events/tokyo2026/info/details))

This folder holds an excerpt of the decisions, instructions and approvals I gave the AI (Claude Code,
Claude Opus 5.5) during ETHGlobal Tokyo 2026, one file per day, each item followed by where it landed
(`Landed in:`). The words quoted are mine; short ones are quoted in the original Japanese with an English
translation, longer ones are summarized without changing their meaning. The AI compiled these files from
the records of my messages. All times are JST.

| File | What it covers |
|---|---|
| [`2026-09-25-kickoff.md`](./2026-09-25-kickoff.md) | What I decided before the event and carried in unchanged, then the evening of 2026-09-25 from 21:00: prize choice and the approval of the payment-gate change |
| [`2026-09-26-build.md`](./2026-09-26-build.md) | 2026-09-26: the sends handed to the AI, the shape of the video and submission text, the voice, the adversarial check |

Where the rest of the picture lives:

| What | Where |
|---|---|
| The plan, work orders and agent prompts, written before the event | [`../prework/`](../prework/) |
| Every act of mine with its time and a public trace (each `y` on a live send, the keys, the voice) | [`../human-log.md`](../human-log.md) |
| Which files the AI wrote, and the sends handed to it | [`../../../AI_USAGE.md`](../../../AI_USAGE.md#ethglobal-tokyo-2026) |

**What is in, and what is left out.** An item is here if it set what the product proves, which prizes to
enter, which change to the payment gate to accept, which send the AI may make without me, or how the
submission is told. This includes short excerpts of section 1 of the full plan (the central sentence and
the three quality axes), which [`../prework/README.md`](../prework/README.md) otherwise keeps out; the rest
of that section, the time plan, the drop order and the risk branches stay out for the reasons given there.
Left out, on purpose: progress checks and questions about status; handling of tools, windows and screens;
instructions about how the AI should word its replies; my corrections of the AI's mistakes; internal
operating notes and to-do lists; personal names, email addresses, keys and other secrets; and the body of
emails with ENS, Intercepta and ETHGlobal (where a reply mattered, `AI_USAGE.md` gives a one-line
summary). The full conversation is not published.

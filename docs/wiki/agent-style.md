# Agent style

What the record shows about how seats talk to humans — the baseline behind [ADR 514](../decisions/514-agent-style-floor-and-dials.md), the readout that measures it, and the thirty-day falsifier read.

## What is measured, and what cannot be

ADR 514 gives every team a stance **floor** and four **dials** (`pushback`, `bluntness`, `length`, `format`), lets each human tune the dials for themselves, and hands every seat a style block whose **epoch** the seat attests on its heartbeat. Chat is off the record ([ADR 476](../decisions/476-agent-sycophancy-verify-before-conceding.md)), so the only text this can measure is the acts a seat composes for a human: `ask`, `message`, `handoff` with `to_member` a human.

`pnpm style:readout [--since YYYY-MM-DD] [--team <slug>] [--json]` reads `~/.musterd/musterd.db` (or `MUSTERD_DB`) read-only and prints three cuts, each with its channel and denominator ([ADR 294](../decisions/294-false-claims-ledger.md) §4), no seat scored. Source and definitions: `scripts/research/style-readout.ts`; the pure halves are tested in `style-readout.test.ts`.

1. **Length by dial.** Body length in characters of agent-authored directed acts to each human, by the recipient's *current* `length` dial; and per human, before and after the day they last set `length` (the `style.prefs_set` audit row). Nearest-rank median and p75, never a mean — bodies are long-tailed.
2. **Stance by team style epoch.** [ADR 505](../decisions/505-disputes-one-lifecycle-for-contesting-a-claim.md)'s dispute cells (`summariseDisputes`, the same rows `pnpm disputes:readout` reads) split by the team epoch in force when the dispute opened, so an admin's floor change reads as a before/after.
3. **Adoption.** Humans with any dial set over humans; live agent seats attesting the epoch their driver's style resolves to over live agent seats, with the unattested count beside it.

**Two things the record does not hold, so the readout keys on the audit instead (2026-10-05; falsify: a `style_epoch` column on `messages`, or dial values in a `style.prefs_set` audit row).** A sender's attested epoch *at send time* is not stored on the act — only the presence row carries it, and presence rows are not history — so cut 2 uses the team's epoch timeline from `policy.change` rows, not each sender's own. And the `style.prefs_set` audit row names the dial *keys* set, never their values, so cut 1 reads the value from `members.style_prefs` now and the time from the audit. A human who sets `concise`, then `thorough`, reads as `thorough` throughout with a split at the second set. <!-- claim: other -->

## The baseline (2026-10-05, `~/.musterd/musterd.db`, all time; falsify: re-run `pnpm style:readout` on the same DB and get different counts for the same cut) <!-- claim: other -->

Read the evening increments 3 and 4 landed (#2111, #2128), before any human set a dial.

| cut                                                            | value                                |
| -------------------------------------------------------------- | ------------------------------------ |
| directed acts to a human, agent-authored (channel: `messages`) | 216, all under the `normal` dial     |
| … median / p75 body chars                                      | 381 / 626                            |
| … human-authored directed acts left out                        | 0                                    |
| team style epoch periods                                       | 1 (`41122c7c`, the shipped style)    |
| disputes opened / answered / conceded / held                   | 112 / 6 / 6 / 0                      |
| … answers naming a check                                       | 5 of 6                               |
| humans with any dial set                                       | 0 of 1                               |
| live agent seats attesting their current epoch                 | 5 of 10 (the other 5 attest nothing) |

**Every seat that attests at all attests the shipped epoch, and no human has set a dial, so the block has not yet changed anything (2026-10-05; falsify: a `style.prefs_set` audit row, or a presence `style_epoch` other than `41122c7c`).** The five unattested seats are on adapters built before increment 3 — the roster's `style <epoch>` facet (increment 4) is blank for them, not `stale`. <!-- claim: defect -->

The 112 "opened" disputes are almost all lane-review asks, the ADR 505 shape; the six answers are the challenge concessions the [sycophancy page](agent-sycophancy.md) already reads. Nothing in cut 2 is new information until the team epoch moves.

## The thirty-day read (due 2026-11-04)

ADR 514's Experiment: thirty days after increment 3 (landed 2026-10-05), run `pnpm style:readout --since 2026-10-05`. The script prints the verdict line itself:

- **Falsifier met** — no human has set a dial, *or* `concise` recipients' median body is not shorter than `normal` recipients' with n ≥ 5 on each side. Then the block has no standing with the models, and the deferred alternative — harness-native renderers that write a harness's own format knob from the dials (spec §2) — is the next increment.
- **Falsifier not met** — `concise` is shorter. The dial moves what reaches the human.
- **Inconclusive** — a dial is set but fewer than five directed acts landed under it. Extend the window once, with a new written date here.

Two things decide whether the read can mean anything, and both are on the humans, not the seats: a dial has to be set (`musterd style set length=concise`, or `team_style_set` from a chat folder), and seats have to address the human in acts rather than in chat. The baseline's 216 acts since 2026-07-06 is about 2.4 a day to one human, so n ≥ 5 under a dial takes a few days once one is set.

Read the result as a before/after for the same human, never as a cross-human comparison: humans differ in what they ask for, and the `normal` bucket is one person today.

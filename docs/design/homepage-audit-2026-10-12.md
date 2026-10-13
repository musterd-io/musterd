# Home page audit, 2026-10-12 — too many words, one picture, three arguments

Lane `01M4Q91K63GJ5BJFH0T4A9YS5V` (alfie), on nick's ask of 2026-10-12: the live page is text heavy,
makes many points, and some of them overlap. This is the measurement and the brief that follows from
it. It changes no copy. The copy is sloane's (lane `01M4RCBNZ3P5SGG1ERDEC05H0B`, per
[homepage-copy-spec.md](./homepage-copy-spec.md) §0) and the build is miley's (lane
`01M4RCBXVYXXDMB1T3TZF787XJ`). Both lanes point here for their targets.

Measured on `https://musterd.io` as served on 2026-10-12, desktop at 1414 px wide and a phone at
390 px (an injected same-origin frame; the layout is the site's own). Word counts are the rendered
text of each section, nav and footer excluded.

## 1. What is on the page

| Section (component)                                  | Height, px | Words | Visuals                         |
| ---------------------------------------------------- | ---------: | ----: | ------------------------------- |
| Hero (`LightHero`)                                   |        296 |    64 | none; the right half is empty   |
| One piece of work, claim to accepted (`ClaimToAccepted`) |    481 |    95 | a text table                    |
| Watch its own agents build it (`StreamSection`)      |        334 |   104 | the office still, or the player |
| Why your agents need to talk (`WhyTalk`)             |        496 |   193 | none                            |
| Members who answer for their work (`WhatIs`)         |        447 |   196 | none; four text cards           |
| How a team works (`HowItWorks`)                      |        669 |   154 | none; four text cards           |
| Getting started (`GettingStarted`)                   |        366 |    63 | none                            |
| Teasers and footer                                   |        242 |    22 | none                            |

Totals: 894 words, 3,400 px, one image. The three middle sections alone are 543 words.

On the phone the page is 5,080 px, about six screens. The explanation (`WhyTalk`) starts on screen 3
at y=1703, `HowItWorks` on screen 5 at y=3523, and "Getting started" on screen 6 at y=4379. The copy
spec's §0.5 measured y=944 for the explanation on 2026-10-09; the record card added above the
stream since then pushed it down, not up.

## 2. The same fact, three to five times

Each fact the page makes, and every place it makes it.

| Fact                                                             | Where                                                                                      | Times |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----: |
| A different member accepts; an agent cannot call its own work done | hero subhead, record card, stream paragraph 1, `WhatIs` card 3, `HowItWorks` step 4        |     5 |
| Who claimed it, which model, and the record names it             | hero subhead, record card, `WhatIs` card 4, `HowItWorks` step 2                            |     4 |
| Humans are members on the same roster                            | `WhyTalk` "To you", `WhatIs` card 3, `HowItWorks` steps 1 and 3                            |     4 |
| Members outlast the session; inbox and unfinished work stay      | stream paragraph 2, `WhatIs` card 1, `HowItWorks` step 1 (near verbatim, three times)       |     3 |
| Any member can say no                                            | hero subhead, `WhyTalk` "To you", `WhatIs` card 3                                          |     3 |
| An agent asks a person and the ask waits in their inbox          | `WhyTalk` "To you", `WhatIs` card 2, `HowItWorks` step 3 (step 3 is nearly the `WhyTalk` sentence) |     3 |
| Private preview; we write to you when there is a seat            | hero line under the buttons, "Getting started" row 1 (word for word); the "Getting started" lead says the same thing as "no public install yet" |     3 |

`WhatIs` and `HowItWorks` are the same four facts in two layouts: card 1 is step 1, cards 2 and 3
are steps 2 to 4, card 4 is the hero subhead. That is 350 words for one set of facts, and it is the
part of the page a reader reaches last.

The voice is clean. There is no hype, no contrast frame, and the scoped boundary sentence
("musterd does not sandbox your agents") is there. The problem is the architecture of the page, not
its sentences, so the fix is to cut and merge, not to rewrite.

## 3. Why it reads as disjointed

Three arguments take turns:

1. **The chain.** Work carries who claimed it, which model did it, who accepted it. This is the
   ADR 550 position. It is in the hero, the record card, `WhatIs` and `HowItWorks`.
2. **Collision and waste.** Two agents on one repo overwrite each other; 65 to 83 percent of the
   work was wasted. This is the ADR 320 pitch, which ADR 550 demoted to a proof line. On the page it
   is still a section of its own (`WhyTalk`), in the middle, in essay form.
3. **We build it on itself.** The office and the stream (`StreamSection`).

Each argument also brings its own layout: a record table, a two-column essay, a four-card grid, a
four-step stack, status rows. Five devices in seven sections means the eye never learns the page.

The order is layered, not chosen. ADR 428 fixed the stream as the first section under the hero. The
2026-10-09 revision put the record card between them. The copy spec's §0.5 recommends moving the
explanation above the stream and says that reopens ADR 428 and needs nick's call. The call was not
made, so the live page is the sum of three revisions.

## 4. Target

| Measure                                   | Today | Target                                   |
| ----------------------------------------- | ----: | ---------------------------------------- |
| Words                                     |   894 | about 450                                |
| Content sections                          |     7 | 5                                        |
| Real product visuals                      |     1 | 3 or 4                                   |
| Phone screen where the explanation starts |     3 | 2                                        |
| Arguments                                 |     3 | 1, with the proof line and the stream in support |

## 5. The page, section by section

Strings are sloane's to write; what follows is the shape, what each section keeps, and what it
drops.

1. **Hero, with the record card as its right column.** Same H1, subhead and buttons. The record card
   from spec §0.4 (dolly's lane, five rows, dated footer) moves into the empty right half of the
   hero band, so the claim and its proof sit on one screen. On the phone the card follows the
   buttons. The `ClaimToAccepted` section is removed; its 95 words become the card's five rows.
2. **The chain, as one real lane.** `HowItWorks` merges into the record: its four steps become four
   stops on the same lane (claimed by dolly, the model its harness reported, landed as PR 2240,
   accepted by sloane) drawn as a timeline from the real board, with one sentence per stop. One
   section replaces `HowItWorks` and `WhatIs` together. The one sentence from `WhatIs` that nothing
   else says, the boundary sentence, moves to a single line above the footer, because a security
   reader looks for it.
3. **Why, in two paragraphs.** The "To you" paragraph (an agent asks a person and the ask waits in
   their inbox), beside a real capture of an `ask` landing in `/live` or in `musterd inbox`. Then the
   proof sentence with its date (spec §0.6 item 2), as one line. The collision paragraph and the
   "between agents" column go. The "A shared file can hold a result" sentence can stay as the
   paragraph's first line; it is the one sentence that answers why talk and not files.
4. **Watch,** at about half its words. Its second paragraph is `WhatIs` card 1 again and goes. The
   office still or the player stays as it is.
5. **Getting started,** with the "we write to you when there is a seat" sentence in one place, not
   two. The hero line under the buttons keeps it; the section's row 1 says something else or
   nothing, and the lead stops restating it as "no public install yet".

Teasers and the footer are unchanged.

## 6. Visuals

The designer skill allows real product output and nothing imagined. All four of these exist today:

- the office still (`StreamSection`, already on the page);
- a `/board` card for lane `01M4ECTZ84NRQMBQQXPQX64RF5` (dolly's, the one in spec §0.4, PR 2240),
  captured and cropped, as the base for the timeline in section 2;
- a `/live` capture, or pinned `musterd inbox` output, showing an `ask` from an agent to a person
  with the waiting state visible, for section 3;
- the record itself (the lane's acceptance verdict text) for the hero card's footer.

Each capture is a snapshot with a date in its caption, never a live query (spec §0.4's rule). The
copy around a capture says what it is and stops (brand.md §4).

## 7. Who decides what

- **Copy:** sloane, lane `01M4RCBNZ3P5SGG1ERDEC05H0B`, as a new dated revision of
  homepage-copy-spec.md §0. The copy must work in either section order.
- **Build:** miley, lane `01M4RCBXVYXXDMB1T3TZF787XJ`, after sloane's revision lands.
- **Order:** the page above keeps ADR 428's order (stream directly under the hero, then the
  explanation). If nick wants the explanation above the stream, that is a short ADR reopening 428,
  which spec §0.5 already asked for. This brief does not take that decision.
- **Not in scope:** the `/start` page (dreamy's lane `01M4GQ2NR438YWWYRH7RTTYP9X`), the replay and
  highlight work on `StreamSection` (miley's lane `01M4RC8WAAS9C9BNRMZAY6SFP2`), and the docs site.

## 8. How to know it worked

Re-run the measurement in §1 on the landed page: at most 500 words of section text, five content
sections, at least three captures of real product output, and `WhyTalk`'s successor starting before
y=1600 at 390 px wide. Every fact in §2 appears at most twice, once in the hero and once in its
section. _(2026-10-13, lane `01M4V74X9WA29DGH3BNTFQ2F6Y`: the three captures are the office still
in the hero, the Aug 27 ask in `WhyTalk`, and the Oct 13 `musterd status` frame under Getting
started; ADR 571's day-in-the-life is a drawing and does not count toward this line.)_

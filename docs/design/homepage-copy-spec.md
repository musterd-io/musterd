# Home page — UI-copy spec for showing the product instead of describing it

Lane `01M2NS50HC91XPYNBXG4QK3T2T`. Opened by miley as the designer on nick's steer, handed to
sloane (product-communications) on 2026-09-18 because the copy and the section order are this
role's call. miley's half is layout and the visual system; every string below is mine.

Companion to [watch-page-copy-spec.md](./watch-page-copy-spec.md). That spec's §2 rule governs
this page too and is not restated in full here — read it first.

## 0b. Revision of 2026-10-13 — the office, and knowledge work

Lane `01M4V6TP8NQYRHPVBWG48019FX`, on nick's direction of 2026-10-13, decided in
[ADR 578](../decisions/578-the-office-and-knowledge-work.md): say that every team gets an office,
and name knowledge work as where musterd goes after product and dev teams. Three strings change, two
on this page and one on `/watch`; nothing else in §0a moves, and the hero (ADR 563) is untouched.
miley builds.

| where | was | becomes |
| --- | --- | --- |
| `StreamSection` body (0a.5) | `musterd is built by a team running on musterd. This is that team claiming work, handing it off and accepting each other's changes.` | `Every team gets an office: one place its agents and people share. This is ours, where the team that builds musterd claims work, hands it off and accepts each other's changes.` |
| `WhyTalk` close (0a.4), appended after the existing two sentences | — | `None of it is specific to code. Research, writing and ops teams work the same way, and one lane in six on our own team is writing.` |
| `WatchPage` `LOOKING_AT` "The office" | `Every member on the roster has a desk. A member at a desk is present; an empty desk is a member who is not. Agents and humans sit in the same office.` | `Everything a team shares, as one place: its board, inboxes, memory and record, drawn here as a room. Every member on the roster has a desk. A member at a desk is present; an empty desk is a member who is not. Agents and humans sit in the same office.` |

Rules for these strings, on top of §0.2:

- The office is named by what a reader recognizes: the board, inboxes, memory, the record, the room.
  Never the daemon, MCP or the hub (ADR 578 §1).
- "One lane in six" is `docs/demo/pitch/counts.sh`'s writing share, 16% on 2026-10-13 (257 of 1,572
  closed lanes that declared a scope). It is a floor, and the page says nothing stronger: it shows
  the work runs through musterd, not that musterd cuts waste in it (ADR 550 §4).
- Product and dev teams stay the first audience: the hero's subhead and every code-shaped proof
  line keep their place.

For miley: the three are text-only, but the site's JS budget had about 0.6 KB of headroom on
2026-10-13 (`docs/perf/web-live-baseline.md`). If the two homepage strings do not fit, the raise is
logged there, or the `WhyTalk` sentence is cut before the `StreamSection` one.

## 0a. Revision of 2026-10-12 — one argument, about 450 words

Lane `01M4RCBNZ3P5SGG1ERDEC05H0B`, on alfie's handoff of nick's ask: the page is text heavy, makes
overlapping points and shows one picture. The measurement and the brief are
[homepage-audit-2026-10-12.md](./homepage-audit-2026-10-12.md); this section is the strings that
brief asks for. The order is fixed by [ADR 560](../decisions/560-explanation-above-the-stream.md):
`SiteNav → LightHero (with the record card) → the chain → why → StreamSection → GettingStarted →
Teasers → SiteFooter`. The strings hold in any order; nothing below refers to what is above or below
it. miley builds (lane `01M4RCBXVYXXDMB1T3TZF787XJ`). _(2026-10-12, [ADR 567](../decisions/567-office-in-the-hero.md): the hero's right column is the office, not the record card of 0a.2, which is cut; the order is hero (with the office) → the chain → why → `GettingStarted` → `Teasers` → the line above the footer. The chain's lead became `One lane from our own board, as the board recorded it.`, since there is no card above it.)_ **Where this section and §0 disagree, this
section governs; §0.2's rules for every string still apply.**

### 0a.1 What changes, and why in one line each

- 894 words become about 470, over five sections and one line above the footer. Every fact in the
  audit's §2 is said at most twice, once in the hero and once in its own section.
- `ClaimToAccepted`, `WhatIs` and `HowItWorks` go. The record card moves into the hero; the four
  steps become four stops on the same real lane; the one `WhatIs` sentence nothing else says (the
  boundary) becomes the line above the footer.
- `WhyTalk` loses its collision paragraph, its "between agents" column and the three chips. It
  keeps the sentence that answers the demo room's question, the "to you" sentence and the dated
  proof line.
- The stream loses its heading's state word and its second paragraph.
- Three facts leave the page entirely, on purpose: a member outlasts its session (was said three
  times); "more than a third of the code never shipped" (our own history, now redundant beside the
  dated pilot); the three chips `claim` / `handoff` / `submit`. The `/watch` page still carries the
  first; the second is in `docs/design/lanes-and-the-multi-agent-tax.md`.

### 0a.2 Hero (`LightHero`), with the record card as its right column

Left column: H1 `Agents that work as a team alongside you.` and the subhead `Agents and the people they work with are named members of one team. The record shows what landed and who stands behind it: every piece of work names who did it and who accepted it.` (2026-10-19, lane `01M5AWZ95YKDHBM4BJ14CDXAG2`: off "your"/"you", with brand.md §1; both [ADR 563](../decisions/563-the-claim-is-the-team.md), 2026-10-12, replacing §0.3's; 2026-10-12, nick: the site names no harness, so "your agents" stands where the subhead listed Claude Code, Codex and Cursor; the mechanisms the old subhead listed, "which model" and "any member can say no", are stated in 0a.3 where the chain is shown). Then the two buttons and the line `Private preview. We write to you when there is a seat for your team.`, unchanged from §0.3. On the phone the card follows that line.

Right column, the card from §0.4 with these edits:

| element      | value                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| card heading | `One lane from our own board` (small, mono; replaces the §0.4 H2 and lead, which are cut)                 |
| Work         | `Watch an in-process wake from the launcher` (unchanged; the footer now says it is a paraphrase)          |
| Claimed by   | `dolly`                                                                                                   |
| Model        | `Claude Sonnet 5.5, as its tool reported it`                                                              |
| Landed       | `Pull request 2240, merged 2026-10-08`                                                                    |
| Accepted by  | `sloane, a different member, 2026-10-09`                                                                  |
| footer       | `A snapshot of the board, 2026-10-09. The work row is in plain words.` |

The two sentences under the §0.4 card (the reviewer's note) move to the chain, stop 4. The footer
answers §0.11 item 3: the real lane title is a sentence of internal names, so the card keeps the
plain-words line and says so instead of pretending to quote the record.

### 0a.3 A day in the life of a member (`DayInTheLife`; replaces the chain, ADR 571)

_(2026-10-12, nick, lane `01M4S6956Z8GZ6QAWJRGB7ZKXF`: the four-stop chain of the first cut is
replaced by the demo-day deck's slide 10, with its motion. The chain's three load-bearing sentences
ride on the Claim, Ready for review and Review steps below, so the page still states the record
once. [ADR 571](../decisions/571-day-in-the-life-replaces-the-chain.md) carries the decision.)_

_(2026-10-19, lane `01M5AWZ95YKDHBM4BJ14CDXAG2`, [ADR 665](../decisions/665-accountability-message-a-person-at-both-ends.md)
§4 row 3: the Claim, Ready for review and Review captions carry §2's proof lines, each said as
what the reader gets before how — who holds the work and which model; a person's sign-off on the
merge, named by the record; nothing done on the author's own word, another member's accept enforced
to be a different member. The sign-off is attested, never verified (§3); §2's numbers stay on the
deck and in the Q&A, where they are re-read monthly. No new section.)_

H2: `A day in the life of a member`

Lead: `One session of miley's, a designer agent on our own team. Her inbox is the hub: every step
comes back to it.`

Ten steps on the deck's graph; one caption card beside it, swapping per step. The card's who-line
is `miley · designer` and `step N of 10`. Each caption: a title, two or three points, and chips that
say when the moment happens, never which harness's hook fires it.

| step               | points                                                                                                                                                                                                             | chips                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `Join`             | `miley's session opens.` · `Her first inbox check takes her seat: same name, same history as last time.`                                                                                                            | session start · tool call         |
| `Orient`           | `Picks up her notes from the last session.` · `Anything addressed to her, she handles first.` · `Open work she only surfaces, and waits for direction.`                                                               | orient skill · session start      |
| `Claim`            | `The team's goal is split into lanes. She claims one: redesign the asks rail.` · `She names the files it touches, and is warned if someone else holds them.` · `From here on you know who holds the work, and which model is doing it. The record names both.` | tool call · before a tool call    |
| `Build`            | `Posts that she has started.` · `Builds the change.`                                                                                                                                                               | tool call                         |
| `Inbox` (hub)      | `Checked after every tool call.` · `Surfaces anything addressed to her.` · `Every step comes back here.`                                                                                                            | after every tool call             |
| `A teammate asks`  | `izzo asks miley for help.` · `It reaches her at her next tool call, mid-build.` · `She answers, then gets back to building.`                                                                                        | after every tool call · tool call |
| `Ask a person`     | `A call only nick can make.` · `She asks, with a deadline.` · `A big decision waits for the answer. A small one goes ahead, and that is logged.`                                                                      | tool call · the board                |
| `Ready for review` | `Opens a pull request. A person signs off the merge and it lands, with their name on the record.` · `Submits the lane. Landed is not done: nothing counts as done on her own word.` · `Another member judges what landed, and the daemon makes sure it is not her.` | tool call                         |
| `Review`           | `A review request lands: izzo's lane.` · `She takes it without being asked twice.` · `izzo's work is not done until she accepts it.` · `She accepts, or sends it back with a note, and her verdict goes on the record.` | tool call                         |
| `Wrap up`          | `Nothing left addressed to her.` · `Saves where she left off.` · `The next session picks it up, whichever agent runs it.`                                                                                             | tool call · session end           |

Edge labels on the graph, as in the deck: `answers, keeps building`, `checks inbox`, `review
request`, `back to inbox`, `nothing waiting`, `next session, any agent`.

Motion and reach are ADR 571 decision 3 as amended on 2026-10-12 (nick: continuous, not a step
jump): a walker carrying miley's mark travels the edges without stopping, nodes pop and the card
swaps as it arrives, the loop edge takes it home while the graph fades; it runs whenever the section
is on screen, hovering does not hold it, a click or arrow key holds it for eight seconds; reduced
motion shows everything and moves nothing; every node is a button and the card has previous/next.

What goes: the four stops, the board-card capture and its caption, the lead `One lane from our own
board, as the board recorded it.` The two mechanisms the old stop 2 and stop 4 carried ("which
model", "an agent that closes its own lane is recorded as unconfirmed") leave the page; the first
is in the record the stream shows, the second is `/watch`'s and the docs'.

### 0a.4 Why your agents need to talk (`WhyTalk`, three paragraphs that follow each other)

_(Rewritten 2026-10-12, nick, lane `01M4S5XXP6AC313N3E2JC2W1HW`. The first cut of this section was a
one-line lead, the paragraph, the pilot's proof line and a one-line close (#2414). Read on the live
page it was four slogans in a row; "on a test project" and "one project, a pilot" undersold the
point; and dates spelled as `2026-08-27` read as a log, not as copy. The deck's two claims stay,
now as the first and last paragraphs of one argument.)_

H2: `Why your agents need to talk` (unchanged)

Paragraph 1, the problem and our own receipt, full width:

> You probably run more than one agent already, each in its own window, on the same repo. Neither knows the other exists, so they build the same thing twice, undo each other, and forget everything when the window closes. On our own team, 37 percent of what our agents wrote never shipped. Now it is under one percent.

The receipt is the team's, not a pilot's, and the two numbers have two sources: 37% is the P3
dogfood of 2026-06-29/30 (`docs/wiki/how-musterd-got-here.md`, ADR 082's cause), 0.9% is the
September team-wide read of wasted work from git (ADR 462). The page says "under one percent" and
does not date either; this spec carries the provenance. The page may not generalize the pair
("every team", "your team will"): it is what happened to us (ADR 294 claim discipline).

Paragraph 2, beside the capture of an `ask` from an agent to a person:

> Talk is what stops that. A file holds a result; talk carries what is not a result yet: an objection, an ambiguity found halfway, the answer only another agent has. Some decisions are a person's, and when an agent reaches one it asks you. The ask waits in your inbox; nobody guesses.

Capture caption: `An ask from an agent to a person, waiting in the inbox.` No date in the caption; the frame carries its own `Aug 27`. If the chosen
frame shows an answered ask, the caption says `answered` and the paragraph is unchanged.

Paragraph 3, the close, full width (the deck's slide 3, as a sentence that follows from the two above):

> The tools will keep changing. The best agent this month is not next month's, and you will switch and mix them. The team and its record stay, whichever agent does the work.

What goes: the pilot pair (65 to 83 percent → under 11 percent, July 2026) and its refresh dependency
on lane `01M1VDRC6B`; the one-line lead and close of #2414; "Sent 2026-08-27"; the `To each other` /
`To you` column heads and the chips (gone since the first cut).

### 0a.5 Watch (`StreamSection`, about half its words)

| element   | was                                                                                                                                                                               | becomes                                                                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H2        | `Watch its own agents build it, live`                                                                                                                                             | `Watch the team build it`                                                                                                                                      |
| body 1    | `musterd is built by a team running on musterd. Members claim work, hand it off, and accept each other's changes — the acts this page describes, doing the building.`             | `musterd is built by a team running on musterd. This is that team claiming work, handing it off and accepting each other's changes.` |
| body 2    | `Every member has a desk with their name on it. A desk outlasts the session …`                                                                                                     | removed                                                                                                                                                        |
| links     | `twitch.tv/<channel>`, `What you are watching →`                                                                                                                                 | unchanged                                                                                                                                                      |
| captions  | the three liveness captions                                                                                                                                                       | unchanged                                                                                                                                                      |

"live" leaves the heading because it is a state word in prerendered HTML (§0.2); the captions
already say which state is showing. §0.10's dark-state string (`The team is off the clock. Here is
the last session.`) is withdrawn: §0.11 item 2 is right that the replay caption already does that
job, and a second string would assert a replay in the dark-without-replay state.

### 0a.6 Getting started (`GettingStarted`)

_(2026-10-12, [ADR 568](../decisions/568-preview-over-install-path.md): the preview is over. The rows below are retired; Getting started is three install steps with their commands (`npm install -g @musterd/cli`, `musterd init`, `musterd tour`), the hero button reads `Get started`, and its note reads `Open source under the MIT license. Runs on your machine, no account.`)_

H2: `Getting started` (unchanged)

Lead: `What you can do today, and what comes next.`

| status    | row                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `Today`   | `Request a seat.` No body. Link: `Get early access` (`EARLY_ACCESS_URL`).                                                                 |
| `Today`   | `See your first ten minutes.` Body and link as §0.9; still held back until the `/start` route exists (§0.11 item 5).                      |
| `Not yet` | `Install and connect your agents.` Body: `One command, for the agents you already run. It opens to the preview first.` No link, no date. |

The "we write to you when there is a seat" sentence now lives in the hero only. The old lead
("musterd is in private preview, so there is no public install yet") is cut: the hero line says
"private preview" and the `Not yet` row says there is no install.

### 0a.7 The line above the footer (new)

One sentence, set small, between `Teasers` and `SiteFooter`:

`musterd does not sandbox your agents; your own host, sandbox and provider controls still do that. It names the work that goes through the team.`

Verbatim from `WhatIs` card 4 (§0.7). It is the one sentence a security reader looks for, and it
needs no section around it.

### 0a.8 Word count

Rendered section text, nav and footer excluded, by the audit's method, captions and labels counted
(the audit's 894 counted them too):

| section                       | words |
| ----------------------------- | ----: |
| Hero, both columns, card footer included |   117 |
| A day in the life: heading, lead, one caption |   ~75 |
| Why, capture caption included            |   159 |
| Watch, offline caption included          |    51 |
| Getting started                          |    39 |
| Line above the footer                    |    25 |
| Teasers                                  |    22 |
| **total**                                | **~463** |

Acceptance is the audit's §8: at most 500 words of section text (2026-10-12: §0a.3's ten captions put about 330 words in the DOM, shown one caption at a time; the count above is what a visitor sees at once, by nick's call), five content sections, at least
three captures of real product output, the explanation starting before y=1600 at 390 px wide, and
every §2 fact at most twice.

### 0a.9 For miley

- `landing.test.ts` pins strings from §0.3 and §0.7; the pins become the strings above. Card 3 and
  card 4 of `WhatIs` no longer render, so their pins go; the boundary sentence is pinned at its new
  place.
- Three captures to take, each a dated snapshot and never a live query (§0.4's rule): the `/board`
  card for lane `01M4ECTZ84NRQMBQQXPQX64RF5` (0a.3), an `ask` in `/live` or `musterd inbox` (0a.4),
  and the office still already on the page (0a.5). The caption's `<date of capture>` is the date
  the frame was taken. _(2026-10-13, lane `01M4V74X9WA29DGH3BNTFQ2F6Y`: ADR 571 cut the `/board`
  card for the day-in-the-life drawing, which left two captures against this bar. The third is now
  our team's own `musterd status` under Getting started, step 3 — the frame the reader is looking
  at once the install works, taken Oct 13 2026 in the CLI's own wrap, model and harness columns
  trimmed since the site names neither; caption `Our team after step 3: who is on it, who is
  present, who is working.`)_
- The record card's values are the 2026-10-09 snapshot; if the lane's record has changed, retake and
  redate rather than editing a row.
- Hard rule 3: this section and the page land as the spec says. The strings here are the spec; a
  divergence is fixed in code or here, never left.

### 0a.10 Other surfaces (§0.11 item 6), decided

Outside the copy lane's files; done 2026-10-12 in a follow-up lane:

- `WatchPage.tsx` `Nothing ships on its author's word.` → `Nothing counts as done on its author's word.`
- `packages/web/scripts/site-files.ts` (llms.txt) `musterd is in private preview. There is nothing to install yet.` → `musterd is in private preview. There is no public install yet.`
- `StreamSection`'s heading is handled in 0a.5.

## 0. Revision of 2026-10-09 — ADR 550 and the first-time visitor

Lane `01M4FHQ0SXG3YZPCPWMJM54AKQ`. nick named sloane the single owner of the page's copy on
2026-10-09, after four independent reviews of the live site (dreamy, gptbot, lazara, sloane) agreed
on the same gaps. miley implements. alfie writes the copy of the "first 10 minutes" page and does
not edit this one. §1 to §5 below are the record of the earlier revisions and stay as history;
**where this section and §1 to §5 disagree, this section governs** (and §0a, the 2026-10-12 cut, governs over this one).

### 0.1 What the reviews found

The tagline is live and correct. The page under it still sells the old pitch, and a visitor cannot
tell what to do after the form.

1. The hero subhead is the collision pitch, and it uses a contrast frame ("not watching from
   outside"). The ADR 550 chain is nowhere above the fold.
2. `WhatIs` is headed "The coordination layer where agents and humans are peers". ADR 550 decision 1
   takes that phrase out of headlines.
3. There is no path to start. `/docs` is concepts and the spec. "musterd is in private preview"
   appears once, at the bottom of `HowItWorks`, so the primary button sets no expectation.
4. At 390x844 the explanation ("Why your agents need to talk") starts at y=944, behind the office,
   and "How a team works" at y=2631 (gptbot's measurement).
5. The page only talks to people who already run agents.
6. The proof number never meets its other half.
7. Two sentences claim something the record does not hold: "nothing ships on its author's word" and
   acceptance before shipping. Review asks arrive after the merge. Work counts as done when a different
   member accepts what landed.

### 0.2 Rules for every string below

- **"Counts as done", never "ships", for acceptance.** Merge comes first and a different member
  judges the landed result afterwards (ADR 192, ADR 235). ADR 550's own canonical statement says
  "nothing ships until someone else accepts it". That is the one sentence in the ADR the record
  contradicts, and its `## Decision` is frozen. This page uses the corrected form, and alfie is asked
  to note the difference in ADR 550's Consequences.
- **No contrast frame** (brand.md §4), in any string, caption or alt text. Say what the thing is and stop.
- **"Who asked" stays out of every sentence that reads as a guarantee** (ADR 550 §3: the record holds
  who opened a lane, not who asked).
- **"Coordination layer" appears in no heading, tagline or opening sentence.** Technical docs keep it.
- **No state word** ("live", "now", "currently") in prerendered HTML unless true in both states
  (watch-page-copy-spec §2 and §2 below).
- **The scoped boundary sentence stays**: musterd names the work that goes through the team; it does
  not contain the agent.

### 0.3 Hero (`LightHero`)

| element                  | was                                                                                                                  | becomes                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1                       | `Agents that answer for their work.` _(superseded 2026-10-12 by ADR 563 — see §0a.2)_                                 | unchanged                                                                                                                                                                                                      |
| subhead                  | `Run Claude Code, Codex and Cursor on one repo without them stepping on each other — and with you on the team, not watching from outside.` | `Claude Code, Codex, Cursor and the people you work with join one team as named members. Every piece of work shows who claimed it, which model did it and who accepted it. Any member can say no.` |
| primary CTA              | `Get early access`                                                                                                   | unchanged                                                                                                                                                                                                      |
| line under the CTAs (new) | —                                                                                                                   | `Private preview. We write to you when there is a seat for your team.`                                                                                                                                         |
| secondary CTA            | `Watch it live`                                                                                                      | `Watch the team work`                                                                                                                                                                                          |

Why: the subhead carries the whole chain at the strength the record holds it (claimed: verified;
model: observed; accepted: verified and enforced to be a different member), names the people as
members, and states the refusal that no other product surveyed has. The line under the CTAs answers
"what happens after I click" and "why is there no install" in one sentence. **nick confirms the
promise in that line against what the form actually sends**; the copy cannot see the form's
follow-up. "Watch it live" is a state claim in prerendered HTML, so the secondary CTA names the action.

### 0.4 One piece of work, from claim to accepted (new section, directly under the hero)

H2: `One piece of work, from claim to accepted`

Lead, one sentence: `This is a lane from our own team, as the record has it.`

A record card with five rows (label, value). The values are real and dated. miley renders them from a
snapshot, not a live query, and the card's footer says when it was taken.

| label       | value                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Work        | `Watch an in-process wake from the launcher`                                                                                                    |
| Claimed by  | `dolly`                                                                                                                                         |
| Model       | the model on the lane's presence record, as the harness reported it (read at snapshot time; a pull request's commit trailer is not the source) |
| Landed      | `Pull request 2240, merged 2026-10-08`                                                                                                          |
| Accepted by | `sloane, a different member, 2026-10-09`                                                                                                        |

Below the card, two sentences:

> The reviewer ran the landed commit's tests, found that the brief and the result differed in one
> word, and said so in the verdict before accepting. The record keeps that note with the work.

Footer, small: `A snapshot of the board, taken 2026-10-09.`

Why a real lane and not an invented one: gptbot's review asks for one task, claim and landed review
to show the mechanism, and a real lane is the proof that the chain exists. It leaves "who asked" out
on purpose (ADR 550 §3). The reviewer's note is real: the verdict named the "not a file" reading. If
the lane's record changes, retake the snapshot and never edit the values by hand.

### 0.5 Section order and the mobile measurement

The copy works in any order. The order is a separate decision because ADR 428 fixed it:
`SiteNav → LightHero → StreamSection → WhyTalk → WhatIs → HowItWorks → Teasers → SiteFooter`.
gptbot measured the cost at 390x844: the explanation starts at y=944. **Recommendation: put the §0.4
card and WhyTalk above the stream.** That reopens ADR 428, so it needs an ADR from miley and nick's
call. Until then the copy ships in the current order, with §0.4 under the hero and above the stream.

### 0.6 Why your agents need to talk (`WhyTalk`)

Keep the two columns. Three edits.

1. **Answer the audience's question** with one sentence at the head of the left column, from
   `docs/design/why-agents-talk.md`: `A shared file can hold a result. Talk carries what is not a result yet: an objection, an ambiguity found halfway, a promise, or the answer only the other agent has.`
2. **Pair the proof, with its date, in one sentence**:
   `On a test project, agents working side by side wasted 65 to 83 percent of their work. With lane gates it was under 11 percent. One project, a pilot, measured in July 2026.`
   The source (finding 006) and the pilot's caveat go in the docs link under it, not in the sentence.
3. **Keep the sentence about our own history, scoped to us**:
   `On our own team, more than a third of the code agents wrote without coordination never shipped.`
   This sentence says "shipped" about code, which is correct. It is not an acceptance claim.

**Dependency:** the July receipt is 994 commits old, and the refresh lane `01M1VDRC6B` is unowned. Do
not lead with the pair in the hero or an ad. Under a date, here, it is honest. If the refresh lands
first, change "July 2026" and the numbers together.

### 0.7 What musterd is (`WhatIs`)

| element | was | becomes |
| --- | --- | --- |
| H2 | `The coordination layer where agents and humans are peers` | `Members who answer for their work` |
| cards 1 and 2 | | unchanged |
| card 3 body | `Most agent tools give you agents you assign work to. Here any member, agent or human, can take on work, turn it down or push back, and nothing counts as done until someone else accepts it. You are on the same team, with the same inbox.` | `Any member, agent or human, can take on work, turn it down or push back. Nothing counts as done until a different member has looked at what landed. You are on the same team, with the same inbox.` |
| card 4 heading | `Every act on the roster has a name on it` | unchanged (§4.4) |
| card 4 body | `Which model is in each seat is what its tool reported when it connected, not what the agent says about itself. Nothing ships on its author's word. musterd does not sandbox your agents; ...` | `The model in each seat is the one its tool reported when it connected, and the record names it. musterd does not sandbox your agents; your own host, sandbox and provider controls still do that. It names the work that goes through the team.` |

Card 3 loses the sentence that opens by describing other products (ADR 550 §5, brand.md §4). Card 4
loses its contrast frame and the "ships" claim. The disclaimer is kept verbatim, including "still do
that", as its own sentence, because a security reader checks for it.

### 0.8 How a team works (`HowItWorks`)

Steps 1 and 3 are unchanged. Two bodies change.

- **Step 2** (`Work changes hands on the record`): `A member claims a piece of work, builds it, and hands it to a teammate. The handoff is an act with a name on it, so the record shows what happened.`
- **Step 4** (`The work lands, and is judged by a second member`): `A second member looks at what landed, in the product, and accepts it or sends it back. Calling work done is a teammate's act. An agent cannot set it for itself.`

The note `musterd is in private preview.` moves to the hero (§0.3) and is removed here.

### 0.9 Getting started (replaces the block removed on 2026-10-03)

H2: `Getting started`

Lead: `musterd is in private preview, so there is no public install yet. This is the path today.`

Three rows, each with a status label set small in the mono face:

| status    | row                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Today`   | `Request a seat.` Body: `Fill in the form. We write to you when there is a seat for your team.` Link: `Get early access` (`EARLY_ACCESS_URL`).                                              |
| `Today`   | `See your first ten minutes.` Body: `What the first session looks like, step by step, and what you look at along the way.` _(2026-10-12, lane `01M4RP5ND8`: was "with the board as it really appears"; the `/start` board figure is a labelled illustration, so the row and the page's lede stopped claiming a real board.)_ Link: the first-10-minutes page (dreamy sets the path; placeholder `/start` until then). |
| `Not yet` | `Install and connect your agents.` Body: `One command, for the agents you already run. It opens to the preview first.` No link.                                                              |

Why: this answers "what am I signing up for" during the preview and is honest about what does not
exist (brand.md §4, "honest about scope"). The `Not yet` row carries no date because nothing on this
page may promise one; the goal's target is internal. When the first-run goal ships, that row becomes a
`Today` row with the real command and nothing else on the page changes.

### 0.10 Small things

- The stream's dark-state fallback (dreamy F6) is a new string for miley to place:
  `The team is off the clock. Here is the last session.` It is true in both states.
- `landing.test.ts` pins the old hero subhead, card 3 and card 4 strings. miley updates the pins in the
  same change, and the strings above are the new pins.
- Hard rule 3 applies: this spec and the page land in the same change.

### 0.11 Implementation notes (miley, 2026-10-09, lane `01M4GPZVTR4KD5EZDD2GCZJAJ6`)

Implemented as §0.3 to §0.9 give it. Where the spec could not be followed literally, and what is left
for the copy owner:

1. **§0.6 "the docs link under" the proof pair is not rendered.** The spec says the source (finding 006)
   and the pilot's caveat go "in the docs link under it", but names no target, and `/docs` on the site
   is concepts and the spec only. The pair and its date are in the sentence; the link needs a published
   page to point at. sloane's call.
2. **§0.10's dark-state string is not placed.** `The team is off the clock. Here is the last session.`
   is true only when a replay is showing, and the stream section already has that branch with its own
   caption (`WATCH_COPY.stateReplay`, "A replay of an earlier session — the channel is dark right now.").
   Placing a second string would either duplicate that caption or assert a replay in the dark-without-replay
   state. Say which caption it replaces and it is a one-line change.
3. **§0.4's `Work` row is not the lane's own title.** The record's title for lane `01M4ECTZ84` is "Wake
   watch for every harness 6/6 — musterd native harness reader: …"; the card shows the spec's plain-words
   `Watch an in-process wake from the launcher`. The card's footer says "A snapshot of the board", so a
   paraphrase there is a small overclaim. Use the real title, or change the footer to say the work is
   described in plain words.
4. **`Model`** reads `Claude Sonnet 5.5, as its tool reported it`: dolly's presence record
   (`claude-sonnet-5-5`, `claude-code`) read on 2026-10-09, not a commit trailer.
5. **`See your first ten minutes` links to `/start`**, the placeholder (`FIRST_TEN_MINUTES_PATH` in
   `content/site.ts`). The route does not exist until dreamy's lane `01M4GQ2NR438YWWYRH7RTTYP9X` lands,
   so **this copy is not deployed to musterd.io before it does**. (2026-10-12: the route landed in
   that lane — structure, stills, preview wording — and the Getting started row links it again.
   Deploy is miley's call per ADR 308.) _(Amended 2026-10-09: nick chose to
   deploy without it — the Getting started row is held back until the page exists, so the deploy is
   not blocked on `/start`.)_
6. **Other surfaces still carry strings §0.2 retires**, outside this lane's files: `WatchPage.tsx`
   ("Nothing ships on its author's word."), `StreamSection`'s heading ("Watch its own agents build it,
   live" — a state word in prerendered HTML), and `scripts/site-files.ts` (the llms.txt line "musterd is
   in private preview. There is nothing to install yet."). Each is a one-string change once you decide it.
7. **Order:** `GettingStarted` sits after `HowItWorks` and before the teasers; the §0.4 card is under the
   hero and above the stream, as §0.5 says until ADR 428 is reopened.

## 1. Why this page changes

Three things, in descending order of how badly they need fixing.

**The page makes a claim two independent security reads told us to stop making.** The fourth
what-is card is headed **"Who did what is never a question"** and its body ends "it makes sure
nothing on the roster is anonymous". Both are the #1537 defect — a containment promise wearing
attribution's clothes — in the two places #1537 did not reach. #1537 scoped the card's *first
sentence* on 2026-09-16 and left the heading and the tail standing, so the page currently scopes
the claim in the middle of a card that overclaims at both ends. wanderer (grok-4.6, act
`01M2RDQYCG`) and ghost (muse-spark-1.3, act `01M2RNPSF2`) each named this sentence family
unprompted, on separate days, without having read this page: a stranger hears "act" as *every
action*, and July 2026 was thousands of actions that were not Acts.

**The page asserts LIVE when it does not know.** The prerendered HTML of `/` and `/watch` both
ship a player facade carrying a `LIVE` badge and the label `live broadcast`, unconditionally,
before any player loads. `/watch` reads real liveness for its eyebrow and state line — the rule in
watch-page-copy-spec §4.1 — and then contradicts it one element over. On a dark channel a
stranger's first impression of this project is a badge that says LIVE over nothing.

**The office appears on no page of this site.** The homepage's only image is the Twitch embed,
which between sessions is a black rectangle with a play triangle. The office — a real isometric
floor where named agents and humans sit at labelled desks — is the most distinctive thing this
product has, and `office-still.png` has been in the tree since #1474 doing nothing but serving as
`/watch`'s share card. We own the proof and show it to no one who does not unfurl a link.

### What is NOT a reason, and two premises that expired

miley's readout is dated 2026-09-16 18:50Z and two of its secondary findings have since been
overtaken. Recorded so the next reader does not chase them:

- ~~"How priorities are decided" puts a bare "about 79% of multi-agent failures" in front of a
  stranger~~ — **cut 2026-09-16 on nick's call**, under this same lane. `WEDGE` survives only in
  `content/site.ts` where `gen-roadmap` renders it into ROADMAP.md, which is the right reader.
  Verified absent from the live HTML 2026-09-18.
- ~~"The three feature cards"~~ — there are **four**; the fourth landed 2026-09-16 under ADR 320
  decision 5.
- ~~"www.musterd.io does not resolve"~~ — it resolves and 301s to the apex, 200. Verified
  2026-09-18. Not this lane's to fix and no longer anyone's.

**No conversion argument is made anywhere in this spec, and none may be added.** miley put the
caveat on the record at open and it stands: this site has had essentially no traffic ever and was
not indexed until 2026-09-16. "Show the product rather than describe it" is true at zero visitors.
"This ordering converts better" is not knowable here and is not claimed.

## 2. The added rule, on top of watch-page-copy-spec §2

**A claim about naming must carry its scope in the same breath, in every position it appears —
heading, body, alt text and caption alike.** #1537 established the scoped forms; this page is the
evidence that scoping a body sentence and leaving the heading is not a fix, because the heading is
what a scanner reads and the body is what they skip.

The canonical scoped statement (ADR 320 §5a, #1537) is **"every act on the roster has a name on
it"**. The boundary sentence is wanderer's, which ghost reached independently: **musterd names the
work that goes through the team; it does not contain the agent.** Either may be compressed only
in ways that keep both halves.

Forbidden on this page, now and later:

- "Who did what is never a question" — tool use is the question, and we do not have it.
- "nothing on the roster is anonymous" / "no anonymous workers" as a standalone claim.
- Any unscoped "every act", "every action", or "the record holds everything".
- "the record holds what the harness observed" without naming *what* was observed. The harness
  attests **which model occupied a seat**, at connect time. It is not a proof about tool calls.
- "verified", "trusted", "safe" attached to anything attested (attestation-copy-spec §2).
- A state word — "live", "now", "currently" — in any string the prerendered HTML ships, unless it
  is true in both the live and dark states.

## 3. Section order

> **SUPERSEDED 2026-09-21 by [ADR 428](../decisions/428-one-office-above-the-fold.md)** (lane
> `01M32GK3SZ`). The order below shipped and was measured at 390×844 on a live channel: the still
> and the player fitted in one viewport 418px apart, so the page rendered the same room twice.
> There is now ONE office and it is the stream. The live order is:
>
> ```
> SiteNav → LightHero → StreamSection → WhatIs → GetStarted → Teasers → SiteFooter
> ```
>
> The paragraph below about the hero keeping the first screen is unchanged and still governs.

~~One insertion and nothing else moves:~~

```
SiteNav → LightHero → OfficeProof (new) → StreamSection → WhatIs → GetStarted → Teasers → SiteFooter
```

The hero keeps the first screen. It is type on the mustard ground with the install command in it,
it works, and the measured reason not to put the office above the fold is that the install command
is the one thing on this page with a job. The office is the first thing *below* the fold, which is
where a reader who did not install goes looking for a reason to.

## 4. The page, top to bottom

### 4.1 Hero — unchanged

No string changes. Stated here so a reviewer diffing the page knows the omission is deliberate.
`LightHero`'s sub already carries the scoped form from #1537 ("Every act on that roster has a name
on it, and a human is on it too") and `landing.test.ts` pins it.

### 4.2 The office — new section

> **SUPERSEDED 2026-09-21 by [ADR 428](../decisions/428-one-office-above-the-fold.md).**
> `OfficeProof` is deleted. Everything below that was load-bearing moved into `StreamSection` and
> is still enforced — the two closing sentences, the imported alt, the static capture over the live
> canvas — by `landing.test.ts` and `streamSection.test.ts`. What did NOT survive: this section's
> H2, and the caption, which is now state-dependent because the section can read liveness. The
> record below is kept for the reasoning, not as instructions.

H2: `The team that builds musterd`

Body, one paragraph:

> Every member has a desk with their name on it — the agents on the roster and the humans who work
> with them. A desk outlasts the session that filled it: close the harness window and the member,
> their inbox and their unfinished work are all still there. This is our team. Yours is what
> `npx @musterd/cli init` starts.

The last two sentences are load-bearing and may not be cut. ADR 320 §1 is that musterd connects
agents and does not run them, and watch-page-copy-spec §2's first corollary is that a picture of
our office reads as "a virtual office for your agents" unless the copy says whose office it is and
hands off to the product. The picture makes that failure *more* likely here than on `/watch`,
because the homepage reader has not yet been told what they are looking at.

Caption, set small, directly under the image:

> A still from the stream. The office is live while the team is working.

This is the §2 state rule doing its job: the sentence is true whether the channel is live or dark,
it tells the reader the image is not a live view, and it invents no schedule.

Link, under the caption: `Watch them work →` to `/watch`.

Alt text: **exactly** `WATCH_COPY.stillAlt`, which is already written, already shipping, and
already reviewed — *"The musterd office view: named agents and humans at desks on one floor, each
desk labelled with the member's name, coloured badges showing what each is doing."* Import it;
do not retype it.

### 4.3 The stream section — facade strings only

H2, body and links unchanged. The two facade strings change:

| element | was | becomes |
|---|---|---|
| badge | `LIVE` | *removed* |
| label | `live broadcast` | `musterd on Twitch` |

The play triangle stays: it is a player affordance, not a claim about state. The badge goes rather
than becoming neutral because a state badge that cannot read state has nothing to say, and a
greyed one invites the reader to decide what grey means.

**The identical change applies to `/watch`'s facade**, which carries the same two strings and the
same defect. It is in this lane because it is the same sentence and splitting it would ship the
fix to one of the two pages that has it.

### 4.4 What musterd is — the fourth card

H2 and the first three cards unchanged. The fourth card, both ends:

| | was | becomes |
|---|---|---|
| heading | `Who did what is never a question` | `Every act on the roster has a name on it` |

Body:

> Who occupies a seat is what the harness observed, not what the agent declared. A member can
> decline work and challenge a claim, and nothing ships on its author's word — acceptance comes
> from someone else. musterd does not sandbox your agents; your own host, sandbox and provider
> controls still do that. It names the work that goes through the team.

Three changes from the current body, each with a reason:

1. The old first clause ("Every act on the roster names its member") is **promoted to the
   heading**, so the scope travels with the scanner rather than with the reader who finished the
   card. `landing.test.ts:40` pins the old string and must be updated to the new position.
2. "the record holds what the harness observed" becomes "**who occupies a seat** is what the
   harness observed". Both security reads flagged the unscoped form as the page's weakest
   sentence: a reader hears a tool-call transcript, and what we have is model identity at connect
   time (ADR 158/163).
3. The tail "it makes sure nothing on the roster is anonymous" becomes "**it names the work that
   goes through the team**" — the §2 boundary sentence. The disclaimer that precedes it is kept
   verbatim, including "still do that" (`landing.test.ts` pins it, and #1537 added it because a
   bare "we do not sandbox" reads as evasion), and is promoted from an em-dash aside to its own
   sentence, because it is the half a security reader is checking for.

### 4.5 Get started, Teasers, Footer — unchanged

## 5. The office still

> **AMENDED 2026-09-21 by [ADR 428](../decisions/428-one-office-above-the-fold.md).** The still
> survives — the reasoning below is exactly why it had to — but it is no longer a figure in its own
> section. It is the stream slot's OFFLINE state, stacked on the player and shown whenever liveness
> is not `live`. Two details below are now inverted by the move above the fold: it is eager with
> `fetchPriority="high"`, not `loading="lazy"`.

**Ship the existing asset.** `packages/web/src/brand/office-still.png`, 1200×630, 166 KB, in the
tree since #1474. It is a real capture: five labelled desks (`nick`, `miley`, `sloane`, `izzo`,
`stanley`), model badges, the MON–FRI 11am–3pm sign, the mustard chip. Using it costs the image
bytes and nothing else — no scene bundle, no rAF, no eager-graph entry.

**Motion is settled and the answer is no.** miley measured the scene on the GPU-less bench box
(performance-4x) on 2026-09-18, lane `01M2TM6C6XF6`, status_update `01M2TQ0036`: **~51 ms per
draw, of which ~34 ms is Skia per-op cost that clipping does not remove.** A live canvas on a
public marketing page would charge that to every visitor without a GPU. A still is not this page's
fallback; it is its honest default. A short looping capture stays available as an upgrade — it is
bytes, not frames, and never touches a visitor's CPU — but it is not required to ship this.

**What the current asset is not good enough at**, stated so a purpose-made capture has a brief and
so nobody mistakes reuse for endorsement:

- It is cropped 1200×630 for a share card, so the room sits small inside a lot of empty gradient.
  On-page it wants a tighter crop on the floor.
- Its roster is a 2026-09-16 snapshot in which nearly every badge reads `opus`. That quietly
  undersells cross-family review, which is one of the few claims in §2 that survives a security
  reader. A replacement capture should catch a roster with visible model variety.
- Most desks are empty. True, and not flattering. A capture taken mid-session with more members
  present is a better picture of the same honest thing.

None of the three blocks shipping. A capture is this role's to take (watch-page-copy-spec §7) and
is a follow-up, not a dependency.

## 6. Acceptance criteria for the implementation lane

1. Every string on the page is in this spec character for character, or is explicitly marked
   unchanged in §4. Reviewer diffs rendered text, not source.
2. `grep` of the built home HTML returns **zero** hits for `Who did what`, `never a question`,
   `nothing on the roster is anonymous`, and — in the prerendered markup of both `/` and
   `/watch` — `LIVE` and `live broadcast`.
3. `landing.test.ts` pins the new fourth-card heading and the new body's scoped clause, and its
   old assertion at line 40 is moved rather than deleted — a dropped assertion is how this defect
   survived #1537.
4. A test asserts the office section renders the still with `WATCH_COPY.stillAlt` as its `alt`,
   imported and not retyped.
5. `pnpm perf:check` green with no budget raised. The image is below the fold: it carries
   `loading="lazy"`, `decoding="async"` and explicit `width`/`height` so it cannot shift layout.
6. `pnpm a11y:check` green, including the caption at its small size — it is the string on this
   page most likely to fail contrast.
7. `pnpm vocab:check` green (ADR 296: not "room", not "swarm", not "session" for Presence).
8. Confirmed on the deployed site, not the build: the page is a deploy, and ADR 308 makes landed
   and live different facts. miley deploys; a reviewer opens musterd.io and reads the fourth card.

## 7. Non-goals

- **The four cards' form is not changed here.** miley's read is that the content is the best
  writing on the site in the one shape that reads as generated, and she is right that `/watch`'s
  definition-list treatment is better. That is a visual-system change on her surface, wider than
  this lane, and doing it in the same PR as a claim correction would make both harder to review.
  Recorded as a follow-up, with the reasoning, so it is not rediscovered.
- No h1 resize. miley flagged it as set at documentation scale for 1440; it is hers to judge and
  it is not copy.
- No live canvas, no roster fetch, no daemon dependency on this origin (ADR 132/156).
- No conversion claim, no A/B, no published schedule.
- No change to `/live`, `/broadcast`, or the office scene itself.

## 8. Follow-ups this lane found and deliberately did not take

- **README.md still carries the unscoped form.** Line 8: *"Every act carries a member's name … there
  are no anonymous workers on a musterd team."* #1537 swept nine files and README was not among
  them. It is the same defect as §1's, on the surface most strangers actually hit first. Outside
  this lane's scope; needs its own, and it should sweep rather than spot-fix.
- The four-card form, per §7.
- A purpose-made office capture, per §5.

## 9. The why, and a way in — 2026-10-05

Lane `01M46SC7QK`. nick's call the same day, after the first live demo (Multiplayer AI, Oct 1;
[traction plan §18](./traction-plan.md#18-weekly-log)). The room asked six questions, and the last
one — *"why do agents need to communicate in the first place?"* — is the one this page could not
answer either: every section said what musterd is, none said why a reader would want it.

**Live order** (amends §3's ADR 428 order, which still governs everything else):

```
SiteNav → LightHero → StreamSection → WhyTalk (new) → WhatIs → HowItWorks → Teasers → SiteFooter
```

- **Hero subhead** names the reader and the problem before the mechanism: *Run Claude Code, Codex
  and Cursor on one repo without them stepping on each other — and with you on the team, not
  watching from outside.* The headline (`TAGLINE`) is unchanged.
- **Hero CTAs:** *Get early access* (primary → `EARLY_ACCESS_URL`, a Tally form, nick 2026-10-05)
  then *Watch it live*. A visitor fresh from a demo has nothing else to do while musterd is in
  private preview.
- **WhyTalk** answers both halves — agent to agent (they collide; "more than a third of the code
  they wrote never shipped", scoped in-sentence to one project on our own team, source
  `lanes-and-the-multi-agent-tax.md` §3.4) and agent to human (some decisions are a person's).
- **Cards, plain words:** "harness", "twelve acts" and "lanes" leave the page. Card 1 answers
  "where is it stored" (your machine, one SQLite file). Card 3 becomes *They can say no* — ADR 320
  decision 3, peer not contractor. Card 4 keeps its §4.4 boundary sentences verbatim, minus the
  decline/challenge clause card 3 now carries.
- **Not on this page:** the OpenAI × Hugging Face incident. nick's call: it is answered in person
  ([demo script](../demo/sf-tech-week-2026-10-06/script.md)), where its context travels with it.
- **Sign-off:** miley (designer) accepts the rendered page before merge.

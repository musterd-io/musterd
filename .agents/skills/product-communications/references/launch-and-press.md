# Launch and press: announcements, Hacker News, press, landing pages, social

Open for any announcement, launch, Show HN, press release or pitch, landing
page or social post.

## Before any headline: mine the reader's words

Read what our readers already wrote, line by line, without summarizing: issues,
PR threads, teammates' feedback, design-partner notes (with consent), public
threads about the problem. Tag the phrases that repeat. The headline comes from
those phrases, in their words. This is Joanna Wiebe's message mining
([Wistia interview](https://wistia.com/learn/marketing/joanna-wiebe-conversion-copywriting)).
Record where each phrase came from (`references/research.md`, quoting rules).

Then name the reader's awareness stage. A reader who has never felt the problem
needs the situation first ("you run two agents on one repo"); a reader comparing
tools needs the command first. The stages are Eugene Schwartz's, read here only
through summaries ([Optimize Smart](https://optimizesmart.com/blog/schwartz-five-stages-of-awareness-in-marketing/)).

## Size the announcement to the change

- **Major** (new capability, new surface): launch post, README and docs update,
  social copy, a demo asset. All six sweeps.
- **Medium** (new integration, meaningful improvement): short announcement and a
  changelog entry.
- **Minor** (fixes, small tweaks): a changelog line. Its job is to show the
  product is alive.

Every announcement says what changed, what it lets the reader do, how to try
it (the exact command), and what is still not there. Phased releases are fine;
never call a phase more than it is.

The engineer who built a feature usually writes its launch content at Supabase
([how Supabase launches](https://supabase.com/blog/2021/11/26/supabase-how-we-launch)).
Our version: the comms seat writes from the building seat's PR, ADR and lane, and
asks that seat to check every claim.

## From shipped work to an announcement

The weekly pass, after coreyhaines31/marketingskills' shipped-changes workflow:

1. **Collect** the window's merged PRs (`gh pr list --state merged --search
   "merged:>=<date>"`), the lanes resolved in it, and anything merged without a
   PR (`git log --since=<date> --no-merges --oneline origin/main`). PR bodies and
   lane details say why; commit subjects rarely do.
2. **Keep what a user can use today.** A change behind a flag, unmerged, or
   unreleased on the install path waits.
3. **Translate each change into one line:** "You can now …" or "… no longer …".
   A change that fills neither (a refactor, CI, a test) gets no announcement.
4. **Size it** with the major / medium / minor tiers above. Several medium
   changes on one theme can make one major story.
5. **Ground every line in the change.** A number comes from the PR itself (a
   measured run, a benchmark in its body) with a ledger row. A PR that says
   "increment 1" makes an announcement that says the same.
6. **Check for claim drift.** A shipped change can make an existing sentence
   false: on musterd.io, in the README, in `docs/demo/pitch/`, in
   `docs/design/landscape.md`. List each one with the file and the fix.

```
## Shipped <YYYY-MM-DD>–<YYYY-MM-DD>
For users
- [major]  You can now … (#<pr>, lane <id>)
- [medium] You can now … (#<pr>)
- [minor]  Fixed … (#<pr>, #<pr>)
Changelog entry (docs-and-a11y.md §3 format)
Drafts: post / social / in-product copy spec, one per major or medium line
Now wrong: <file>: <sentence> → <fix>
```

Drafts are staged for a human to read and send (hard rule 6).

## Hacker News and other developer forums

Hard rule 5. HN's guidelines: "Don't post generated text or AI-edited text"
([HN guidelines](https://news.ycombinator.com/newsguidelines.html)). dang's Show
HN advice, edited 2026-03-28: no LLM for any of it, including to edit
([HN item 22336638](https://news.ycombinator.com/item?id=22336638)).

For a Show HN you write a **source pack**, and nick writes the post from it:

1. What it is, in one sentence.
2. The try-it command, with no signup on the way ([Show HN rules](https://news.ycombinator.com/showhn.html)).
3. Backstory as questions for nick to answer in his own words (why he built it,
   what broke first). Never draft the answers.
4. What is different, each point linked to its PR or ADR.
5. Known limits, plainly.
6. Likely questions with true, short answers (reuse `docs/demo/pitch/script.md`'s
   questions to expect).

Treat Lobsters and developer subreddits the same way by default. No primary rule
was found for them; the caution is ours.

## Launch week run sheet

From Supabase's documented method: a fixed date with flexible scope, one launch a
day, a timed run sheet per day, press lined up about three weeks out, a retro
after. Per day: the PR merged and deployed, the post, the changelog entry, the
social posts, the demo asset, who answers comments and until when.

## Press

A press release is a news document. If there is no news, say so and stop.

**Story angles.** Reporters write about trends, data, conflict and people; the
product is the evidence in the story. Most pitchable stories take one of these
shapes (after coreyhaines31/marketingskills' public-relations skill):

- **The founding story.** Why the team built it and what the numbers are now,
  told by the person who lived it. It is nick's to tell (hard rule 3).
- **The small team and the default.** A small team doing one thing the default
  way of working cannot. Name the one thing and show it.
- **A broken system.** A way of working the reader already resents, named
  precisely (agent work that lands with no record of who asked or who checked
  it). The target is always a system or a norm. Never name a competitor as the
  enemy.
- **A data story.** Our own dogfood record (lanes, acts, acceptance) packaged
  with its method as a citable number. Every figure carries its ledger row and
  its denominator.

A milestone alone is not a story. Attach it to one of the shapes or keep it for
the changelog.

```
FOR IMMEDIATE RELEASE / EMBARGOED UNTIL <date> <time> <timezone>
Headline — sentence case, the core news
Dateline — Lead: who, what, when, where, why, how in 25–35 words (count them)
Body 1 — expand the lead; the main data point
Quote — a named person saying something with content
Body 2 — context; availability; how to try it
Boilerplate — about musterd, ≤100 words; SandRise Studio as the maker
Media contact
###
```

Quality bar: 300–500 words, third person outside quotes, "said" as the
attribution verb, at least one checkable number, nothing from the hype list.

**The pitch email** carries the news; the release is linked as the backing
document. Under 200 words, one reporter at a time, tied to that reporter's beat,
one checkable number, the embargo as an exact time and timezone, one follow-up at
most. In Cision's 2025 survey of 3,000+ journalists, 86% reject pitches off their
beat and 72% still rate press releases the most useful thing PR sends
([Cision 2025](https://www.cision.com/about/press-releases/2025-press-releases/cisions-2025-state-of-the-media-report-reveals-a-tipping-point-for-trust-technology-and-pr-journalist-partnerships-302448410/)).
You draft both; a human sends (hard rule 6).

## When something goes wrong

A security incident, a data exposure, a broken release or a public complaint is
communications too. You draft; nick or the incident owner publishes (hard rule 6).
After coreyhaines31/marketingskills' crisis-communications reference:

1. **Facts first.** Write down what is confirmed, who is affected, whether it is
   contained, and what is already public. Every unconfirmed point is marked
   unconfirmed. A statement walked back later costs more than a slower true one.
2. **Size it.** Contained (reply where it was raised), visible (a short public
   acknowledgment), significant (a statement on the channel of record), severe
   (anything touching credentials, team data or security: the holding statement
   waits for the incident owner, and legal advice comes before any claim of cause
   or scope). When unsure, size up.
3. **Holding statement** within the hour: what we know, what we are doing, when
   the next update comes. Nothing about cause or scope that is not confirmed.
4. **Order of telling.** The affected people first, the team in parallel, then
   the channel of record (for a vulnerability, a GitHub security advisory as
   `SECURITY.md` sets out; otherwise an issue), then social
   posts that link to it. The press never hears before the people affected.
5. **Keep the cadence** you promised, even when the update is "still
   investigating".

Never delete criticism, speculate about scope, or apologize with a "but". "No
data was exposed" is the sentence most often walked back; it waits for the
person who can confirm it. Exposed secrets follow AGENTS.md hard rule 5 and the
security goal's rotation work.

## Landing pages

The pattern across 100+ devtool landing pages ([Evil Martians](https://evilmartians.com/chronicles/we-studied-100-devtool-landing-pages-here-is-what-actually-works-in-2025)):
a hero with a code or terminal visual; one specific primary call to action and a
lighter one (docs, GitHub); a trust block straight after the hero; feature
sections that each open on a user problem; a few short, real testimonials; one
closing call to action. Our order and strings are set in
`docs/design/homepage-copy-spec.md` and its ADRs; propose changes there.

Pre-launch, the trust block is our own record (lanes closed, the office live).
Never testimonials we do not have (hard rule 2).

## Narrative for a talk, a demo or a launch post

Andy Raskin's strategic narrative, read through summaries: name the shift in the
world, who wins and loses because of it, the promised land, the product's
capabilities as the way there, and evidence that it works
([Raskin, Medium](https://medium.com/the-mission/the-greatest-sales-deck-ive-ever-seen-4f4ef3391ba0)).
Nancy Duarte's alternative moves between what is and what could be.

Both lean on before and after, which brand.md §4 allows as story structure
(nick, 2026-10-13) on two conditions: the "before" is specific and true (the
reader's situation or our measured past), and it is shown as a scene. The
sentence-level ban still holds inside every scene. The standing deck's slide 2
is the pattern.

## Social posts (provisional)

No developer-specific evidence was found for X or Bluesky, and studies of
LinkedIn's link penalty disagree. Write each post to stand alone with its one
claim and its command or link, and record how our own posts do before adopting a
rule.

# a16z speedrun SR008 application, submitted 2026-10-30

> The record of what nick submits to [speedrun.a16z.com/apply](https://speedrun.a16z.com/apply) for
> SR008 (applications close 2026-11-01; the residency runs 2027-02-01 to 2027-04-16 in San Francisco;
> read from the form on 2026-10-26). Drafted by alfie with nick on 2026-10-26, read by sloane, ghost and
> wanderer the same day, and revised by alfie with nick on 2026-10-30. Personal fields (contact
> details, citizenship, education) are not recorded here. The pitch deck uploaded with it is [`../pitch/`](../pitch/README.md) as of #3344, rendered by
> its `build.sh`.

Every number below has a row in the sources table. nick re-runs `../pitch/counts.sh` and
`../pitch/chain.sh` on the day he submits and the submitted values are noted at the bottom of this
page then.

## The written answers

As submitted by nick on 2026-10-30. Counts were read that day by nick. How the text got here is under [What changed on 2026-10-30](#what-changed-on-2026-10-30) and [What nick changed in the form](#what-nick-changed-in-the-form-2026-10-30). Funding history and active fundraising round were left closed: the form's funding section requires a last-round date and a list of investors, and there are none; "self-funded" is said in Anything else instead.

**One-liner** (100 characters; 83)

> Agents that work as a team alongside you, for teams running several agents at once.

**Startup description** (800 characters; 779)

> Small dev teams now run several agents at once: Claude Code in one window, Codex in another, on the same repo. Each works alone. They build the same thing twice, overwrite each other, and lose their context when the window closes, and nobody can say which model did what. Before musterd had a board and review, 37 percent of what our own agents wrote never reached main.
>
> musterd puts the agents and the people they work with on one team as named members, in any tool. Work is claimed on a board, one owner at a time. A member can decline or hand off. Nothing counts as done until a different member accepts it, and the record shows who did it, who accepted it, and which model. In September that figure was 0.9 percent. Self-hosted is free and MIT; hosted cloud teams come next.

**Relevant experience** (1,000 characters; 994; nick's first person)

> I keep running into the same problem: people shipping fast while someone needs to know what shipped and who approved it.
>
> At Fannie Mae I started as a Project Analyst. I taught myself to program, shadowed engineers and took on work for tech teams outside my role until I became a Technology Engineer, then led a developer-tools team serving 220+ applications. Our biggest win: open-source package approval went from two weeks to an instant download, by building the approval into the download itself.
>
> After an MBA at UT Austin I was a PM at VMware. I launched a $300M ARR subscription for VMware Cloud on AWS with three engineering teams, then a launch that grew our U.S. government customer base 80% in two years.
>
> Since 2024 I've gone all in on AI: papers and launches every morning, a daily podcast I built to digest them (Exploring Next), and products built with every agent and model I could get. Running several agents on one repo brought the Fannie Mae problem back, so I built musterd.

**Tell us more about the team** (1,000 characters; 472)

> musterd is built on musterd: about two dozen agents, each a named member of the team, working alongside me since June.
>
> I work on the team too: I set the goals, and the agents bring me the questions that need a person, 336 in the last 30 days. I know the buyer because I am one: a PM who ships with agents and hit the collisions, the lost context and the unreadable history first. I am the only founder, full time, not yet incorporated, and open to a technical co-founder.

**Anything else we should know** (1,000 characters; a single-line field, so no paragraph breaks; 281)

> Watch the team build musterd live: https://www.twitch.tv/musterd_io. What the residency buys: by Demo Day, hosted musterd live with the first outside teams on it, and the first paying team. Self-funded so far; October spend was about $1,000 (model subscriptions, hosting, domains).

**Traction** (optional, 1,000 characters; 901)

> Built by a team that runs on it: 2,518 pieces of work closed, with activity on 111 of the last 121 days.
>
> On CooperBench, a public benchmark for two coding agents on one repo, we ran ten fresh pairs, pre-registered, in October: musterd's two agents produced no conflicting patches, 0 of 10, where CooperBench's own two-agent setups conflicted on 6 and 7 of 10.
>
> This month I demoed musterd live at two San Francisco events, and rebuilt the demo around the product between them. At the second, during SF Tech Week, agents on four different models picked up a request live and came back within minutes with questions and a design objection. Afterwards the hosts, the incubator EPIC Connector, told me the demo left a strong impression on their team and introduced me to their venture partner.
>
> Next, I'm looking for the first design partners, so team- and enterprise-level feedback shapes what we build.

## The other fields

| Field | Answer | Why |
| --- | --- | --- |
| Full-time or part-time | Full-time | nick, 2026-10-26 |
| Number of full-time founders | 0 | The form: "If you're part-time or not yet incorporated, enter '0'". There is no legal entity yet (nick, 2026-10-26); one is formed on acceptance or when a counterparty needs it |
| Total FTE | 1 | |
| Startup name | musterd | SandRise Studio is the maker, never the product brand (`docs/wiki/positioning.md`) |
| Primary / secondary category | Infrastructure / Dev Tools; B2B / Enterprise Applications | ADR 550 §4: builders first, knowledge work as the expansion |
| Where it is built | United States, San Francisco | |
| Founded | June 2026 | One date everywhere (nick, 2026-10-30): the first commit is 2026-06-09 and the answers say "since June". It was August 2026, the domain's registration month (`whois musterd.io` 2026-08-13), until that day |
| Product launch date (Traction) | June 2026 | Required once Traction is opened: "When did you first launch a working version to users?" `@musterd/cli` 0.2.0 was published to npm on 2026-06-22 (`npm view @musterd/cli time`) |
| Website | https://musterd.io | |
| Team video (MP4) | nick on camera, 2:14, in his own words, no cutaway; cut from his two Zoom recordings of 2026-10-30 (edit 10). The beats are [`video.md`](video.md) | The form's only video field is "Team Video (MP4)", optional, with no length or guidance (read 2026-10-30). speedrun's "What founders ask us before applying" (2026-10-07): "We just need you … talking earnestly about what you're building", no AI voice, polish not weighed. It is not a product demo; the 10-26 entry "the 2-minute demo" was alfie's, not the form's |
| Pitch deck | `../pitch/build.sh` output, 12 pages, uploaded | #3342 and #3344, 2026-10-26; the 2026-10-30 counts and slide 2's "before musterd had a board and review" from #3630 |
| Where did you learn about speedrun | Other: "Researching SF accelerators, incubators and residencies for the company." | nick, 2026-10-26 |
| Category; where built | Infrastructure / Dev Tools, then B2B / Enterprise Applications; San Francisco, California | |

## Sources

| Claim | Source, and when it was read |
| --- | --- |
| 37% never reached main before musterd had a board and review; 0.9% in September | The 37% is the P3 session of 2026-06-29/30 ([finding 001](../../research/001-telemetry-gaps-p3-dogfood.md)), when four agents already talked over musterd but no lane, board or review existed yet; so "before musterd" was wrong and the text says what was missing (fifty and lazara, 2026-10-30). `../pitch/script.md` sources row for page 2: our own team's git history, a July read and one September read (finding 001's P3 post-mortem; ADR 462). The homepage pair (`docs/design/homepage-copy-spec.md`). The cookoff multiplier is held out of outbound copy and is not used |
| 2,518 pieces of work closed; 3,095 questions put to a member; activity on 111 of 121 days since 2026-07-02 | `../pitch/counts.sh` (the first two) and the ledger's daily-use query (the days), read 2026-10-30 by nick; 2026-10-20's read was 2,090, 2,329 and 101 of 111. "Pieces of work" are lanes in state `done`; "questions put to a member" are `ask` acts addressed to a member. The agent seats cannot read the database (ADR 658), so a person re-runs it |
| 180 of 1,454 review verdicts sent the work back; every verdict from a member other than the author | `../pitch/chain.sh`, run by nick 2026-10-30, 30-day window: 1,274 accept and 180 decline acts (2026-10-20: 118 of 1,123). The authoriser ratio is not in the application. A different member is enforced on the verdict (ADR 188, ADR 234); an owner's self-close is recorded unconfirmed (ADR 235) and is not a verdict |
| About two dozen agents; models from seven makers | The ledger's daily-use query, read 2026-10-30 by nick: 25 agent seats sent acts in the last 30 days. Acts were stamped with models from about fifteen makers plus unnamed stealth models; seven makers carry 50 or more acts (Anthropic, OpenAI, xAI, Muse, Google, MiniMax, Xiaomi), and the count is those seven, so a one-act trial is not counted (alfie's threshold, nick 2026-10-30). Said as "seven makers", not "families" (fifty). 2026-10-19: 23 seats, five families |
| More than 750 dated decision records | `ls docs/decisions/*.md \| wc -l` → 759 on 2026-10-30 (720 on 2026-10-26) |
| Repository public since 2026-10-12 | ADR 565 |
| The build is streamed on Twitch | `twitch.tv/musterd_io` (`docs/wiki/twitch-channel-audit.md`; the ledger row for the Twitch handle) |
| Spend in October about $1,000: model subscriptions, hosting and domains | nick, 2026-10-30 ("close to $1000"; it was about $500 on 2026-10-26). The line items are nick's 2026-10-09 list, `docs/superpowers/specs/2026-10-09-business-plan-design.md` ("What nick said"): Claude, OpenAI, Grok and Cursor subscriptions, two domains, fly.io, ubicloud, cloudflare, GitHub. |
| CooperBench (a public benchmark for two coding agents on one repo): 0 of 10 conflicting patches against 6 and 7 of 10 | [finding 023](../../research/023-cooperbench-coordination-run.md), 2026-10-23, pre-registered; its status line says the claim may be stated. Pass rate is [finding 021](../../research/021-cooperbench-claim-run.md), no claim (5 of 20 against 6 of 20 solo), and is not in the application; lazara, 2026-10-26: no run before 2026-11-01 can change that |
| VMware, Fannie Mae, degrees; Project Analyst to Technology Engineer; package approval from two weeks to an instant download; the morning reading and Exploring Next | nick's own resume (the titles and the component-management system) and his interview notes (the approval outcome), read 2026-10-30; the self-taught move into engineering, the reading habit and the podcast are nick's own account, 2026-10-30. Exploring Next is the daily podcast on sandrise.io; his record to state |
| 336 questions that need a person, brought to nick in the last 30 days | `../pitch/chain.sh` "Asks to people", 2026-10-30: 336 asks to nick, 235 answered. Not "calls only a person can make": an unanswered standard or advisory ask goes ahead on its timer (lazara) |
| A person's passkey on signing off a merge in their name, team policy and adding an agent | [ADR 662](../../decisions/662-one-machine-per-hosted-seat.md) human authority 1–3 (2026-10-19/20: the listed acts, `merged.authorized_by` among them, need the human's device signature once they have enrolled); [ADR 767](../../decisions/767-live-passkey-enroll.md), enrolment from `/live`. nick is enrolled and approves from his phone (nick, 2026-10-30). Not said: that a passkey lets work land; seats still merge their own PRs and the merge sign-off stays attested (ADR 665 §3) |
| People join from claude.ai, ChatGPT or Codex (this, "tool" and "agents" replace "harness" and "agent seats" for a reader outside the team, fifty and lazara); answer a teammate from the phone | Real-client CIMD acceptance (lane `01M3QQJENE`, claude.ai, ChatGPT and Codex); the phone app's pairing and asks ([ADR 761](../../decisions/761-live-pairing-qr.md), [ADR 759](../../decisions/759-app-pairing-turns-on-delivery.md)); on TestFlight, not the App Store, so no store claim. One clause only (nick: not a headline feature) |
| Two live demos in October; the second rebuilt product-first; four agents on four models came back within minutes with questions and a design objection; EPIC Connector's follow-up | Multiplayer AI, 2026-10-01 (`docs/design/traction-plan.md` §18, 2026-10-05 entry, and its retro); the EPIC Connector Afterparty during SF Tech Week, 2026-10-09, the event the repo calls Demo Day ([`../demo-day-2026-10-09/`](../demo-day-2026-10-09/README.md); run 3 in its `rehearsal-log.md`: first reply 0:57, wanderer's design objection at 2:19). The follow-up is an email to nick from EPIC Connector's co-founder and COO, 2026-10-29, introducing its venture partner (nick's inbox; not committed) |
| Hosted teams "come next", no prices | ADR 461 §5 (the price rule, no figures); the business-plan spec; goal `cloud` in flight, no date quoted |
| What is not said: "who asked" (2026-10-30: 1,506 of 1,725 lanes opened since 2026-10-16 name a person, 87%, under ADR 665 §3's nine in ten), "a person at both ends", a count of outside teams (none), the cookoff multiplier, the GitHub star count, the authoriser ratio | brand.md §1 claim discipline (ADR 665 §3); `docs/wiki/how-musterd-got-here.md` holds the multiplier; nick, 2026-10-26, on the star count and the ratio |

## What changed on 2026-10-30

nick asked for the text to be brought up to date before submission; alfie revised it with him.

- **Counts** re-read by nick the same day (rows above). 700 → 750 decision records; five model
  families → models from seven makers.
- **Relevant experience** is the career arc, led by specifics (nick): Fannie Mae from Project Analyst
  to Technology Engineer, the developer-tools team and the package-approval win, the MBA and VMware,
  then all in on AI since 2024. The undergraduate line is cut (nick: it was 15+ years ago). Why:
  speedrun's own post (2026-10-07) says reviewers spend about 80% of their time on team and bio and
  look for "slope" and what a LinkedIn page does not show.
- **Team** leads with the team; the founder is one sentence at the end (nick: true, not prominent).
  nick's own part is said lightly ("I work on the team too"), not as "the way I ran product teams"
  (nick: too authoritative).
- **Anything else** drops "lining up the first outside teams" (none is named; nick) and gains what
  shipped since 10-26: the passkey on person-only acts, and joining from claude.ai, ChatGPT or Codex.
- **Traction** gains the two October demos and EPIC Connector's follow-up, said without the detail
  (nick), and states the stage once: no outside teams yet.
- **Spend** is about $1,000 (nick).
- **The video** is a team video, nick on camera, not a product demo (above).

## What the readers changed, 2026-10-30

fifty and lazara read v3 of #3630 the same day, neither having read the 10-26 text. alfie took the
points below; nick reads the result before he submits.

- **Both:** "Before musterd, 37 percent" clashed with the team's first act on 2026-07-02 (fixed: before
  musterd had a board and review, in the description, the deck and the video); "agent seats" and
  "harness" are insider words (fixed: agents, tool); the form's 0 full-time founders next to "one
  founder, full time" reads as a mistake (fixed: the only founder, not yet incorporated); experience
  should say why this founder (fixed: the Fannie Mae approval problem, now for agents).
- **fifty:** traction at 1,034 characters (now 993); facts repeated across fields (MIT once, the
  public date once, the day count only in traction); "seven model families" (fixed: seven makers);
  CooperBench needs a gloss (fixed).
- **lazara:** description at 799 of 800 with no margin (now 773); "the calls only a person can
  make, 336" overclaims, since unanswered asks proceed on a timer (fixed: the questions that need a
  person); "putting a person's name on a landed change" is git-speak (fixed: signing off a merge in a
  person's name); "musterd Cloud" against "hosted musterd" (fixed: hosted musterd); ISO dates in prose
  (fixed). Left: swapping the morning-reading line for a named product, because nick asked for it;
  it is shortened instead.

## What nick changed in the form, 2026-10-30

After #3630 merged, nick edited several answers in the form, and alfie made a last pass on them with him.

- **nick's edits:** the one-liner says "for teams" rather than "for dev teams"; the team answer drops its numbers
  (seven makers, the verdict counts); traction drops its first paragraph and gains a line on design partners;
  Anything else becomes the Twitch link; the description says "hosted cloud teams".
- **The last pass (nick asked for it, "all"):** relevant experience rewritten around one thread, the approval
  step in the developer's path, from Fannie Mae to musterd, without the undergraduate line; the description's
  "Before musterd, 37 percent" put back to "before musterd had a board and review" (the readers' point, above);
  traction's opening line restored with two numbers; the EPIC Connector and design-partner sentences cleaned
  up; Anything else gains the residency plan and the spend; dates unified on June 2026.
- **Not in the submitted text, though true:** the models-from-seven-makers count, the 180 of 1,454 verdicts,
  the passkey line and joining from claude.ai, ChatGPT or Codex. Their source rows above stay for the record.

## Decisions, nick, 2026-10-26

- One-liner C of three. The tagline is ADR 563's; the clause after the comma names the buyer.
- State the stage once and plainly. No GitHub star count, no "no install logged" line, and no
  paragraph on the "who asked" gap: all true, all the wrong room for a reader of 2,000 applications.
- "Nothing counts as done until a different member accepts it" stays as written: it is ADR 665 §1's
  sentence, the form brand.md §1 requires wherever a surface argues the case. sloane read it as too
  strong given the unconfirmed self-close; the self-close being recorded unconfirmed is the sentence's
  point.
- "Lining up the first outside teams" rather than a count. wanderer: cut it if `docs/design/traction-log.tsv`
  is still empty on submission day. nick decides that morning.
- Founded is the domain's registration month. No legal entity is formed for the application.
- Personal GitHub and X handles on the founder, since that section is about the founder; the
  organization's repository is named in the text.
- Open to a technical co-founder, said in one sentence.

## What the readers changed

Three seats read the five written fields on 2026-10-26; nick took the edits below and left the rest.

- **sloane** (14 points): "built in public since June" against the repository opening on 2026-10-12
  (fixed: built since June, opened 2026-10-12); the month on the 37% (fixed: no month); "since
  September … wasted work" against one September read (fixed: "In September that figure was 0.9
  percent"); "about a dozen" seats against the ledger's 23 (fixed: about two dozen, in every field);
  "open-weight" as a relabel of Muse (fixed: five model families); the team field's eight numbers
  (cut to three, the authoriser ratio dropped); "lanes", "asks" and "seat" as insider words (fixed);
  two tells cut.
- **ghost** (4 points): the 37% → 0.9% pair had no definition (fixed: "never reached main", "that
  figure"); $500 with no scope or month (fixed: October; subscriptions, hosting, domains); the AWS
  internship clause (cut); "pieces of work" with no denominator (fixed: "on the team's board").
- **wanderer** (7 points): ", every day" against 101 of 111 days (cut); "118 of 1,123 pieces"
  sharing a noun with "2,090 pieces" (fixed: review verdicts); "the server refuses that" as a
  mechanism claim (fixed: every verdict from a member other than the author); the description's
  second number with no subject (fixed); "lining up" (nick's, above); the $300M "launched" verb
  (nick's own resume line, kept).

## Submission day

Submitted by nick on 2026-10-30, two days before the 2026-11-01 deadline; the confirmation page says reviews run
every two weeks and a reply comes in 10–14 days. The counts are the 2026-10-30 read (rows above); none was
re-read after it. The written answers above are the text as sent; the personal fields are not recorded here.

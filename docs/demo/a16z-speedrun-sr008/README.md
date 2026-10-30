# a16z speedrun SR008 application, 2026-10-26, revised 2026-10-30

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

Version 3, 2026-10-30, after fifty's and lazara's reads the same day. Counts were read that day by nick; what changed from the 2026-10-26 text is under [What changed on 2026-10-30](#what-changed-on-2026-10-30).

**One-liner** (100 characters; 87)

> Agents that work as a team alongside you, for dev teams running several agents at once.

**Startup description** (800 characters; 773)

> Small dev teams now run several agents at once: Claude Code in one window, Codex in another, on the same repo. Each works alone. They build the same thing twice, overwrite each other, and lose their context when the window closes, and nobody can say which model did what. Before musterd had a board and review, 37 percent of what our own agents wrote never reached main.
>
> musterd puts the agents and the people they work with on one team as named members, in any tool. Work is claimed on a board, one owner at a time. A member can decline or hand off. Nothing counts as done until a different member accepts it, and the record shows who did it, who accepted it, and which model. In September that figure was 0.9 percent. Self-hosted is free and MIT; hosted teams come next.

**Relevant experience** (1,000 characters; 987; nick's first person)

> At Fannie Mae I went from Project Analyst in enterprise architecture to Technology Engineer by teaching myself to program, shadowing the engineers and taking on work for internal tech teams outside my role. As an engineer I led a developer-tools team serving 220+ applications, and deployed the system that took open-source package approval from two weeks to an instant download by building the approval into the download itself.
>
> After an MBA at UT Austin I was a PM at VMware, where I launched a $300M ARR subscription for VMware Cloud on AWS with three engineering teams, and a commerce launch that grew our U.S. government customer base 80% in two years.
>
> Since 2024 I have gone all in on AI: papers and launches every morning, a daily podcast I built to explore them (Exploring Next), and products built with every agent, tool and model I could get. Running several agents on one repo led to musterd: the Fannie Mae problem again, approval built into how work lands, now for agents.

**Tell us more about the team** (1,000 characters; 633)

> musterd is built on musterd: about two dozen agents, each a named member of the team, on models from seven makers, working alongside me since July 2. In the last 30 days, 180 of 1,454 review verdicts sent the work back, and every verdict came from a member other than the author.
>
> I work on the team too: I set the goals, and the agents bring me the questions that need a person, 336 in the last 30 days. I know the buyer because I am one: a PM who ships with agents and hit the collisions, the lost context and the unreadable history first. I am the only founder, full time, not yet incorporated, and open to a technical co-founder.

**Anything else we should know** (1,000 characters; 942)

> musterd has been built since June by the agents and me, on musterd itself, with the build streamed on Twitch. The repository has been public since October 12 (github.com/musterd-io/musterd).
>
> The record now carries a person's signature where only a person may act: signing off a merge in a person's name, changing team policy or adding an agent takes that person's passkey, so an agent holding their login cannot do it. People join a team from claude.ai, ChatGPT or Codex, and can answer a teammate from their phone.
>
> What the residency buys. By Demo Day: hosted musterd live, the first outside teams on it for two weeks or more, and the first paying team. The hosted team is what gets paid for. Spend in October is about $1,000: model subscriptions, hosting and domains. The money goes to building hosted teams and to sitting with each new team for its first hour, which is where we find out what a stranger cannot do without me in the room.

**Traction** (optional; 993)

> Built by a team that runs on it: 2,518 pieces of work closed and 3,095 questions put to a member, with activity on 111 of the 121 days since July 2 (read October 30). On CooperBench, a public benchmark for two coding agents on one repo, we ran ten fresh pairs, pre-registered, in October: musterd's two agents produced no conflicting patches, 0 of 10, where CooperBench's own two-agent setups conflicted on 6 and 7 of 10.
>
> This month I demoed musterd live at two San Francisco events, rebuilding the demo between them around the product itself. At the second, during SF Tech Week, agents on four different models picked up a request live and came back within minutes with questions and a design objection. The hosts, the incubator EPIC Connector, followed up to say the demo left a strong impression on their team and introduced me to their venture partner.
>
> musterd installs from npm and Homebrew. No outside teams yet: getting the first ones onto hosted musterd is what the residency is for.

**Funding history** (optional; 78)

> None. Self-funded; about $1,000 a month in tooling and hosting, covered by me.

**Active fundraising round** (optional; 55)

> No round open; this would be the first outside capital.

## The other fields

| Field | Answer | Why |
| --- | --- | --- |
| Full-time or part-time | Full-time | nick, 2026-10-26 |
| Number of full-time founders | 0 | The form: "If you're part-time or not yet incorporated, enter '0'". There is no legal entity yet (nick, 2026-10-26); one is formed on acceptance or when a counterparty needs it |
| Total FTE | 1 | |
| Startup name | musterd | SandRise Studio is the maker, never the product brand (`docs/wiki/positioning.md`) |
| Primary / secondary category | Infrastructure / Dev Tools; B2B / Enterprise Applications | ADR 550 §4: builders first, knowledge work as the expansion |
| Where it is built | United States, San Francisco | |
| Founded | August 2026 | nick's rule: the month musterd.io was registered. `whois musterd.io` creation date 2026-08-13, read 2026-10-26. The first commit is 2026-06-09 |
| Website | https://musterd.io | |
| Team video (MP4) | nick on camera, about 90 seconds, in his own words, with an optional cutaway to `/live`; the beats are [`video.md`](video.md) | The form's only video field is "Team Video (MP4)", optional, with no length or guidance (read 2026-10-30). speedrun's "What founders ask us before applying" (2026-10-07): "We just need you … talking earnestly about what you're building", no AI voice, polish not weighed. It is not a product demo; the 10-26 entry "the 2-minute demo" was alfie's, not the form's |
| Pitch deck | `../pitch/build.sh` output, 12 pages | #3342 and #3344, 2026-10-26; its two daily-use counts refreshed to the 2026-10-30 read in this record's v3 PR |
| Where did you learn about speedrun | Other: researching SF accelerators, incubators and residencies | nick, 2026-10-26 |

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

To be filled in when nick submits: the date, and any count that moved after the 2026-10-30 read.
(The other two items this section first held are settled: "lining up the first outside teams" was
cut, and the October spend is about $1,000, both nick on 2026-10-30.)

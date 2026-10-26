# a16z speedrun SR008 application, 2026-10-26

> The record of what nick submits to [speedrun.a16z.com/apply](https://speedrun.a16z.com/apply) for
> SR008 (applications close 2026-11-01; the residency runs 2027-02-01 to 2027-04-16 in San Francisco;
> read from the form on 2026-10-26). Drafted by alfie with nick on 2026-10-26, read by sloane, ghost and
> wanderer the same day. Personal fields (contact details, citizenship, education) are not recorded
> here. The pitch deck uploaded with it is [`../pitch/`](../pitch/README.md) as of #3344, rendered by
> its `build.sh`.

Every number below has a row in the sources table. nick re-runs `../pitch/counts.sh` and
`../pitch/chain.sh` on the day he submits and the submitted values are noted at the bottom of this
page then.

## The written answers

**One-liner** (100 characters; 87)

> Agents that work as a team alongside you, for dev teams running several agents at once.

**Startup description** (800 characters; 799)

> Small product and engineering teams now run several agents at once: Claude Code in one window,
> Codex in another, on the same repo. Each works alone. They build the same thing twice, overwrite
> each other, and lose their context when the window closes, and nobody can say afterwards which
> model did what. Before musterd, 37 percent of what our own agents wrote never reached main.
>
> musterd puts the agents and the people they work with on one team as named members, whatever
> harness each runs in. Work is claimed on a board, one owner at a time. A member can decline or
> hand off. Nothing counts as done until a different member accepts it, and the record shows who
> did it, who accepted it, and which model. In September that figure was 0.9 percent. Self-hosted
> is free and MIT; hosted teams come next.

**Relevant experience** (1,000 characters; 858; nick's first person)

> Product manager, then builder. At VMware (2021–24) I owned VMware Cloud subscription services and
> launched a $300M ARR SaaS subscription for VMware Cloud on AWS with three engineering teams; a
> later commerce launch for U.S. government customers grew that customer base 80% in two years.
> Before that, five years at Fannie Mae, the last three leading a developer-tools team serving 220+
> applications. MBA, UT Austin McCombs; BA in Economics, Wesleyan.
>
> Since August 2024 I have built products on my own with agents: an iOS pet camera app with live AI
> commentary, a group apartment-hunting app, and musterd, which I have built since June 2026 with
> about two dozen agent seats that run on musterd itself. The product's reasoning is public: more
> than 700 dated decision records, a protocol spec, and the product's decisions written where a
> stranger can read them.

**Tell us more about the team** (1,000 characters; 728)

> One founder, full time. The rest of the team is about two dozen agent seats, each a named agent
> on the team, on five model families, building musterd on musterd. Since their first act on
> 2026-07-02 they have closed 2,090 pieces of work on the team's board, with activity on 101 of 111
> days. In the last 30 days, 118 of 1,123 review verdicts sent the work back, and every verdict came
> from a member other than the author (read 2026-10-20).
>
> I know the buyer because I am one: a PM who ships with agents and hit the collisions, the lost
> context and the unreadable history first. Ten years of platform and developer-tools work is the
> background for a protocol product. No co-founder or advisors yet. Open to a technical co-founder.

**Anything else we should know** (1,000 characters; 703)

> musterd has been built since June by the agents and me, on musterd itself, with the build streamed
> on Twitch. We opened the repository on 2026-10-12 (github.com/musterd-io/musterd) and are lining up
> the first outside teams.
>
> What the residency buys. By Demo Day: musterd Cloud live, the first outside teams on it for two
> weeks or more, and the first paying team. Self-hosted stays free and MIT; the hosted team is what
> gets paid for. Spend in October is about $500: model subscriptions, hosting and domains. The money
> goes to building hosted teams, which do not exist yet, and to sitting with each new team for its
> first hour, which is where we find out what a stranger cannot do without me in the room.

**Traction** (optional)

> Built by a team that runs on it: on our own team, 2,090 pieces of work closed and 2,329 questions
> put to a member, with activity on 101 of the 111 days since 2026-07-02 (read 2026-10-20). On ten
> fresh CooperBench pairs (Claude Code on Sonnet 4.5, pre-registered, 2026-10-23), musterd's two
> agents produced no conflicting patches, 0 of 10; CooperBench's own two-agent harnesses conflicted
> on 6 and 7 of 10. Self-hosted musterd is MIT on npm and Homebrew; the repository has been public
> since 2026-10-12. Outside users: the first design partners are being lined up.

**Funding history** (optional)

> None. Self-funded; about $500 a month in tooling and hosting, covered by me.

**Active fundraising round** (optional)

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
| Team video | the 2-minute demo | nick records it |
| Pitch deck | `../pitch/build.sh` output, 12 pages | #3342 and #3344, 2026-10-26 |
| Where did you learn about speedrun | Other: researching SF accelerators, incubators and residencies | nick, 2026-10-26 |

## Sources

| Claim | Source, and when it was read |
| --- | --- |
| 37% never reached main before musterd; 0.9% in September | `../pitch/script.md` sources row for page 2: our own team's git history, a July read and one September read (finding 001's P3 post-mortem; ADR 462). The homepage pair (`docs/design/homepage-copy-spec.md`). The cookoff multiplier is held out of outbound copy and is not used |
| 2,090 pieces of work closed; 2,329 questions put to a member; activity on 101 of 111 days since 2026-07-02 | `../pitch/counts.sh` and the ledger row for page 7, read 2026-10-20 by nick. "Pieces of work" are lanes in state `done`; "questions put to a member" are `ask` acts addressed to a member. The agent seats cannot read the database (ADR 658), so a person re-runs it |
| 118 of 1,123 review verdicts sent the work back; every verdict from a member other than the author | `../pitch/chain.sh`, run by nick 2026-10-20, 30-day window (the ledger row that also carries 973 of 1,021; that ratio is not in the application). A different member is enforced on the verdict (ADR 188, ADR 234); an owner's self-close is recorded unconfirmed (ADR 235) and is not a verdict |
| About two dozen agent seats; five model families | The ledger's daily-use row: 23 agent seats sent acts in the last 30 days; acts stamped with models from five families (Anthropic, OpenAI, xAI, Google, Muse). Read 2026-10-19, not re-run |
| More than 700 dated decision records | `ls docs/decisions/*.md \| wc -l` → 720 on 2026-10-26 |
| Repository public since 2026-10-12 | ADR 565 |
| The build is streamed on Twitch | `twitch.tv/musterd_io` (`docs/wiki/twitch-channel-audit.md`; the ledger row for the Twitch handle) |
| Spend in October about $500: model subscriptions, hosting and domains | nick, 2026-10-09, `docs/superpowers/specs/2026-10-09-business-plan-design.md` ("What nick said"): Claude, OpenAI, Grok and Cursor subscriptions, two domains, fly.io, ubicloud, cloudflare, GitHub. nick confirms the month's figure on submission day |
| CooperBench: 0 of 10 conflicting patches against 6 and 7 of 10 | [finding 023](../../research/023-cooperbench-coordination-run.md), 2026-10-23, pre-registered; its status line says the claim may be stated. Pass rate is [finding 021](../../research/021-cooperbench-claim-run.md), no claim (5 of 20 against 6 of 20 solo), and is not in the application; lazara, 2026-10-26: no run before 2026-11-01 can change that |
| VMware, Fannie Mae, degrees | nick's own resume; his record to state |
| Hosted teams "come next", no prices | ADR 461 §5 (the price rule, no figures); the business-plan spec; goal `cloud` in flight, no date quoted |
| What is not said: "who asked", "a person at both ends", the cookoff multiplier, the GitHub star count, the authoriser ratio | brand.md §1 claim discipline (ADR 665 §3); `docs/wiki/how-musterd-got-here.md` holds the multiplier; nick, 2026-10-26, on the star count and the ratio |

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

To be filled in by nick when he submits: the date, the values `counts.sh` and `chain.sh` printed,
whether "lining up the first outside teams" stayed, and the October spend as confirmed.

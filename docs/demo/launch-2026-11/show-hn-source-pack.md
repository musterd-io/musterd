# Show HN — source pack for nick

- Status: source pack (comms, sloane), 2026-11-06. Lane `01M6S6W8EGB0PYQB3E631TTC05`, goal `launch`.
- **nick writes the post, the title and every comment reply in his own words.** HN's guidelines
  forbid generated and AI-edited text, and dang's Show HN advice (edited 2026-03-28) says not even to
  edit with an LLM ([guidelines](https://news.ycombinator.com/newsguidelines.html),
  [item 22336638](https://news.ycombinator.com/item?id=22336638)). This page is facts, links and
  questions. It holds no sentence to paste, and none should be pasted from it.
- Format: `.agents/skills/comms/references/launch-and-press.md` §"Hacker News".

## 0. Re-check on the day you post

Every line below was read on 2026-11-06. Before posting, re-read each and change this page if one
moved.

| Check | How | Read 2026-11-06 |
| --- | --- | --- |
| The release a stranger installs | `pnpm train status` | v0.7.1 on npm, tag, GitHub Release, MCP Registry, Homebrew |
| The install lines | The generated block in `README.md` (`content/install.data.ts`) | §2 below |
| The repository is public | `gh api repos/musterd-io/musterd --jq .private` | `false` |
| The numbers you might say | `docs/demo/pitch/script.md` ledger; `docs/demo/pitch/counts.sh` (a person runs it, ADR 658) | Ledger last re-run 2026-10-30 |
| What is held | `docs/wiki/how-musterd-got-here.md` "What was tried and reversed" | The cookoff multiplier is held |
| The recording exists | [`recording-script.md`](./recording-script.md) | Not yet recorded |
| Anyone outside the team has installed it | `docs/design/traction-log.tsv`; `docs/design/quotes.md` | No rows; no quotes |

**Hold the post** until the recording exists and at least one person outside the team has installed
it on their own machine. Show HN readers try things. A first ten minutes nobody outside the team has
walked is the riskiest thing on this page.

## 1. What it is, in one sentence (a fact to say in your words)

musterd puts your agents and the people you work with on one team: a roster, a board of lanes,
inboxes, and a record of who did each piece of work and who accepted it. Agents join from the tool
they already run (Claude Code, Codex, Cursor, OpenCode, Grok) through one MCP server.

- Source: `README.md` Quickstart; the brand claim, [ADR 563](../../decisions/563-the-claim-is-the-team.md)
  ("Agents that work as a team alongside you").
- Show HN titles start `Show HN:` and HN strips superlatives and marketing words. Name what it is.

## 2. Try it, with no signup

```bash
npm install -g @musterd/cli        # Node 22 or later. Or: brew install SandRiseStudio/musterd/musterd
cd your-project
musterd init                       # finds your agent tools and offers to wire the MCP server
musterd tour                       # five minutes: give an agent a lane, judge what comes back
```

- Repository: https://github.com/musterd-io/musterd (MIT). Site: https://musterd.io.
- No account, no signup, no musterd.io connection for a local team
  ([ADR 461](../../decisions/461-pricing-and-business-model.md) §1, accepted 2026-11-06;
  [`PRIVACY.md`](../../../PRIVACY.md)).

## 3. Backstory — questions only you can answer

Answer these in your own words. Pick two or three for the post; keep the rest for comments.

1. What were you doing the day you decided agents needed a team, and what broke?
2. Why build it on your own team first, and what did running your own work on it change?
3. What surprised you about how agents behave once they have to ask a person before going on?
4. What did you get wrong, and change your mind about? (`docs/wiki/how-musterd-got-here.md` "What was
   tried and reversed" lists candidates: governance cut then rebuilt, "warn, never block", self-asserted
   resolve.)
5. Who is it for, in one person you can picture?
6. What do you want from HN readers: installs, criticism, design partners, contributors?

## 4. What is different, each with its source

| Claim | Where it is true |
| --- | --- |
| By default, nothing counts as done until another member accepts it. A lane its worker declares low-stakes skips acceptance (one in five is still routed at random), and a lane with a risk tag always goes to a person. The record shows who did it, who accepted it, and which model | [ADR 665](../../decisions/665-accountability-message-a-person-at-both-ends.md) §1; acceptance: [ADR 192](../../decisions/192-outcome-acceptance.md), [ADR 234](../../decisions/234-tiered-acceptance.md) |
| One command prints the chain for any piece of work: asked, claimed, model, accepted, each link verified, stated or missing | `musterd lane show <id>`, [ADR 629](../../decisions/629-lane-requested-by.md), #2771 |
| An agent asks a person, with a clock; above a stakes tier it holds until answered, below it proceeds and records that it went on alone | [ADR 147](../../decisions/147-human-ask-stream.md), [ADR 153](../../decisions/153-ask-reachability-gated-hold.md), [ADR 222](../../decisions/222-answerable-asks-on-live.md) |
| Work is claimed before it is built: one owner per lane, a warning when scopes overlap | [ADR 150](../../decisions/150-structural-inducement-pretooluse-gates.md) |
| Mixed tools on one team: Claude Code, Codex, Cursor, OpenCode, Grok through one MCP server | `README.md` Quickstart; `@musterd/mcp` on the [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.musterd/musterd) |
| Runs on your machine: a daemon and a SQLite file; free and uncapped for good | [ADR 461](../../decisions/461-pricing-and-business-model.md) §1; [`PRIVACY.md`](../../../PRIVACY.md) |
| The team that builds it runs on it, every day since 2026-07-02 | The daemon's database; ledger in `docs/demo/pitch/script.md`, Q&A ledger "Daily use" (read 2026-10-30; re-run before quoting) |
| On our own team, 37% of what our agents wrote never reached main before musterd had a board and review; 0.9% after | Ledger row 2, `docs/demo/pitch/script.md`. One team, git history, July then September. Say "one team, two reads of its git history" in the same breath |

## 5. Known limits, plainly

- **Strangers have not installed it yet.** No install outside the team is logged
  (`docs/design/traction-log.tsv`, read 2026-11-06). The ten-minute first run is the claim most likely
  to break in the thread.
- **It does not run or sandbox your agents.** Agents keep running in their own harness; isolation stays
  with the harness or your sandbox. musterd is the team boundary for attribution and human
  coordination ([`docs/demo.md`](../../demo.md) §6, "the true sentence").
- **Security boundary today** (from [`docs/launch-post.md`](../../launch-post.md)): scoped credentials,
  authorized seat claims, Presence-bound leases, admin-gated governance, append-only audit records. Not
  yet: sandbox enforcement, database encryption at rest, mTLS, signed audit records, automatic
  credential rotation. 0.7.1 fixed advisory
  [GHSA-jw8q-rc2q-m45q](https://github.com/musterd-io/musterd/security/advisories/GHSA-jw8q-rc2q-m45q).
- **Waking an idle agent depends on the harness.** Coverage varies; say "any harness" for joining, never
  for waking (ledger row 5).
- **musterd Cloud and its prices.** Hosted teams are in progress; no prices exist yet. Prices and the
  free allowance are set with design partners ([ADR 461](../../decisions/461-pricing-and-business-model.md)
  §2, §5).
- **The 37% is one team's history**, a forensic read of one repository. The cookoff multiplier is held
  and is not said at all.

## 6. Likely questions, with true short answers

The standing bank is "Questions to expect" in [`docs/demo/pitch/script.md`](../pitch/script.md), each
answer with a ledger row. Re-read it the day you post; answer in your own words. The ones HN is most
likely to ask, and where each answer rests:

| Likely question | The true short answer rests on |
| --- | --- |
| Is anyone using it? | Only our own team so far. Bank: "Is anyone using it?" |
| How is this different from Claude calling Codex for a review? | The review lands under the caller's name; on musterd the reviewer is a member and its model is on the record. Bank, same question |
| Why use this over Claude Code's agent teams, Codex cloud or Cursor agents? | Each sees only its own vendor's agents; musterd is one record across tools. Bank: "Everyone and their mama…" |
| Does it run my agents? Is it a sandbox? | No to both; §5 above |
| Where does my data go? | Nowhere: a daemon and a SQLite file on your machine. Bank: "Why would people let you access their data?"; [`PRIVACY.md`](../../../PRIVACY.md) |
| How do you make money? | Free and uncapped on your own computers; musterd Cloud free to an allowance then paid; org features paid. [ADR 461](../../decisions/461-pricing-and-business-model.md) as accepted 2026-11-06. **The bank's answer predates this revision** ("a subscription with caps"); use ADR 461's words |
| Is the 37% real? | One team's git history, two reads; not a controlled study. Bank: "Is the 0.9% real?" |
| What about CooperBench? | Pairs of top coding agents lost nearly half their capability against one agent alone (arXiv 2601.13295). Bank: "New models fix old problems" |
| Why MCP? | One server joins any MCP-capable agent; `README.md` |
| Is it open source? What license? | Yes, MIT, public since 2026-10-12 ([ADR 565](../../decisions/565-repo-public-musterd-io.md)) |

## 7. On the day

- Post when you can stay for the first three hours. Answer every comment yourself.
- Use the repository as the Show HN URL. Put the site and the video in the text.
- If the install breaks for someone in the thread, say so, thank them, and open the issue from the
  thread. A fixed bug with a link back is the best reply the thread can see.
- Log every install and quote that comes from the thread in `docs/design/traction-log.tsv` and
  `docs/design/quotes.md`, with consent for any quote.

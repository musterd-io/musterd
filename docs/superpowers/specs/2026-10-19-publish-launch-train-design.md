# The release train — one ordered way to publish musterd, and the launch as its first big run

**Status:** decided 2026-10-19 — nick took D1–D6 the same day; the decision record is
[ADR 669](../../decisions/669-the-release-train.md). Lane `01M5ASVF3GAAE17TY3S3AX9SF0` (slippy), asked
for by nick in-session: "we need a better overall unified publish/launch strategy". Nothing here is
decided until nick marks it; the decisions in §8 become an ADR once he does. This page does not
re-plan the launch's *message* or *calendar* — those are
[traction-plan.md](../../design/traction-plan.md) (§7 launch day, §13 measures) and the positioning
ADRs (550, 563, 665). It plans the *machinery* those depend on.

## 1. The problem, measured

musterd ships through seven surfaces, and each has its own way out, its own owner and its own notion
of "current":

| Surface | How it ships today | Owner | State on 2026-10-19 |
|---|---|---|---|
| npm `@musterd/*` (5 packages) | `pnpm release --version X` from a laptop, lockstep, pre-publish smoke (ADR 156) | nick (creds) | 0.5.0, published 10-12; **499 commits behind main** |
| Homebrew `SandRiseStudio/musterd` | `pnpm bump-brew-formula`, push the tap — printed as a manual step | nick | 0.5.0 |
| MCP Registry | `mcp-publisher publish` — printed as a manual step (#2917) | nick (one-time GitHub login) | **not listed**: needs a release carrying `mcpName` |
| musterd.io | `deploy:site`, standing authorization (ADR 308) | miley | current (580a069, ADR 666 live) |
| `/live` bundle | republished from main within ~60s (ADR 132) | automatic | current |
| GitHub Releases / CHANGELOG | **none** — five tags, no notes anywhere | nobody | — |
| Docs indexes (Context7, DeepWiki), MCP catalogs | never submitted | nobody | — |

What that costs, concretely:

- **No release has notes.** A stranger on npm or GitHub cannot tell what 0.5.0 changed, and neither
  can an answer engine. The only record is ADR prose.
- **The install path disagrees with itself** — the README leads with brew `tap && install`, the site
  with `npm install -g`, dogfood run 4's script with `npx @musterd/cli init`, and the README's
  by-hand block still shows the `--as` flow that 0.5.0 refuses (ADR 568). A stranger who reads two
  of them meets a contradiction in their first minute.
- **Every post-publish step is a line printed to a terminal** and remembered, or not. The MCP
  Registry step already cannot run — it needs the next release.
- **The launch is nine days out** (traction plan: Oct 28 – Nov 2, go/no-go Oct 28), and the release
  it will point strangers at does not exist yet.

## 2. The idea: one train, fixed cars, one checklist that checks itself

A **train** is one version leaving through every surface, in a fixed order, with each car verified
before the next leaves. Same train for a quiet patch and for the launch; the launch only adds cars
at the end.

```
 0 Gate      run 4 on a clean machine, on two harnesses (Claude Code + Codex), on the candidate
 1 Notes     generated release notes, reviewed by a human
 2 npm       pnpm release --version X           (nick — ADR 156, creds stay human)
 3 Tag       git tag vX + a GitHub Release carrying the notes
 4 Registry  mcp-publisher publish               (MCP Registry → Glama, PulseMCP, client catalogs)
 5 Brew      bump-brew-formula + push the tap; brew install smoke
 6 Site      miley deploys; the site's install block shows vX
 7 Indexes   Context7 refresh, DeepWiki re-index  (only when docs changed)
 ── launch-only cars ──
 8 Launch    traction-plan §7, in its order (blog un-withheld first, then Show HN, X,
             the stream live with a launch title; Reddit the next day) — not restated here
 9 Lists     awesome-mcp-servers PR, the small-things repos' pointers
```

Cars 0–7 are the **release train**; 8–9 run once, on launch day, and then never again in that form.

## 3. What makes it one train instead of nine steps

Three small pieces of code, each replacing a step someone has to remember:

1. **`pnpm train status [--version X]`** — reads every surface and prints one table, red or green:
   npm `latest`, the git tag, the GitHub Release, the MCP Registry entry
   (`registry.modelcontextprotocol.io/v0/servers?search=io.github.musterd-io/musterd`), the brew
   formula's version, musterd.io's `build.json` ref and the version its install block shows.
   Read-only, runnable by any seat, no credentials. It turns "did we finish the release" from a
   memory into a command, and it is what car 3–7's owners run to see what is left. (`site-gap` is
   the precedent: ADR 308's landed-is-not-live instrument, generalized to every surface.)
2. **Generated release notes** — `pnpm train notes vPREV..HEAD` groups the squash-merged PR titles
   since the last tag by goal (each PR already names its lane; each lane names its goal), drops
   docs-only and test-only PRs, and writes a draft to `docs/releases/vX.md`. A human edits it to
   the five things a user would notice; the edited file is the GitHub Release body and the site's
   "what's new" — one fact, one home. No CHANGELOG.md beside it.
3. **One install block** — a single typed source (`content/install.data.ts`) that the README, the
   site's Getting Started, `/start`, llms.txt and the launch post all render from, with the version
   filled at build time from the CLI's package.json. A test fails when any surface carries a
   different command. This is the fix for §1's four disagreeing install paths, and it **retires
   traction-plan §7's "set the version that morning" step** — sloane edits §7 in the same lane that
   moves the launch post to 0.6.0 (she owns the block's copy and the release notes' voice).

What stays manual, deliberately: the npm publish (ADR 156 — creds stay with a human; see §8 D3 for
the alternative), the human edit of the notes, and every car in 8–9.

## 4. Cadence

- **Ship as fast as it makes sense — no fixed calendar** (nick, 2026-10-19). A train leaves when main
  has a change a user would notice, or a fix one is waiting for. The train exists so that leaving is
  cheap and checked, which is what makes "often" safe; a timetable would add waiting, not safety.
- **Version policy while 0.x**: minor for anything a user would notice, patch for fixes only.
  The launch train is **0.6.0**.
- **The train never leaves on a red gate (car 0).** Car 0 is run 4 on **two harnesses** — Claude
  Code and Codex — as traction-plan §5 and §13 require. Run 4 is the gate because it is the first
  minute a stranger has; nothing else in CI exercises a clean machine end to end. (0.3.0 and 0.4.0
  both shipped broken and are untagged — the smoke catches unloadable tarballs; only car 0 catches
  a first minute that does not work.)

## 5. Owners

| Car | Owner | Why that seat |
|---|---|---|
| 0 Gate | a seat that is not nick, fresh account (traction-plan §14) | the stranger's view |
| 1 Notes draft / edit | slippy drafts, nick edits | the voice is nick's |
| 2 npm, 3 tag, 4 registry, 5 brew | nick | credentials (npm, GitHub org, tap) |
| 6 Site | miley | ADR 308 |
| 7 Indexes | slippy | read-only submissions of public material |
| 8–9 Launch | traction plan §7: nick posts and answers; sloane and seats draft | message is sloane's |
| `train status` red/green | any seat | read-only |

## 6. The launch train (0.6.0), dated

Working back from traction-plan §7's window (Oct 28 – Nov 2; go/no-go Oct 28):

| By | What | Blocks |
|---|---|---|
| Oct 21 | install block unified (§3.3); README by-hand block fixed; `train status` + `train notes` land | car 0 can't judge a path that disagrees with itself |
| Oct 22 | run 4 on a clean machine against main → findings fixed | the gate |
| Oct 23 | **0.6.0 train, cars 0–7.** Registry listed; Context7 + DeepWiki submitted | the launch post's links and version |
| Oct 24–27 | launch post updated to 0.6.0 and ADR 568's install path (sloane, gated on the tag); the 2-minute recording cut | traction-plan §7 |
| Oct 27 | **trademark attorney clearance back** (lane `01M0130CYM`, nick) — a post cannot travel with an open UK conflict; domain auto-renew confirmed (`01M0130E00`) | the post travelling |
| Oct 28 | go/no-go (traction-plan §13) | — |
| Oct 28–Nov 2 | cars 8–9 | — |

0.6.0 ships a week before launch on purpose: a train that breaks something has a week to ship
0.6.1 before strangers arrive, and the registry and indexes need days to propagate (Context7
reports 1–3 days for review).

## 7. Measures

The launch's targets and passive proxies (npm downloads, stars) live in
[traction-plan §13](../../design/traction-plan.md) — one fact, one home. The train adds only its
own two numbers, logged per release:

- **Train health**: days from tag to all-green `train status`. Failing: > 2 days — a car has no owner.
- **Registry listed**: the MCP Registry entry exists at the tagged version.

Agent discovery is read from AI Crawl Control as ADR 666 §Observability sets out (0 AI referrals on
2026-10-19 against ~760 crawler requests a day).

## 8. Decisions for nick

- **D1. Adopt the train** — **decided (nick, 2026-10-19): yes.** sloane reviewed against the traction plan
  (five fixes, folded in); alfie against the positioning ADRs (registry and package copy, #2926).
- **D2. Cadence** — **decided (nick, 2026-10-19): no fixed cadence; ship as fast as it makes
  sense** (§4). 0.x minor/patch policy; launch on 0.6.0, cut ~Oct 23.
- **D3. npm publish stays on your laptop** — **decided (nick, 2026-10-19): stays manual for
  0.6.0; CI publish revisited after launch.** The option weighed: (ADR 156), *or* move it to GitHub Actions with npm
  trusted publishing (OIDC, no stored token, provenance attestations on every package) gated on a
  manual approval you click. The second removes the "only on nick's laptop" dependency the train
  otherwise has, and provenance is a trust signal on the npm page; it reverses ADR 156's "no CI
  publish", so it needs its own ADR. Recommendation: stay manual for 0.6.0, revisit after launch.
- **D4. Registry namespace** — **decided (nick, 2026-10-19): `io.musterd/musterd`**, verified by a
  DNS TXT record on musterd.io (`mcp-publisher login dns --domain musterd.io`), so the listing reads
  as the brand rather than the GitHub org. Replaces the `io.github.musterd-io/musterd` #2917
  shipped; the key pair is generated and held by nick, the public half goes in the TXT record.
- **D5. Release notes** — **decided (nick, 2026-10-19):** generated-then-edited
  `docs/releases/vX.md` → GitHub Release body, no CHANGELOG.md.
- **D6. `www.musterd.dev`** — **decided (nick, 2026-10-19): redirect it to musterd.io for now.**
  It served a stale copy of the site. **Done 2026-10-19**: a 301 Redirect Rule on the musterd.dev
  zone for `www.` and the bare apex only — never `*.musterd.dev`, where hosted teams live
  (`<team>.musterd.dev`, `deploy/cloud/fly.toml`); team hosts verified still 200; fifty told.

## 9. Not in this train, and where it lives instead

- The launch message, the post's copy, the calendar, YC / speedrun: traction plan, sloane, nick.
- Trademark attorney clearance before the post travels (lane `01M0130CYM`, unowned in practice —
  `docs/wiki/name-clearance.md` names a UK exact-mark conflict) and domain auto-renew
  (`01M0130E00`): both are launch blockers that are nick's, and neither is a car.
- Hosted Cloud's public story: ADR 475 is still proposed; the train carries the local product only.

## 10. Follow-up lanes (D1 adopted 2026-10-19)

1. `pnpm train status` (read-only, every surface) — slippy.
2. `pnpm train notes` + `docs/releases/` — slippy.
3. One install block + the surface-agreement test; README by-hand block fixed — slippy, with
   sloane on copy.
4. ~~ADR for D1/D2/D5~~ — [ADR 669](../../decisions/669-the-release-train.md).

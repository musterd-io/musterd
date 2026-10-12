# ADR 565: The platform repo is public and lives in musterd-io

- Status: accepted (2026-10-12, nick, in chat; executed by sloane the same hour)
- Date: 2026-10-12
- Lane: `01M4RRE5Z9DJX2JVRRZ7SNWFBZ` (sloane), goal `launch`
- Supersedes: [ADR 538](538-public-repos-in-musterd-io.md) decision 3 for the platform repo only.
  Reverses the private-preview visibility recorded in [ADR 302](302-musterd-io-public-site.md)
  Consequences (2026-10-03). ADR 538 decisions 1, 2 and 4 stand.

## Context

The platform monorepo went private on 2026-10-02 for the private preview, and the public site
dropped every link to it the next day (ADR 302 Consequences, PR #2004). On 2026-10-06 ADR 538
created the GitHub org `musterd-io` for public musterd repos, moved `skills` and `whiteboard`
there, and kept private repos in `SandRiseStudio` "until each goes public", because the CI and
review apps were installed on that org.

On 2026-10-12 nick asked whether the plan to move everything to the musterd org still held, and
on hearing that the move was gated on going public, decided to go public now and move.

Before the flip, sloane swept the last 4,000 commits for musterd credential prefixes
(`mskey_`, `msgr_`, `mscr_`), GitHub, Anthropic, Slack and AWS token shapes and private-key
headers: only test fixtures and the trace-scrub test matched. No `.env` or key file was ever
committed. GitHub secret scanning showed zero open alerts. The one exposed-credential incident on
the record (lane `01M3W42669`, a team agent key printed into a session transcript) concerns a
transcript, not the repository.

## Problem

ADR 538 tied the platform's move to going public. Going public was a product decision nobody had
taken, so the repo sat private in the studio's org while its public packages pointed at a URL
that did not resolve for a stranger, and every surface that names the repository carried the
studio's name rather than the product's.

## Decision

1. **`SandRiseStudio/musterd` is public as of 2026-10-12** and **lives at `musterd-io/musterd`.**
   Visibility was changed first, then the repository was transferred. GitHub redirects the old
   address for the web, the API and git.
2. **Everything in the repository is public from here on, history included.** ADRs, lane titles in
   commit messages, design docs, PR bodies and the wiki. The writing rule is unchanged because it
   was already the rule: no credentials, no customer names, nothing a reader outside the team
   should not see. A seat that finds something that should not be public treats it as an incident,
   not a cleanup.
3. **Every live surface names `musterd-io/musterd`.** Package `repository` and `bugs` fields, the
   package READMEs, SECURITY.md, the Homebrew formula's homepage, the site's nav link, JSON-LD and
   `llms.txt`, deploy scripts' defaults, the research dataset card, the design specs that quote
   the URL, and `content/roadmap.data.ts`. History (ADRs, archive, wiki, demo records, dated
   plans) keeps the old name; the redirect covers it.
4. **The Homebrew tap name does not change.** `brew tap SandRiseStudio/musterd` resolves to
   `SandRiseStudio/homebrew-musterd`, which stays where ADR 538 decision 3 put it until it moves.
   Those lines are left as they are.
5. **The install path is a separate decision.** Going public restores the link to the code. It
   does not by itself restore the hero install command, the Getting started install row or
   `/docs/getting-started`, which ADR 302's note removed as part of the private preview. Whether
   the preview is over is nick's call; the copy spec's `Not yet` row stands until it is made.

## Consequences

- Carried over by the transfer, verified 2026-10-12: branch protection on `main` with the `gates`
  required check, squash-only merging, auto-merge, delete-branch-on-merge, and the four Actions
  secrets.
- **Not carried over: GitHub App installations.** Ubicloud managed runners and Cursor Bugbot were
  installed on `SandRiseStudio`; `musterd-io` had no installations after the transfer. The one
  `ubicloud-standard-2` job cannot start until nick installs the Ubicloud app on `musterd-io`;
  the two CI runs in flight at transfer time were cancelled. Bugbot's advisory review (ADR 180)
  is off until its app is installed. Both need the org admin in a browser.
- Public repositories get 4-vCPU `ubuntu-latest` runners and unbilled Actions minutes again. The
  `ci-cost` goal's premises (ADR 492, 498, 499, 508, 510, 512: 2 vCPU, billed minutes) should be
  re-read against this; some of that work may now be optional. Not decided here.
- Seats update their remotes when convenient: `git remote set-url origin
  https://github.com/musterd-io/musterd.git`. Nothing breaks if they do not.
- ADR 302 and ADR 538 carry dated notes in their Consequences pointing here.
- The Watch page and Twitch strings that ADR 302's note reworded ("the open repository") are the
  copy owner's to restore under the watch-page and twitch-channel copy specs; not done in this
  change.

## Observability & Evaluation

n/a — repository visibility and ownership; nothing in the product emits or logs it. The check is
`gh api repos/musterd-io/musterd --jq '.visibility'` reading `public`, and
`git ls-remote https://github.com/SandRiseStudio/musterd` still resolving through the redirect.

## Falsifier

A live surface in decision 3 that still names `SandRiseStudio/musterd` as the repository after
this lands, or a `brew tap` line that was changed although the tap did not move.

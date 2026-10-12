# 538 — Public musterd repos live in the musterd-io GitHub org

- Status: accepted
- Date: 2026-10-06
- Deciders: nick (chose the org and its name), stanley (lane `01M2PAMFW1S3VEMPB1R7GYKNJT`)
- Relates to: ADR 330 (the whiteboard is its own package), ADR 537 (the whiteboard is Squig
  only), `docs/design/skills-that-travel.md` §2 (one skills repo; separate repos only for things
  with a runtime)

## Context

Every musterd repo lived in `SandRiseStudio`, the studio's GitHub org: the platform, `musterd-skills`
(public), `musterd-whiteboard`, `homebrew-musterd`, `musterd-lab` and `batond`. The npm packages
already share one scope, `@musterd`. The whiteboard was about to go public as
`@musterd/whiteboard`, which would have put its first public links under the studio's name rather
than the product's.

## Problem

Should everything musterd sit under one parent, and if so, which? Merging the repos was not the
question: `skills-that-travel.md` §2 already keeps all skills in one repo and gives only things with
their own runtime a repo of their own, and ADR 330 requires the whiteboard to run without musterd.
The question was the GitHub owner name a stranger sees. The plain name `musterd` is held by an
unrelated personal account (created 2019, one repo), so it is not available.

## Decision

1. **Public musterd repos live in the GitHub org `musterd-io`**, which matches the musterd.io
   domain. It was created by nick on 2026-10-06, on the free plan.
2. **Moved on 2026-10-06:** `SandRiseStudio/musterd-skills` → `musterd-io/skills`, and
   `SandRiseStudio/musterd-whiteboard` → `musterd-io/whiteboard`. GitHub redirects both old
   addresses, for the web, the API and git.
3. **Private repos stay in `SandRiseStudio`** until each goes public _(Amended 2026-10-12: the platform went public and moved to `musterd-io/musterd`, [ADR 565](565-repo-public-musterd-io.md); the rest of this decision stands)_: the platform, `musterd-revive`,
   `musterd-lab`, `batond` and `homebrew-musterd`. The CI and review apps (Ubicloud, ADR 517;
   Cursor Bugbot, ADR 106) are connected to `SandRiseStudio`, and moving a private repo would mean
   reconnecting them for no public benefit. A repo moves to `musterd-io` when it goes public.
4. **npm stays on the `@musterd` scope.** Repo names drop the `musterd-` prefix inside the org
   (`musterd-io/whiteboard` publishes `@musterd/whiteboard`).

## Consequences

- Install lines and package metadata name the new owner: `npx skills add musterd-io/skills`
  (musterd-io/skills#4), and `@musterd/whiteboard`'s `repository`, `homepage` and `bugs` fields
  (musterd-io/whiteboard#1).
- Old links keep working through GitHub's redirects. A redirect breaks only if someone creates a
  new repo at the old name in `SandRiseStudio`, so those two names should stay unused there.
- The org has one admin, nick. Seats act in it through his `gh` credential.
- 2026-10-12 — **The platform moved.** `SandRiseStudio/musterd` went public and transferred to
  `musterd-io/musterd` ([ADR 565](565-repo-public-musterd-io.md)), which supersedes decision 3 for
  that repo. `musterd-revive`, `musterd-lab`, `batond` and `homebrew-musterd` stay as decision 3 says.

## Observability & Evaluation

n/a — an organizational choice about where repos live. It is not agent-facing and changes no
runtime behavior.

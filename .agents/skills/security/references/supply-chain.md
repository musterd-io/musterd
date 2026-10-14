# Dependencies, CI, release and posture

Open for a new dependency, a workflow change, the release pipeline, or anything public about the
team's security.

## 1. What the incidents teach

Each recent npm compromise started with a stolen maintainer credential:
the Nx "s1ngularity" release (2025-08-26) used installed AI command-line tools with their
permission checks turned off to hunt secrets; chalk and debug (2025-09-08) followed a phishing
domain; the Shai-Hulud worm (from 2025-09-14, a second wave in November 2025) republished
packages with stolen tokens; keyv ("ChainDrop", 2026-08-04) shipped with valid build provenance
from a taken-over account and planted hooks in editor and agent settings files that run when the
repository is opened. Provenance proves which pipeline built a package; the safety of its source is a separate
question. (Vendor incident write-ups, paraphrased; see `PROVENANCE.md`.)

## 2. A new dependency

Before it is added, check and write down:

- **Need**: what it replaces and the alternative considered.
- **Maintenance**: active maintainers, recent releases, how they publish (2FA, trusted publishing).
- **Install scripts**: does it run code on install? Allow builds only for named packages.
- **Weight**: transitive dependencies it brings and their licences.
- **Signals**: known vulnerabilities (OSV), malware and typosquat signals (Socket and similar).
- **Version age**: wait a day or more before taking a brand-new release. pnpm's
  `minimumReleaseAge` enforces it (on by default from pnpm 11; off on pnpm 10 unless set), so
  check the team's config before saying it applies. It catches only releases removed within
  hours to days, so it is one layer among several.

(The OpenSSF guide to evaluating open source software, cited.)

## 3. CI workflows

- **Pin third-party actions by full commit hash.** Same-repository actions and the platform's own
  actions are judged separately.
- **Least privilege**: read-only token by default; write permissions per job, only where needed.
- **Untrusted triggers**: `pull_request_target` and comment-triggered workflows that check out or
  run a contributor's code are the classic way in; so is a `${{ }}` expression from a PR title,
  branch name or comment inside a `run:` step. Only report what an outsider without write access
  could trigger, with the whole path traced. (Adapted from Sentry's `gha-security-review`,
  Apache-2.0.)
- **Agents in CI**: a workflow that runs an AI agent on repository content runs whatever
  instructions that content carries. Scope its token to what it may do, and enforce limits in the
  token, where a prompt cannot undo them.
- **Lint workflows** (actionlint, zizmor) where the team runs them.

## 4. Publishing

- **Trusted publishing over long-lived tokens**: npm's OIDC trusted publishing generates
  provenance automatically; it needs GitHub-hosted runners. Packages can require 2FA and refuse
  tokens.
- **The lockfile is the truth**: install frozen, review lockfile changes like code.
- **SLSA levels and SBOMs** are worth their cost once releases are automated; on a manual release
  they describe a process nobody runs.

## 5. Public posture

- **Never** "secure", "unhackable", "zero vulnerabilities". Every tool disclaims what its output
  proves.
- **Say dated, checkable facts**: "no known unpatched vulnerabilities as of <date> per <tool>";
  "verify this package with `npm audit signatures`"; "reports go to <channel>; we respond within
  <stated time>".
- **Say what is not done yet** as plainly as what is. A candid list earns more trust than a badge.
- Words go through whoever owns voice; the facts and their dates come from you.

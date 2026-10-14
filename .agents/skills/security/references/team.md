# This team: musterd

The only file in this skill that names musterd's specifics. Read before the first piece of work in a
session. A team adopting this skill replaces this file with its own.

## The role here

- **Role file**: `security` in the team home (`.musterd/roles/security.toml`, outside the repository):
  "Application-security owner — threat models, authorized scans, validated findings, remediation
  proposals, and posture evidence". The charter grants no platform or admin authority; a finding
  becomes write work only after human review and a claimed lane.
- **Holder**: big-body. **The human who approves**: nick (scans without an audit lane, active
  testing, accepting a finding, disclosure timing, accepting a residual risk).
- **Routing in**: the platform skill sends credentials and keys here
  (`.agents/skills/platform/SKILL.md`). Infrastructure, the shared daemon, staging and service
  lifecycle go to platform (ADR 227).

## Sources

| Source                                          | What it holds                                                                                                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SECURITY.md`                                   | The disclosure policy: GitHub private vulnerability reporting on `musterd-io/musterd`; the boundary; what is not done yet                                                                                                      |
| `docs/design/security.md`                       | The threat model: principles, assets, trust boundaries, threats and mitigations, credential lifecycle, defaults and opt-ins                                                                                                    |
| `.github/REVIEW-RULES.md`                       | Review blockers: 1 unparsed input, 2 a leaked secret                                                                                                                                                                           |
| AGENTS.md hard rules 4, 5, 6, 8                 | Parse all external input with the protocol schemas; never log secrets (`mskey_`/`msgr_`/`mscr_`, shown once, sha256 on the server, chmod 600 on clients); no new runtime dependency without an ADR; write work stays in a seat |
| `docs/brand/leave-behinds/security-position.md` | Public posture copy; the credential-custody section is this role's                                                                                                                                                             |
| `SPEC.md` Appendix A.2                          | Servers store only hashes of credentials                                                                                                                                                                                       |

## How audits run here

From the role's first skill (2026-09), kept:

- **An audit runs in its own lane**, pre-authorized and declared high-stakes; claiming it
  authorizes scanning its stated scope. With no such lane, ask nick (blocking) before a whole-
  repository scan. Audit, remediation and public-posture work are separate lanes; public-posture
  work waits until every baseline finding is fixed, accepted or deferred by nick.
- **Baseline first**: identity, role, a clean workspace, the `origin/main` commit, plugin version
  and model.
- **Models**: the default model for triage and diff review; `gpt-5.6-sol` at `xhigh` for whole-
  repository or deep scans and for revalidating consequential fixes.
- **Where findings live**: manifests, candidates, traces, proofs and reports stay in the Codex
  Security temporary scan directory (the `codex-security@openai-curated` plugin, ADR 323), never in
  tracked files. Read-only helpers may write there; they never edit, claim, build or commit.
- **Telling nick**: a directed summary with no exploit detail (surface, severity, confidence,
  impact, containment). Reproduction steps move only over a channel nick approves.
- **A read-only audit lane** is submitted for acceptance without PR or commit evidence;
  remediation lanes follow the normal landed-PR flow.
- **Active testing**: a separate high-stakes lane and a blocking ask to nick naming targets, ports,
  time window, allowed and excluded techniques, resource ceilings, data policy, stop conditions and
  artifact retention. Staging does not waive the ask: every Strix run needs both. Strix only
  against disposable, isolated local staging with synthetic credentials and data; Shannon only when Strix does not fit and nick authorizes it. Neither enters
  the runtime or CI without an ADR. Never target the shared daemon at `localhost:4849`, another
  member's workspace, unrelated local services or external infrastructure.

## Decisions this role answers to

| Area                   | ADRs                                                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credentials and grants | 069, 076, 174 (human credential rotation), 328 (`msnode_`), 337 (team key is bootstrap-only), 344 (scoped bootstrap credentials), 350 and 403 (retiring the legacy team key), 557, 580 (human credentials need a human admin) |
| Custody                | 200 (proposed: no real-user release until an agent seat cannot read a human credential), 341 (accepted as a gate: a distinct OS user per agent for real users)                                                                |
| Network                | 040 (no plaintext non-loopback bind; WebSocket Origin and Host gate), 132 (the UI is served same-origin), 134 as amended by 580                                                                                               |
| Remote and cloud       | 446 (remote MCP over HTTPS with per-seat OAuth 2.1), 449, 450, 452, 456, 463 (each reviewed by this role), 475 (proposed: Postgres row-level security)                                                                        |
| Traces                 | 184 (credential scrub), 445 (scrubbed at the hook and at ingest), 478 (retention)                                                                                                                                             |
| Acceptance             | 169 (risk tags route a review to a human first), 530 (lanes on `packages/web/**` and `packages/mobile/**` declare risk at open), 338 (proposed: a review finding is not a fix request; security findings are exempt)          |
| Supply chain           | AGENTS.md hard rule 6 and `change-adr:check`; 579 (licences you may adapt from)                                                                                                                                               |
| Hosted seats           | 588 (a resident seat's API key is read at spawn and never stored or logged), 583 (the metering gateway binds loopback)                                                                                                        |
| Public repository      | 565 (public since 2026-10-12, after a credential sweep of 4,000 commits)                                                                                                                                                      |

## Where it runs (what a weakness reaches)

- **The local daemon**: loopback by default (ADR 040); the shared one is `localhost:4849`.
- **musterd Cloud**: `deploy/cloud/` (Fly app `musterd-cloud`, `MUSTERD_HOST=0.0.0.0` behind
  public HTTPS) and the cloud seat image in `deploy/cloud-seat/`. A weakness here is reachable from
  the internet; check it first when sizing a report.
- **Published packages**: `@musterd/cli` and its siblings on npm. Compare the published version
  with `main` (`npm view @musterd/cli version`) to know which users a fix must reach.

## Where the controls are in code

- Credential kinds and detection: `packages/protocol/src/credentials.ts` (`TOKEN_PREFIXES`,
  `containsMusterdCredential`).
- Generation and hashing: `packages/server/src/store/members.ts` (`newSecret`, `hashToken`).
- Bind and origin checks: `packages/server/src/config.ts` (`assertBindSecurity`, `isLocalPeer`,
  `checkUpgrade`); the single loopback-trust decision is `packages/server/src/cloud/localTrust.ts`.
- Redaction: `packages/protocol/src/traceScrub.ts` for traces; `packages/server/src/log.ts` for
  request paths and error text.

## Gates and checks

| Check                                      | What it holds                                                                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `change-adr:check` (in CI)                 | A new runtime dependency or a protocol schema change needs an ADR                                                                         |
| `build-context:check` (in `format:check`)  | `.dockerignore` excludes `.musterd/` for every whole-context Dockerfile                                                                   |
| GitHub secret scanning and push protection | On for the repository                                                                                                                     |
| Dependabot alerts                          | Triaged by hand (`docs/wiki/dependabot-alerts.md`)                                                                                        |
| `pnpm install --frozen-lockfile`           | Only `better-sqlite3` and `esbuild` may run build scripts; `pnpm.overrides` hold version floors; pnpm 10, with no `minimumReleaseAge` set |
| Workflow actions                           | Third-party actions pinned by commit since #2388 (2026-10-12)                                                                             |

## Incidents on record

| Date       | What happened                                                                                                                                                                     | Rule it gave                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 2026-08-06 | A live credential pasted into a test fixture; push protection caught it (`docs/wiki/instrument-silence.md`)                                                                       | Fixtures are synthetic by construction                 |
| 2026-09-15 | A seat binding holding a live `mskey_` was baked into four published container images because `.dockerignore` lacked `.musterd/` (ADR 403; `docs/wiki/authorised-but-unowned.md`) | `build-context:check`; retire the legacy key (ADR 350) |
| —          | The team agent key printed into a session transcript (lane `01M3W42669`, ADR 565)                                                                                                 | Never echo a secret to anything an agent reads         |
| 2026-10-13 | A ReDoS in `globsOverlap` (#2443)                                                                                                                                                 | Bound member-supplied patterns                         |

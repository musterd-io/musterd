# 662 — One machine per hosted seat; human authority is a device signature; musterd builds no sandbox

- Status: accepted
- Date: 2026-10-19
- Deciders: nick (in chat, 2026-10-19), with big-body, ghost, fifty and lazara in huddle `01M5AMZMX580F3XYP9S1XYBRFJ`
- Lane: `01M5AM1WW6QVMW08PK39ZXZ0W5`
- Supersedes: [ADR 341](341-shared-team-custody.md) decision 2; [ADR 200](200-credential-custody-and-the-real-use-gate.md) §3's wording of the gate (the gate itself stands, restated in decision 3); [ADR 647](647-cloud-agents-compute-home.md) decision 1's phase 2 (parked, decision 2)
- Extends: [ADR 618](618-channel-answers-actor-is-not-authorizer.md) §2's A2 from channel answers to every transport

## Context

The [hosted tier spec](../superpowers/specs/2026-10-19-hosted-tier-one-machine-per-seat-design.md)
(#2897) records a brainstorm with nick on 2026-10-19. A first draft proposed one OS user per seat
on hosts musterd provisions, building ADR 341 decision 2. nick rejected per-seat OS users
outright, and then asked whether musterd should be in the sandbox business at all. ADR 320 says
no ("Rejected: claiming containment"). But ADR 656 (a sandbox around resident-seat bash), ADR 658
(deny rules written into harness configs) and ADR 647 (agents on musterd's compute) had all pulled
that way.

ADR 341 decision 2 was not a stand-alone rule. It was the chosen way to close ADR 200's release
gate: "a release may go out for others to use only when an agent seat cannot read a human
credential". ADR 200 §4 lists three barriers: (1) agents as a separate OS user, (2) interactive
custody on human-authority acts, and (3) second-device confirmation. Ruling out (1) left the gate
open with no route through. Today any agent on a person's laptop runs as that person, can read
`~/.musterd/config.json`, and can act as them.

nick asked for a huddle with big-body (security), ghost (away channels), fifty (infra) and lazara.
All four converged on one shape, and nick directed it be written as this ADR.

## Problem

1. Without separate OS users, what keeps one hosted seat from another seat's notes and
   credentials?
2. Without separate OS users, what stops an agent on a laptop from exercising its human's
   authority, when the seat and the human run the same `musterd` binary as the same OS user, so
   process identity and file permissions cannot tell them apart?
3. How far into sandboxing should musterd go?

## Decision

1. **musterd builds no sandbox, and runs no seat under an OS user of its own.** Where musterd
   hosts, it rents the boundary. Where a person hosts, it configures the harness's own sandbox
   (ADR 658), and the harness enforces it. musterd does not design, own or maintain an isolation
   mechanism. ADR 341 decision 2 and ADR 200 §4's barrier (1) are withdrawn.

2. **One microVM per hosted seat, as a rule.** A Fly Machine is a Firecracker microVM, and the
   machine is the boundary between seats. Seats do not share a machine. ADR 647's phase 2 (one
   agent machine per team) is parked. It reopens only if ADR 647 phase 1 measures that compute is
   more than 30% of a hosted seat's total cost (compute plus model spend) over its pilot week, and
   then only through its own ADR. If sharing is ever taken, the boundary is a rented hardened
   container (gVisor-class), never OS users and never a container runtime musterd configures.

3. **The gate, restated: a release goes out for real users only when an agent cannot exercise
   human authority.** ADR 200 §2's principle is unchanged: the capability must be absent, not
   mitigated. What changes is what the gate measures. A bearer credential an agent can read is
   outside the gate when it cannot perform a high-authority act (decision 4).

4. **High-authority acts are a closed list, kept in protocol code with a test that pins it:**
   - a human's accept or decline wherever it counts as human acceptance or a human answer
     (ADR 192, ADR 603, ADR 127 `request.decide`, a gate release under ADR 150);
   - anything that sets `authorized_by`;
   - admin acts: team policy, roster changes, member removal, team settings;
   - grants (ADR 146);
   - minting any credential or key, a sponsor host key included (ADR 463, ADR 648);
   - creating an agent (ADR 459);
   - enrolling, revoking or recovering a device key (decision 6).

   Provisioning verbs a host key may call (ADR 648 decision 1) are agent-kind and stay off the
   list. An agent-kind credential is refused for every listed act, whatever it carries.

5. **The proof is an A2 signature over a server-built descriptor, on every transport.**
   - For a listed act, the server builds a canonical approval descriptor: actor, act, target,
     payload digest, audience, expiry and a one-use nonce.
   - The act is accepted only with a signature over that descriptor, by a device key bound to that
     human, made with fresh user presence. Authorization is never cached.
   - HTTP, WebSocket, CLI and MCP all go through the same check. No transport, flag or daemon path
     bypasses it.
   - The surface that asks for presence renders the descriptor from server data, never from the
     caller's arguments. The caller cannot word the prompt.
   - ADR 618's A2 is this signature, extended from channel answers to every transport. Assurance
     follows the signature and its key binding, not the surface. A button tap, a Slack HMAC (A1) or
     a bearer credential stays advisory for every listed act.

   Three authenticators, one verifier:
   - **On the laptop:** a Secure Enclave key usable only by a code-signed musterd helper that
     fetches the descriptor itself. A key reachable by any `node` process does not qualify,
     because an agent can run its own script and word the prompt.
   - **In the browser:** a passkey on musterd's own origin (the daemon, or musterd.io). A
     relay-hosted page does not qualify (ADR 618 §2).
   - **On the phone:** the paired device's key (away channels), signing descriptor, digest and
     nonce, redeemed through ADR 623 §6's existing recheck.

   A Linux laptop without a platform key uses the browser passkey or the phone.

6. **A device key never authorizes itself.** Enrolling, revoking and recovering a device key are
   themselves listed acts (decision 4). The first enrollment, and recovery after losing every
   device, go through an explicit, audited human path. No key can be enrolled from an agent
   process or a relay tap.

7. **Hosted seats need nothing beyond decision 4.** A hosted seat's machine holds no human
   credential by construction (ADR 648). What a seat can exercise there is its sponsor's model key
   and a repo-scoped GitHub token, and those are governed by the metering gateway and the token's
   scope, not by presence.

8. **ADR 656 is not decided here.** The resident-seat pilot's pre-registered kill rule
   (`docs/research/resident-seat-pilot-manifest.md`) decides whether a laptop resident seat runs
   code. If it ships coordination-only, a laptop resident seat has no bash to sandbox. If the
   worker shape wins, nick chooses between keeping ADR 656 as hygiene, not a boundary, and running
   code-running seats on a harness whose own sandbox musterd configures.

## Consequences

- **The gate still blocks launch.** It closes when human authority 1 to 3 land, plus the phone
  key in pairing. Until then, ADR 200 §3's publish and promotion limits stand.
  Follows-up: 01M5ANFFVHY07ZTYEECTRSTXTN
  Follows-up: 01M5ANFKEVTENBNVG9JQKA965N
  Follows-up: 01M5ANFZEQJN69EEV9T8EHT66S
  Follows-up: 01M50XPYZ9877E494X2SV1EGTB
- **Friction moves onto the listed acts.** Each one costs a Touch ID tap, a passkey or a phone
  confirm. Everything else a human does is unchanged. In-session acceptance in a harness becomes
  "accept, then tap". A sponsor's one-command agent setup becomes one command plus two taps
  (create agent, mint host key). A headless sponsor, such as CI minting seats, uses the phone.
- **The prompt text is now a security property.** A presence prompt whose words an agent can
  choose is a phishing surface against the human. That is why decision 5 requires the descriptor
  to be rendered by the authenticator from server data, and why a bare Secure Enclave key reachable
  from `node` is not enough.
- **ADR 647.** Phase 2a (lane `01M55Y5DQHKY2235KKA79T06NH`) is parked behind decision 2's
  threshold. Phase 1 already measures cost per seat-day, so no new measure is needed.
- **ADR 320.** The containment rejection stands. A seat musterd hosts can be described by its
  machine boundary ("each hosted agent runs on its own machine") once the machine-half canary
  (lane `01M561ZCDS5TYWD6NTBQP63ABY`) passes. No sandbox claim is made anywhere.
- **The laptop tier is unchanged.** The ADR 658 deny rules and the note protections of memory
  isolation lanes 1 to 6 (ADRs 653, 654 and 657 among them) remain a courtesy wall against stumbling. What changes on a laptop is that an agent which reads
  the human's credential can no longer perform a listed act with it.
- Dated notes go into ADRs 200, 341, 647 and 320 in the same commit, with markers beside the text
  they qualify.
- _(2026-10-19: human authority 1 landed the descriptor, the closed list in protocol code
  (`HIGH_AUTHORITY_ACTS`, pinned by test), and the server gate (`requireAuthority`), with
  activation per-human on enrollment (nick's call): an agent-kind credential is refused for a
  listed act outright, and a human's listed acts require A2 once that human has an enrolled
  device key — enrollment latches, so revoking every key is the lost-device case, never a
  reopening of the Bearer path. Guarded surfaces: team and governed policy, admin-path grant
  issue, agent create, human counterpart lane closes, `merged.authorized_by`, and human
  verdicts on the act path. Enrollment (lane 2) and the authenticators (lane 3) follow; the
  gate closes when all three have landed and humans are enrolled.)_
- _(2026-10-19: human authority 2 landed the device-key lifecycle (decision 6). The first key
  — and recovery when every key is lost — goes through a one-time enrollment code minted from
  the human's existing credential (sha256 stored, ten minutes, one use, never audited). Once
  any key stands, further keys enroll by that key's `device_key_admin` signature; revocation
  is by a different standing key or by code, and a key never revokes itself. An agent member
  can never enroll. `musterd authority enroll|keys|revoke` is the terminal surface; the
  authenticators (lane 3) replace its file-stored private half.)_
- _(2026-10-19: human authority 3 landed the authenticators (decision 5). The passkey path is
  end to end: the daemon serves enroll and approve pages from its own origin (never the
  relay); enrollment is a WebAuthn registration whose challenge is the enrollment code;
  approval renders the server-built descriptor (descriptor rows now remember what they were
  built for), takes an assertion whose challenge is the descriptor nonce, verifies it
  against the enrolled credential, and parks the proof for the waiting surface — the act
  re-verifies at presentation. The verifier is hand-rolled CBOR/COSE (EdDSA and ES256, no
  new dependency) and possession-grade: no attestation statement is checked, because no
  authenticator allowlist exists. The terminal helper fetches the descriptor itself and
  signs with the local key; the code-signed Secure Enclave helper rides the same protocol
  once a signing identity exists.)_
  Follows-up: 01M5B73NG2E2A4XXBW9FG9ND8Z
- _(2026-10-19: HA1 re-review (lazara, declined #2963) wired the three listed acts that had
  no caller: `admin.roster` (member add, remove, ceiling), `admin.team_settings` (team
  archive) and `credential_mint` (bootstrap mint including host keys, human credential
  rotate, agent-key rotate) now pass `requireAuthority`, each with a transport falsifier.
  The nonce spend is one conditional `UPDATE … WHERE used_at IS NULL`, so concurrent
  presentations of one proof yield exactly one approval.)_
- _(2026-10-20: HA2 re-review (lazara, declined #2966; nick chose passkey-first in chat)
  removed the self-issued enrollment code: the code was minted and spent by whoever held
  the human's Bearer, so an agent with `config.json` enrolled its own key and signed
  (proved end to end). First enrollment and lost-everything recovery are now a
  user-verified passkey ceremony over a server challenge that authorizes nothing by
  itself; once a key stands, enrolling or revoking requires a standing key's
  `device_key_admin` signature, the challenge path being reserved for zero active keys.
  Lazara's attack is a transport falsifier (`authority-lifecycle-http.test.ts`).)_
- _(2026-10-20: HA3 re-review (lazara, declined #2968) closed the two authenticator
  gaps. The CLI's file-stored software key is gone (with HA2's passkey-first CLI);
  a software key may still be recorded under the honest kind `software`, and
  `requireAuthority` refuses it as `assurance_too_low` however valid its signature —
  never spelled `platform`. Passkey ceremonies now pin `clientData.origin` to the
  daemon's configured origins (its own request origin plus `MUSTERD_WEBAUTHN_ORIGINS`,
  e.g. musterd.io) and check the rpIdHash against that origin's host, at enrollment,
  at proof parking, and at presentation — a relay-hosted page's ceremony never
  verifies.)_

## Observability & Evaluation

- **Traces:** every listed act's audit row records its assurance (`A2`), the authenticator kind
  (`platform`, `passkey` or `phone`) and the device key id. A refusal writes `authority.refused`
  with a reason: `no_signature`, `assurance_too_low`, `descriptor_mismatch`, `expired`,
  `nonce_reused`, `key_revoked` or `agent_credential`. No signature, nonce or descriptor payload
  is logged (hard rule 5).
- **Eval:** ADR 200's adversarial eval, restated. From an agent seat, with no new code, try each
  listed act using everything that seat can read, the human's `config.json` included. Every attempt
  must be refused. A second case attacks the prompt: an agent requests a signature for act X while
  the prompt shows act Y. It must be impossible to construct on every authenticator. It runs in
  `gates` as a server test, and on a real laptop before launch.
- **Experiment:** friction, pre-registered. Count listed-act prompts per human per active day over
  the first two weeks after human authority 1 lands. If the median passes 15, the list in
  decision 4 is reviewed for acts that can be batched or moved off it, through a reviewed protocol
  change, never by caching.

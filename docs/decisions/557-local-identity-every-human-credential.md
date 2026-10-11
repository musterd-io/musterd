# 557 — Local identity offers every human credential on this machine

- Status: accepted
- Date: 2026-10-10
- Deciders: nick ("a user should be able to login to any human seat on the team that they have the
  credentials for", 2026-10-10)
- Lane: `01M4M5AP1FS8G0DFQGR13HV5AZ`
- Builds on: [ADR 222](222-answerable-asks-on-live.md) (one-click sign-in on `/live`)

## Context

ADR 222 gave `/live` a one-click "Sign in as ⟨you⟩". The page calls the localhost-gated
`GET /teams/:slug/local-identity`, and the daemon answers with "the identity the CLI already holds
for this team". It reads that from `identities[<slug>]` in `~/.musterd/config.json`.

`identities[<slug>]` is one slot, and the whole machine shares it. Every seat that claims from a
folder on this laptop writes its seat into that slot. The CLI also keeps a vault,
`knownIdentities`, which holds every identity it has ever held: human credentials (`mscr_`) and seat
keys alike.

## Problem

On 2026-10-10 the slot held ryder's seat key (`msac_`). The route refuses anything that is not a
human credential, so it offered nobody. nick could not sign in to `/live` with one click, on
`:4849` or on the `:5174` dev preview. His own credential was in the vault the whole time.

A machine can also hold credentials for more than one human on the team. ADR 222 offers at most
one of them.

## Decision

1. The daemon reads every human credential for the team (`readLocalIdentities`, server
   `config.ts`): first `identities[<slug>]`, then each `knownIdentities` entry whose `team` matches.
   It keeps only `mscr_` credentials, and each distinct (name, credential) pair once.
2. The route offers, for each member, the first credential that still authenticates as that member.
   The check is `authMember`, the same read-only check that every authenticated request runs. A
   stale, rotated or departed vault entry is skipped and never reaches the page, and a stale entry
   does not hide a working one behind it.
3. The response adds `identities: [{as, credential}]`. `available`, `as` and `credential` remain
   and describe the first offer, so a `/live` bundle published before this change still works.
4. When signed out, `/live`'s identity slot shows one "Sign in as ⟨name⟩" for each offered member.
5. Nothing else changes. The route is still localhost-gated, refused off this machine and audited
   when refused. The paste path still accepts any human credential, from any machine.

## Consequences

- One-click sign-in no longer depends on which seat last claimed from this laptop.
- Several humans who share one machine each get their own button. This is the reason the list is
  not a single "best" identity: the daemon cannot know which person is at the keyboard.
- The vault is now read by the daemon as well as the CLI. It stays best-effort: a missing or
  malformed vault is "no identity", never an error.
- Out of scope: the shared slot can still be overwritten by a seat's claim, so the CLI's own
  "current identity" on this machine can still be a seat. That affects `musterd live`/`board`, which
  stage a handoff from the slot. They are not changed here.

## Observability & Evaluation

**Traces.** n/a — the successful offer is deliberately not audited (ADR 222: a row per page load
would record when a human had the office open). A refused off-machine request is still audited as
`signin.handoff_missed`, unchanged.

**Eval.** Server integration tests (`integration.misc.test.ts`, the "local sign-in identity" suite)
pin four facts: the vault fallback when the slot holds a seat key, several humans offered, other
teams excluded, and a stale credential skipped in favour of the working one behind it. Web tests pin
the list read (including a pre-557 daemon's single answer) and one button per offered member.

**Experiment.** On this laptop, with `identities.revive` holding a seat key and the vault holding
nick's credential: `/live` signed out shows "Sign in as nick", and one click signs him in.
Falsifier: on a laptop whose vault holds a working `mscr_` for the team, `/live` signed out shows
no "Sign in as ⟨name⟩" for that member.

---
name: courier
description: The courier role — the seat that moves team material between the team's machines and networks (files, artifacts, datasets) when git and the sync surface are the wrong carrier. Use when you hold the courier role and a teammate needs something carried; or when you need something moved and must find who can do it. Carries the routes table (Taildrop first), the ask shape, and the rules a transfer follows.
---

# courier

You move things for the team across machines and networks. Not code — code travels by git — and
not acts, lanes or presence — those travel on the daemon's sync surface. The rest: a dataset on one
laptop that a seat on the other needs, a built artifact, a recording, a research output that must
not touch GitHub. The role is **route-agnostic**: it is the authority to carry, and the routes
below are the ways the team has set up so far. A route exists for you only once it is listed here
and its harness rule is compiled into your seat (ADR 261); nothing else counts.

A Role is responsibility, not permission to read a teammate's Workspace or to decide what the team
shares. You carry what a teammate or a human asks you to, within the rules below.

## Who holds it

`team_members {role:'courier'}` / `musterd team members --role courier`. One holder per machine is
the honest shape, since a route runs from the machine the holder's seat sits on. If nobody holds
it, the reply lists the team's roles and the request goes to a human (`ask`, species `consult`):
assigning the role is a roster commit (`musterd role assign <seat> courier`, in the roster home).

## If you need something moved (any seat)

1. Find the holder (above). Do not try the route yourself: your harness has no rule for it, so the
   call is refused — and a refusal is the design, not a bug to work around.
2. Send `request_help` to the holder with the four facts a courier needs:
   **what** (exact paths, sizes if large), **from** (which machine / seat the material sits on),
   **to** (which machine, and where on it), **why** (the lane it serves). Say if it must stay off
   GitHub.
3. Receiving may need a human at the far machine (Taildrop does). Say who is there.
4. Never route private team material through a public or semi-public carrier as a workaround —
   not a gist, not a PR, not a pasted body. If the courier is unreachable, `ask` a human.

## If you hold it

Before promising a transfer:

- **Confirm the role and the route.** `team_members {role:'courier'}` names you, and the route's
  harness rule is in your seat's compiled block (`musterd role show courier` lists the toolkit's
  rules; `musterd doctor` reports a missing block). A rule you added by hand is not the role —
  if the compiled one is absent, the role was never assigned here: stop and say so.
- **Check the material.** Team material, named by the requester, that a human on the team would
  be fine seeing moved. Credentials, keys, grants and anything `mskey_`/`msgr_`/`mscr_` never
  travel by courier unless a human asked for exactly that transfer in an `ask` you can cite.
- **Check the far end.** The destination machine is on the network the route uses and someone can
  receive there.

Then:

- `accept` the `request_help` (`reply_to` its id), run the route, and post one `status_update`
  naming the files, source, destination and route — that line is the transfer's record.
- If anything above fails, `decline` with the reason; a hunch that the material is not yours to
  move is a reason.
- The courier gets no say over content. If you think the transfer is a mistake, say so once in
  the `decline` and let a human decide.

## Routes

The table is the whole inventory. Adding a route is one PR: a row here, its allow rule in the
courier toolkit (`.musterd/toolkits/courier.json`), and `musterd role assign` re-run so the rule
compiles into each holder's seat.

| route                              | from → to                               | holder runs                                                                                                         | far end                                                                                   | limits                                                                                                                                                |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Taildrop** (Tailscale file send) | a machine on the team tailnet → another | `tailscale file cp <files…> <host>:` — `<host>` is the tailnet name from `tailscale status` (e.g. `swethas-laptop`) | a person runs `tailscale file get <dir>` on the receiving machine; files land in that dir | both devices on the tailnet and awake; one-way; no directories (name files); a human must be at the far end; harness rule `Bash(tailscale file cp *)` |

**First use, 2026-10-04:** `items.jsonl`, `results-jev.jsonl`, `results-laya.jsonl`
(~480 KB) from nick's laptop to Air 2 (`swethas-laptop`) for lazara's lane 01M41QMZT1 — the Jev /
Laya research outputs, kept off GitHub by request. The transfer was first refused by the holder's
harness as an outbound transfer; nick granted the rule, and this role exists so that grant is a
compiled artifact of a role instead of a hand edit.

## What this role is not

- Not a daemon or a sync change. The hub/joiner sync surface (docs/guides/second-machine.md) is
  what crosses the tailnet for the team's record; the courier carries what that surface was never
  meant to.
- Not a gate on other seats. Today a non-holder is stopped by its own harness (no rule) and by this
  skill's instruction to ask. A musterd-side deny that names the holder is its own lane
  (`01M44T6343VZ7ZC3YTBXAQ731A`); until it lands, Codex and OpenCode seats have only the first of
  those two.
- Not an archive. The courier moves; where the material lives afterwards is the requester's lane.

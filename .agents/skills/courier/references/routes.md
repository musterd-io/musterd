# Running a route, and adding one

Open to run a route, to read its failures, or to add a new one. The team's actual routes and
machines are in `references/team.md`; this file is how routes work.

## 1. Taildrop (Tailscale file send)

Tailscale's documentation still calls Taildrop alpha (last validated 2026-01-05). An admin turns
on "Send Files" for the tailnet.

- **Who can send to whom**: only between devices owned by the same Tailscale user, and never to
  or from a tagged device. Tailnet access rules do not widen this.
- **Send**: `tailscale file cp <file>… <host>:`. The target ends in a colon; `<host>` is the
  device name from `tailscale status`. Directories are refused ("directories not supported"):
  pack them first (`references/material.md` §4).
- **Offline far end**: the send does not fail; it warns after a few seconds and keeps trying. Put
  a time limit on it and report the far end as unreachable when it runs out.
- **Receive**: on macOS and Windows, files land straight in Downloads. On Linux they wait in an
  inbox until someone runs `sudo tailscale file get <dir>`, and arrive owned by root. With
  `file get`, a name collision skips the file by default and leaves it in the inbox;
  `--conflict=rename` keeps both.
- **Names**: the receiver rejects `\ : * " < > |` and names over 255 bytes. Rename or pack first.
- **Interrupted transfers** resume for about an hour, except to a macOS or iOS receiver; in-flight
  files carry a `.partial` suffix. Taildrop shows no whole-file hash, so the manifest is the check.
- **Errors worth knowing**: "peer is owned by a different user" and "missing required Taildrop
  capability" both mean the route cannot reach that device; stop and say so.

(Tailscale documentation and CLI source, cited.)

## 2. When a route is refused

A refusal can come from three places: the route itself (above), the harness (a permission prompt
or a built-in check on outbound transfers), or the team's gate (the role is not yours). In every
case: stop, say which refused and what it said, ask a human, and tell the requester the
transfer is waiting and on whom. Do not try another tool, a
different spelling of the command, or a public carrier.

## 3. Other carriers, if the team adds one

Trade-offs to weigh when proposing a route (none is a route until the team adds it):

| Carrier                           | In transit | Far end proven by                                    | Directories | Resume     |
| --------------------------------- | ---------- | ---------------------------------------------------- | ----------- | ---------- |
| rsync or scp over Tailscale SSH   | encrypted  | the tailnet identity                                 | yes         | rsync yes  |
| magic-wormhole                    | encrypted  | a short code read aloud                              | yes         | no         |
| croc                              | encrypted  | a shared code                                        | yes         | yes        |
| Syncthing                         | encrypted  | device IDs                                           | yes         | yes        |
| Object storage with a signed link | TLS        | whoever holds the link (a bearer secret, up to days) | per object  | per object |

## 4. Adding a route

A route is real when all of these are done, by the people who own each part:

1. A row in `references/team.md` with the command, the far-end step, the limits and the
   permission rule.
2. The permission rule in the courier toolkit in the team's roster repository, and the role
   re-assigned so the rule compiles into each holder's seat.
3. If the team gates routes by role, the route declared in team policy so a non-holder is
   refused by name.
4. A first transfer recorded like any other.

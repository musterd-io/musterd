# Cloud agents phase 2b: a hosted seat on a laptop-hub team, as a joiner

**Date:** 2026-10-21
**Seat:** fifty
**Status:** design, from the 2026-10-17 cloud agents brainstorm (§4.3, §6 #4) and nick's call on
2026-10-21 (joiner daemon, not a remote actuator). Nothing is built.
**Lane:** `01M55Y5E28EPF6RNTCREYKQ6CP` (goal `cloud-agents`)
**Decision:** ADR 688 (to write; `pnpm adr:next` on 2026-10-21)

## 1. What this is for

Phase 1 (ADR 647/648, lane `01M55Y58R3`) hosts a sponsored seat on a Fly machine against a
**hosted** team: the machine runs no daemon and polls the Cloud server over HTTPS. A laptop-hub
team (ADR 376) has no such server on the internet, and it sleeps. Phase 2b gives a laptop-hub
team the same hosted seat: the agent machine runs its own daemon as a **joiner** (ADR 325/328),
replicates with the hub over the tailnet, and the seat lives on the joiner.

**Success:** a sponsor on a laptop-hub team runs `create.sh <seat> --hub <tailnet-name>` once,
and the seat is on the roster, provisioned, wakeable and metered, with **no human identity on
the machine** — and the machine stays enrolled across hub sleeps.

## 2. Why delta's shape cannot be reused as it was

Delta (`deploy/cloud-seat`, retired 2026-10-15, log `docs/perf/cloud-seat.md`) was the
measured precedent, and every item on its friction list has one root: **the machine acted as
nick.** `team create --as nick` on the joiner minted nick's credential locally; everything after
(agent mint, residency on, policy) rode it.

| delta friction                                      | root                                                            |
| --------------------------------------------------- | --------------------------------------------------------------- |
| 1. pushes `403 bound_elsewhere` until `node trust`  | joiner events authored as nick, who is bound to the hub's node |
| 2. the team agent key is daemon-private             | the actuator needed *a* key the local daemon honours            |
| 3. `agent --path` makes a bare folder               | provisioning by hand instead of the provisioner                 |
| 4. a cloned team home is not a roster root          | `team create` on a clone                                         |
| 5. `musterd reload` is macOS-only                   | entrypoint SIGHUPs — fine, stays                                 |

ADR 648 and ADR 662 now forbid the root outright: a hosted machine holds no sponsor binding and
no human credential, ever. So 2b does not fix delta's steps; it removes the identity that
needed them. Items 1 and 4 vanish (nothing on the joiner authors as a human; the roster arrives
by replication, not by `team create`). Item 3 vanishes (the ADR 463 provisioner stands the
workspace up). Item 2 becomes the one real question, §3.

## 3. The one question: which credential does the joiner's daemon honour?

The phase 1 provisioner (`musterd host --cloud-provision`) authenticates every call with the
**sponsor host key** (ADR 648): claim the provision, mint the seat's `claim_seat` credential,
issue its grant, enrol residency, then poll wake leases. On a hosted team all of that hits the
one Cloud server that minted the key. On a joiner the host loop must hit the **local** daemon
(so wakes derive from folded acts while the hub sleeps, as delta's did) — and the local daemon
has never seen the key: credential hashes, grants and `host_provisions` are residence-1 facts
that do not replicate (ADR 393 §2: "grants are residence 3"; `sync/fold.ts` projects none of
them).

Options weighed:

- **(a) Point the host loop at the hub over the tailnet** (phase 1 unchanged, `--server
  http://<hub-tailnet>:4849`). No sync work; but no wakes while the hub sleeps, and the joiner
  daemon becomes decorative. Rejected: it is the remote-actuator shape nick declined.
- **(b) Mint the host key on the joiner.** Minting is a high-authority act (ADR 662 d4) and
  needs the sponsor's signature at the joiner — the sponsor is not there. Rejected.
- **(c) Replicate sponsor-scoped credentials and pinned provisions to joiners** — chosen.

### 3.1 Decision (c), the shape of ADR 688

1. **Sponsor-scoped credential hashes cross the wire.** `credential.minted` and
   `credential.revoked` ledger events (kind `ledger`, the ADR 393 pattern: a tag, two verbs, a
   projector) carry `{id, use, target, host, sponsor, sha256}` for `use: 'host'` keys **minted
   by a sponsor** and for `claim_seat` credentials whose target is a sponsored agent. The
   projector upserts/deletes `agent_bootstrap_credentials` on joiners. Never the team agent key
   (stays daemon-private — delta's finding 2 answered), never an admin-minted team-wide key,
   never a human credential (ADR 662 d7 holds: the machine still holds no human authority).
2. **A host-pinned provision crosses the wire.** `host.provision_*` ledger events project
   `host_provisions` on joiners, and a joiner may claim **only a provision pinned to its own
   host label** (#3071). A pinned provision has exactly one eligible host, so the claim needs no
   hub arbitration (ADR 361's ownership-edge rule is for contended edges). Unpinned provisions
   stay hub-only. `create.sh` already pins.
3. **The ADR 648 verbs run at the joiner, locally.** With (1) the host key authenticates at the
   local daemon; `hostKeyScope` resolves the sponsor from the replicated roster; the seat
   credential and grant are minted locally (ADR 393 §2: the origin mints grants); enrolment
   replicates to the hub (ADR 393 §1) so the hub roster shows the seat `wakeable` on the joiner.
4. **Push residence holds.** Events the joiner authors are authored by the seat (occupancy) or
   carry `via: 'host_key'` (ADR 648 §3); none is a human's, so ADR 360's check passes without
   `node trust`. A test pins it: a joiner push with a human author is still refused.

### 3.2 What the hub-asleep case actually buys

While the hub is unreachable the joiner can wake the seat on already-folded directed acts and
the seat can answer them; it **cannot claim a lane** (ADR 355 §3: `hub_unreachable` refuses the
claim) and its own acts queue until the hub returns. That is delta's measured behaviour and it
is accepted for 2b; ADR 688 says it in Consequences so nobody reads "always on" into a laptop
hub. The floating-seat lane (`01M55PDGG8`) is where leases move to the hub.

## 4. The machine

`deploy/cloud-agent` gains a **hub mode** rather than a second deploy folder:

| env                   | hosted (phase 1)        | hub mode (2b)                                   |
| --------------------- | ----------------------- | ----------------------------------------------- |
| `MUSTERD_SERVER`      | `https://<team>.musterd.dev` | `http://127.0.0.1:4849` (the joiner)       |
| `MUSTERD_HUB`         | —                       | the laptop's tailnet name                       |
| `TAILSCALE_AUTHKEY`   | —                       | first boot, scrubbed (delta's entrypoint §1)    |
| `MUSTERD_INVITE`      | —                       | `musterd node invite` on the hub; first boot    |
| `MUSTERD_HOST_KEY`    | sponsor host key        | same — minted on the hub, honoured by (3.1.1)   |
| `MUSTERD_AGENT_KEY`   | refused                 | refused                                         |

Boot order in hub mode: tailnet (root) → drop root → `musterd serve` loopback → `node join`
(first boot) → wait for the first fold → `musterd host --cloud-provision --server
http://127.0.0.1:4849`. No `team create`, no `--as`, no roster-root dance: the roster comes from
the fold (ADR 058's file root is for file-authoritative teams, and a joiner is not one).

Delta's root/`setpriv` drop (ADR 390) is kept; phase 1's entrypoint has no root phase because it
needs no tailnet.

## 5. Increments (lanes under goal `cloud-agents`; each lands on its own)

1. **ADR 688** — the decision in §3.1 (this lane's first PR; draft PR first, ADR 223).
2. **Sync: sponsor-scoped credentials and pinned provisions replicate** — events, projectors,
   `withDrivers` store tests, the push-residence test of §3.1.4. Server + protocol-adjacent;
   needs the ADR before a line of it.
3. **Host loop: `--cloud-provision` against a joiner** — a joiner may claim only its pinned
   provisions; `hostKeyScope` from the replicated roster; the hub-asleep path logs `hub_unreachable`
   and keeps polling. Scope `packages/cli/src/host/**`.
4. **The machine: hub mode in `deploy/cloud-agent`** — entrypoint (tailnet, join, serve),
   `create.sh --hub <name>` (mints the invite and the host key on the hub, pins the provision),
   README. Delta's folder is deleted in this increment; its log stays.
5. **Dogfood reading** — one seat on the revive hub for a week, appended to
   `docs/perf/cloud-seat.md`: wake latency against the laptop baseline, what happened across
   hub sleeps, every human step. Closes the lane.

## 6. Tests the builder owes (from §5 of the 2026-10-17 design, re-read for a joiner)

- A host key minted by sponsor A, replicated, cannot claim or serve sponsor B's seat at the
  joiner; a team-wide key does not replicate at all.
- Revoking the host key on the hub ends leases at the joiner within one sync tick.
- A provision pinned to host X is claimable only at the node whose host label is X; unpinned
  provisions are never claimable at a joiner.
- A joiner push authored by a human is refused `bound_elsewhere` regardless of the host key.
- Spend caps hold a joiner-hosted seat exactly as a local one (gateway unchanged).

## 7. Out of scope

Subscription-login seats (2c), floating seats, moving leases to the hub, any change to the team
agent key's residence, and the hosted (Cloud) path — phase 1 is untouched by every increment above
except the shared entrypoint gaining a mode.

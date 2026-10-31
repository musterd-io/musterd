# 756 — Away relay socket liveness: a daemon heartbeat, and a silent socket is a dead one

- Status: accepted
- Date: 2026-10-28

## Context

ADR 659 gives each team one daemon WebSocket to its relay Durable Object, held with the
hibernation API, and refuses a second live socket for the same team with a 409. The daemon's client
(`packages/server/src/notify/relay.ts`) reconnects on `close` with the sync stream's backoff. Nothing
on that socket ever speaks while a team is idle: no ping in either direction.

Lane 7g's first real pairing (2026-10-28, hub `revive`, pairing `01M62M05KQ`) never staged. The
phone's sealed pair request reached the relay and was answered `202 accepted`, but the hub's
`pairing_nonces` row stayed `awaiting_identity` and no `channel.app_paired` audit row was ever
written. The hub's `daemon.log` showed `away_relay_up` every 10–15 minutes and a `down`+`up` pair
hours later. That is an idle socket dying somewhere on the path (a NAT or proxy idle timeout)
without either end seeing a close.

## Problem

A half-open socket fails silently at both ends:

1. **The relay** still lists it in `getWebSockets()`, so `POST /callback/…` and
   `POST /app/<slug>/callback` send the frame into it and answer the provider or the phone
   `202 accepted`. The frame goes nowhere, and the phone tells its human "waiting for approval"
   about a request that no daemon will ever see.
2. **The daemon** still reads the socket as OPEN, so it never redials. If it does redial (a
   restart), the relay answers the same-credential upgrade with 409 (ADR 659 §1) while it still
   holds the dead socket. The daemon is locked out until the runtime notices on its own.

## Decision

1. **A heartbeat on the socket.** Every `RELAY_PING_INTERVAL_MS` (30 s) the daemon sends the exact
   text `RELAY_PING` (`{"protocol":1,"type":"ping"}`). The relay object registers
   `setWebSocketAutoResponse(RELAY_PING → RELAY_PONG)`, so the runtime answers
   `{"protocol":1,"type":"pong"}` without waking the object (an idle team still costs near zero)
   and stamps the time. Both texts are protocol frames (`RelayPingFrameSchema`,
   `RelayPongFrameSchema`) at version 1. They are fixed strings, because the runtime matches them
   byte for byte.
2. **The daemon drops a silent socket.** Any frame from the relay counts as heard, the pong
   included. When nothing has been heard for more than `RELAY_SILENT_MS` (90 s, three missed
   pongs), the daemon logs `away_relay_silent`, terminates the socket and redials on the existing
   backoff.
3. **The relay treats a silent socket as dead.** When a socket's last auto-response is more than
   `RELAY_SILENT_MS` old, the object closes it (1011 `heartbeat silent`) wherever it would have
   used it:
   - On upgrade, the closed socket no longer counts as live, so the daemon's redial is accepted
     rather than refused 409. This narrows ADR 659 §1: "a second live socket" means a second
     socket while the first is still pinging.
   - On a provider or app callback, the request is answered `503 daemon socket silent` instead
     of `202`. The sender hears "not delivered" and retries, rather than being told the
     request landed.
   - On an app body fetch, the existing `503 daemon not connected` applies.
4. **A socket that has never pinged keeps the ADR 659 rule.** A daemon from before this ADR sends
   no pings, so its socket has no timestamp. That socket stays live until it closes, so the relay
   can deploy before every daemon has upgraded without cutting them off.

## Consequences

- An idle path now carries one small frame each way every 30 s per team. The relay object stays
  hibernated, because the runtime answers the ping. Worst-case loss is one lost frame per
  silence, inside a 90 s window, where before it was unbounded.
- A relay deployed before the daemon upgrades behaves as it did before (decision 4). A daemon
  upgraded before the relay redeploys gets `error: malformed frame` back for each ping. That reply
  still counts as heard, so the socket stays up. The cost is one `away_relay_frame_refused` log
  line per ping until the relay is redeployed.
- The relay is redeployed by its operator (`wrangler deploy`, ADR 659 §4). Merging this does not
  reach it.
- 2026-10-31 (lane `01M69CWVZN`), from the relay's Worker logs for 2026-10-30:
  - After a daemon restart the relay refused the new socket 409 five times over about 55 s
    (22:13:42–22:14:36Z). The daemon's stop dropped the TCP connection with `terminate()`, and the
    relay kept the old socket as live until it closed on its own. Every phone request in that gap
    failed. The daemon now sends a close frame (1001 `daemon stopping`) on stop and terminates only
    if the close has not finished within 1 s.
  - The daemon logged only the first error of a connection. A redial refused 409 now logs
    `away_relay_redial_failed` once per outage.
  - 328 of 358 app body fetches (92%) were answered 504: the relay waits 5 s for the daemon's
    `app_body`. The phone fetched 30–60 bodies at once, 378 of them for asks that no longer exist,
    and the daemon's answers queue behind each other on its one database connection. The daemon
    now logs `away_app_fetch_slow {ms, found}` past 1 s. The phone side is cider's.
    Follows-up: lane `01M69CWVZN`.

## Observability & Evaluation

**Traces** — daemon: `away_relay_silent {team, silent_ms}` beside the existing
`away_relay_up`/`down`. Relay: Worker observability already logs the callback route's status, so
a `503` with `daemon socket silent` is countable per team.

**Eval** — named tests: the daemon heartbeat pings while it hears pongs, fires `silent` exactly
once past the window, and stops cleanly. The relay refuses a callback 503 and closes the socket
when the last ping is stale, takes it at 202 within the window, and keeps a never-pinged socket on
the ADR 659 rule. `socketSilent`'s boundary is pinned. The protocol test parses both fixed texts
through the schemas.

**Experiment** — one read on the hub after both halves are live: `away_relay_down` without a
following `away_relay_up` should no longer appear, and a re-run of lane 7g's pairing should stage
on the first scan (`pairing_nonces` leaves `awaiting_identity`). If a callback still answers 202
with no daemon-side record, this ADR's liveness rule is not the cause, and the lane re-opens on
that evidence.

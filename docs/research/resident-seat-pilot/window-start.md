# Resident seat pilot — window start

Recorded per [the manifest](../resident-seat-pilot-manifest.md) §Run protocol step 1, before any
in-class lane was handed to the worker seat.

| Term | Value |
| --- | --- |
| window start | 2026-10-14 17:11:37 PDT — the worker seat's first `wake_leases` row (`01M4YECWK676FYY4NTW463MFSE`, lane `batched`, act `01M4YECT6YAFP1VC34K1EN2X80`, a `request_help` from ryder) |
| window end | 2026-10-21 17:11:37 PDT, acceptance tail to 2026-10-23 17:11:37 PDT |
| arm B seat | `mason` (member `01M4YDER7S436KGBXCKK2X84PB`), role worker, enrolled 17:02:35 by nick, host `macbook-air-2.lan`, key env `ANTHROPIC_API_KEY`; overrides `lane both · cooldown 1m · 20/h · seat-policy · 80 turns · budget $5 · work-timeout 30m · flow auto` |
| arm A seat | `resident` (member `01M4VZ7RHP1PD4A4780TDW7DS7`), enrolled 2026-10-13 |
| arm C seats | Claude Code seats enrolled with residency on 2026-10-14: `delta`, `dolly`, `sloane`, `lazara`, `alfie` |
| `daemon_build` | `84ad8771737261010318ac5dc4292212c13f242c` (#2593, the manifest's own merge) |
| guidance | managed block `musterd:content v51 sha256:9164cd4a6d272cb5`; `musterd init --check` clean on the Air |
| team topology | roster repo `~/musterd/revive` at `9d73fcd4cd046e9bc3e150271274ba9365547143` (2026-10-14 16:55:17 PDT, the commit that added `seats/mason.toml`); 35 seat files |
| model attestation | B's first wake presence attests `claude-opus-5-5` (source `binding`); A attests `claude-haiku-5-5` |

## First wake, as a reading (not scored)

A `message` act does not wake a resident seat: the batched lane is request_help/handoff plus urgent
directed acts (`store/residency.ts`, the lane doc comment), and the `message` sent at 17:03:42
raised no lease. The `request_help` at 17:11:33 leased at 17:11:37, the native engine put the seat on
the roster 4.2 s after invoke, the seat answered in-thread with `accept` at 17:11:44, and the wake
settled at 17:11:46: 4 turns, $0.0647 by the gateway, summed `wake_turns` $0.0647 (measure 5 holds
on wake 1). Directed act to first in-thread answer: 11 s. The seat's answer said it could not see
its own model version; the attestation is the presence row's, which is what the manifest reads.

For the manifest's measure 1 this means the dispatcher's act kind matters: a lane reaches B by
`handoff` (wakes it), and a question reaches it by `request_help` or `steer` (wakes it); a
`message` waits for the seat's next wake.

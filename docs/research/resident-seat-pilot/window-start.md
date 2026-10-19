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

## Daily passes

One substitution from the manifest's allocation rule, recorded before the first handoff: the
handoff act has no picker (`lane_handoff` takes a named seat), so arm C's recipient is chosen
round-robin over the Claude Code residency seats that were wakeable at the pass, in name order
(`delta`, `dolly`, `sloane` on 2026-10-14; `alfie` and `lazara` were attended). The dispatcher still
chooses nothing: the order of the list and the order of the lanes decide.

### Pass 1 — 2026-10-14 21:58 PDT

118 open lanes, 9 in class (stakes normal, no risk tag, ≤3 surface globs, none under
`packages/protocol/src`, `docs/decisions`, `SPEC.md`, `.github`, `deploy`, no open dependency, no
brainstorm/spec-first title), handed off oldest first, alternating B / C, one identical note:

| # | lane | arm | to |
| --- | --- | --- | --- |
| 1 | `01M3ZC3G35` pg pool saturation vs outage (503/500) | B | mason |
| 2 | `01M41PX0XB` duplicate envelope id answers 409 | C | delta |
| 3 | `01M4FF0P6H` stream inc 6: Twitch refusal timing | B | mason |
| 4 | `01M4FF0S55` stream inc 7: what viewers see | C | dolly |
| 5 | `01M4HGY13Z` wake host actuates due wakes concurrently | B | mason |
| 6 | `01M4S53AV4` cold-start numbers from codex/opencode/grok | C | sloane |
| 7 | `01M4S7N1HV` unpublished seat file: joiner says which step is missing | B | mason |
| 8 | `01M4VTQ66X` product-communications skill split per ADR 586 | C | delta |
| 9 | `01M4W7HY7Z` built-in role templates for security and courier | B | mason |

Lanes 3, 4 and 6 need a hosted box, a Twitch viewer, or other harnesses on the host; the rule does
not exclude them, and a `blocked` from either arm is a reading, not a defect of the pass. The
board's surface-overlap warnings at handoff (pgDriver with wallow's tail lane, broadcast.ts with
miley's capture lane, the stream wiki between lanes 3 and 4) are advisory and were not acted on.
Work-order leases followed within 15 s for mason (lane 1) and sloane (lane 6); delta and dolly are
actuated by their own hosts' polls.

### Pass 2 — 2026-10-15 10:59 PDT

107 open lanes, 8 in class, handed off oldest first, alternating B / C, starting at B, with pass
1's note (`pass 2 (2026-10-15)` in place of `pass 1`):

| # | lane | arm | to |
| --- | --- | --- | --- |
| 1 | `01M3AMY549` demo inc 4b: ChatGPT Business rehearsal | B | mason |
| 2 | `01M3W3EQ67` Cloud per-team rate limits and quotas | C | alfie |
| 3 | `01M3W6GWVN` Cloud audit churn retention without a local archive | B | mason |
| 4 | `01M3W815KR` Cloud seeds relay fetch gets the public-host rule | C | delta |
| 5 | `01M4RX7NE2` idle-wake: Claude Code deaf after `/mcp` reload | B | mason |
| 6 | `01M4SB4CJP` spend controls: approvals above a threshold | C | alfie |
| 7 | `01M4SB4D7R` spend controls: the unpriced floor | B | mason |
| 8 | `01M4VPY8JV` role-skills 9: user guide | C | delta |

**Pass 1 under-counted the class.** All eight lanes have dependencies, and every one of those
dependencies was `done` before pass 1 (the latest, `01M4VPXR1X`, on 2026-10-13 21:15). The
manifest's term is "no *open* dependency". Pass 1 dropped every lane with any dependency, so these
eight were in class on 2026-10-14 and were not offered. Pass 1's nine handoffs stand. The eight
reach the arms a day late, which shortens their time in the window. Of the 13 lanes that passed
every other term today, 5 still wait on an open dependency (`01M3Z4408C`, `01M3Z44EMJ`,
`01M3Z44TD7`, `01M3Z44YMT`, `01M4SB4BZB`).

**Arm C's pool changed between attempts.** A first send at about 10:45 timed out on all eight: the
hub at `100.100.246.14` did not answer health or ping, and no lane changed owner. On the retry,
dolly and sloane were attended, so the round-robin ran over the wakeable seats `alfie` and `delta`
in name order. The board's surface-overlap warnings are advisory and were not acted on:
`cloud/loops.ts` is now held by mason (lane 3), alfie (lane 2, `cloud/**`) and delta (lane 4);
`docs/superpowers/specs/**` is held by alfie (lane 6) and mason (lane 7); and `docs/wiki/**` by
lane 8 and the stream lanes.

**Spend at the pass**, read from this joiner's replica: mason $12.81 across 36
`residency.wake_cost` rows (gateway-priced) against the $100 ceiling, resident $0.013 against $15.
The replica's `wake_turns` for mason sum to $14.68 across 40 leases. That gap of four leases and
$1.87 is measure 5's question, and the finding reads it from the hub.

### Between pass 2 and pass 3 — 2026-10-15, recorded 15:10 PDT

**Arm B was down 10:59 to 12:12 PDT.** The Air rebooted at 10:24 and `launchctl setenv` does not
survive a reboot, so every lease the host actuated for mason in that window is paired with a
`residency.wake_deferred` row (`API key variable ANTHROPIC_API_KEY is unset on this host`): 15
deferrals, 10:59:45 to 12:12:05, on `01M3AMY549` and `01M3W6GWVN`. None ran the seat. The fix is
[ADR 605](../../decisions/605-resident-key-keychain.md) (#2639, `3fede650`, merged 12:01): the host
reads the key from the Keychain item `musterd:ANTHROPIC_API_KEY` when the variable is unset, and
the launchd env was cleared. B's first priced wake after the outage is 12:25:26
(`dispatch_handoff`, $3.97); 8 priced wakes followed by 13:33, $7.68 in all. The finding leaves
the outage out of measure 1 and reports it as a host outage (amendment 1, correction).

**Two B lanes released with intervention** (amendment 1): `01M3AMY549` at 11:09 (back to open,
still open at 15:10) and `01M4FF0P6H` at 11:09, then handed to `stanley` at 11:15 outside the pilot
(it needs nick's box session, capture protocol `01M4Z00K5X`); stanley submitted at 12:12 and
wanderer accepted at 12:20. Neither counts for either arm. Steer `01M50C1XQ3` to mason is the
intervention row.

**Probe (measure 6) ran at 12:26 on lease `01M50GF7JF` and FAILED.** Steer `01M50GFAVR` was sent
while mason was inside a tool call on `01M3W6GWVN`: delivered +0.5 s, the next model call completed
at +5.0 s without it, the seat read the steer by `team_inbox_check` on call 3 (+8.1 s), and the
in-thread answer landed at +15.3 s after calls 4 and 5. Pass was "answered before the next model
call completes"; that call was call 2. Defect lane `01M50GH51Z` is open: the doorbell injects a
pointer to the act, not the act, so the seat spends a model call and a tool round reading it.
Per the manifest the week continues. Arm A's probe 2 (2026-10-13) stands as the pass.

**B's handed set at 15:10:** 7 in-class lanes (pass 1: `01M3ZC3G35`, `01M4HGY13Z`, `01M4S7N1HV`,
`01M4W7HY7Z`; pass 2: `01M3W6GWVN`, `01M4RX7NE2`, `01M4SB4D7R`). Five are `done` (`01M3W6GWVN`
accepted by izzo today), `01M4SB4D7R` is awaiting acceptance, `01M4RX7NE2` is claimed. B needs at
least one more in-class lane to reach the readability floor of 8.

**Spend at 15:10**, read from this joiner's replica, not the hub: mason $20.56 across 45
`residency.wake_cost` rows against $100, resident $0.099 across 10 against $15. Measure 5 on the
replica: mason has 50 leases with `wake_turns` rows, 5 of them with no `wake_cost` row ($2.08,
four of them 2026-10-14 22:08 to 2026-10-15 00:12, one at 12:32 today), and 1 lease whose summed
turns differ from its cost row by more than $0.001. The finding reads this from the hub; if the
hub shows the same, that is a defect lane.

**Arm C's `delta` was never wakeable.** Its residency names Fly host `850e40a4499168`, stopped
since 2026-10-03 (last heartbeat 2026-10-02 22:31 PDT), so it took no lease in the window. dolly
found this at 12:21 and retired delta at 15:04 (`residency off`, lane `01M50G647N`). Passes 1 and 2
counted delta as wakeable because its residency was enrolled; that was wrong in fact, and the
round-robin's "wakeable" now means a host heartbeat inside the last day, not an enrolment. Of the
four lanes delta was handed:

| lane | pass | what happened |
| --- | --- | --- |
| `01M4VTQ66X` product-communications split | 1 | dolly claimed it 12:21, landed it, lazara accepted 12:41 |
| `01M4VPY8JV` role-skills 9 user guide | 2 | dolly claimed it 12:21, landed it, lazara accepted 13:51 |
| `01M41PX0XB` duplicate envelope id → 409 | 1 | stranded on delta; released to open by ryder at 15:36 |
| `01M3W815KR` seeds relay public-host rule | 2 | stranded on delta; released to open by ryder at 15:36 |

The two dolly landed count for arm C as work done by a Claude Code seat, with the reassignment
reported beside them: dolly was attended, so they are not unattended C work. The two released lanes
are **excluded: recipient never wakeable**, are open again, and are offered to the next pass like
any other open lane.

### Pass 3 — 2026-10-16 11:03 PDT

The first pass under amendment 1. 101 open lanes, 24 that passed the manifest's terms (stakes
normal, no risk tag, ≤3 surface globs, none under `packages/protocol/src`, `docs/decisions`,
`SPEC.md`, `.github`, `deploy`, no open dependency, no brainstorm/spec-first title). Of those, 7
also passed the amended term and were handed off by `created_at`, alternating B / C, starting at
B, with pass 1's note (`pass 3 (2026-10-16)` in place of `pass 1`).

**Arm C's pool.** A seat counted only with a host heartbeat inside the last day, and only if it
was unattended. At 10:59 PDT `host_liveness` had `macbook-air-2.lan`, `mac.lan`, and
`MacBook-Air-2.local`. `Nicks-Laptop.local` had no row.

| seat | host | at the pass |
| --- | --- | --- |
| alfie | `Nicks-Laptop.local` | no heartbeat. Not in the pool. |
| dolly | `Nicks-Laptop.local` | no heartbeat, and a claude-code presence online at 10:48. Attended. Not in the pool. |
| lazara | `mac.lan` | heartbeat at 10:59, no presence. In the pool. |
| sloane | `macbook-air-2.lan` | heartbeat at 10:59, no claude process (an opencode process, pid 96024, was in the workspace; the host's attended check is claude-code only). In the pool. |

Round-robin in name order over the pool that remained: `lazara`, then `sloane`.

| # | lane | arm | to |
| --- | --- | --- | --- |
| 1 | `01M3W815KR` Cloud seeds relay public-host rule | B | mason |
| 2 | `01M41PX0XB` duplicate envelope id answers 409 | C | lazara |
| 3 | `01M46GR8AC` deaf seats re-measure | B | mason |
| 4 | `01M4S9AVXF` overlap from what branches change | C | sloane |
| 5 | `01M50ZB4YM` console `/health` build stamp from `FLY_IMAGE_REF` | B | mason |
| 6 | `01M50ZJ9F9` cursor-agent wake backend | C | lazara |
| 7 | `01M5162W38` musterd pick 5: skill and pick act text | B | mason |

Mason's host woke lease `01M52Y3ZGW` on lane 1 at 11:03:27. Sloane's first wake on lane 4
(lease `01M52Y4GN2`) settled exit 1 in 5.0 s: the harness said the weekly limit resets at 8pm
America/Los_Angeles. The lane stays hers. The board's surface-overlap warnings at handoff were
advisory and were not acted on.

**Excluded on the amended term** (a human's live session, a third-party account, a phone, or
hosted or streaming hardware), so the class can be recounted without the term:

| lane | reason |
| --- | --- |
| `01M0FS6J5A` QLoRA coordination-seat experiment | nick's hands-on training run |
| `01M2H2M5S3` dogfood run 1 | human-run scenario |
| `01M2H2MP1F` dogfood run 2 | human-run scenario |
| `01M2H2NQJH` dogfood run 3 | human-run scenario |
| `01M2H2P1XX` dogfood run 5 | human-run scenario |
| `01M2H2PGJE` dogfood run 6 | human-run scenario |
| `01M2H2QK3X` dogfood run 10 | human-run scenario |
| `01M2H2R1QB` dogfood run 11 | human-run scenario |
| `01M2H2RKFM` dogfood run 12 | a stranger, and the stream |
| `01M2M6NV4C` dogfood run 13 | human-run scenario |
| `01M3AMY549` ChatGPT Business rehearsal | third-party account and phones (the same lane released on 2026-10-15) |
| `01M46WD973` repair GPTBot Codex MCP | gptbot's workspace is not on this machine; the repair is that seat's local registration |
| `01M4EDCSJD` accountability dogfood | humans have to receive the handoffs |
| `01M4RKQX5V` tour step for nick | nick's live session |
| `01M50FNNRS` stream key swap on a live machine | nick at the box, and the streaming machine |

Two more passed the manifest's terms and were not handed, for reasons that are not the amended
term: `01M3TB1GPM` (ADR 436 trigger read) is dated 2026-10-21, and running it today would take
the reading early; `01M50ZJ9WD` (harness E2E audit) says it starts after its lanes 1–4 land, and
at the pass muse 3 (`01M50ZJ8KG`) was still active and the cursor-agent backend was still open
(it is row 6 above).

**B's handed set after this pass:** the 7 in-class lanes recorded at 15:10 on 2026-10-15, plus
rows 1, 3, 5 and 7. Six of the earlier seven are `done`; `01M4RX7NE2` is still claimed. That is
11 in-class lanes handed to B, against the floor of 8.

**Spend at the pass**, read from this joiner's replica before the new wakes were priced: mason
$21.05 across 46 `residency.wake_cost` rows against the $100 ceiling, resident $0.11 across 11
against $15. Neither ceiling stops dispatch.

**ADR 627** merged as `7bf7f569` at 2026-10-15 21:21:38 PDT (#2719). This machine's host (pid
90969, started 2026-10-16 10:46:14 PDT) is running runtime build `90d0ad5`, which contains that
commit.

**Probe re-run (measure 6) passed.** Steer `01M52Y54DE` was sent at 11:03:58.766 while mason's
lease `01M52Y3ZGW` had turn 8 (`toolUse`, 11:03:56.124) as its latest `wake_turns` row.
`residency.steered` records delivery at 11:03:58.844, and the host log says the act was
delivered into the running loop with the host read. Turn 9 completed at 11:04:00.253 with no
steer in the transcript: that request was already in flight, which ADR 627 names as the loop's
own wait. Turn 10 completed at 11:04:02.943. Its transcript has `host_reads`: the host's
`team_inbox_check` of `01M52Y54DE`, then the model's own tool `team_send`. The in-thread answer
is message `01M52Y58DZ` ("seen") at 11:04:02.879. No model-made `team_inbox_check` of the steer
id precedes that answer. The falsifier in ADR 627 does not fire.

### Pass 4 — 2026-10-19 10:40 PDT

No pass ran on 2026-10-17 or 2026-10-18. This is the first pass since pass 3. Read from this
joiner's replica (`macbook-air-2.lan`), not the hub.

**No lane was handed.** 85 open unowned lanes, 13 that passed the manifest's terms, and none
that passed amendment 1 as well. Twelve fail the amended term for the reasons recorded at pass 3:
`01M0FS6J5A`; dogfood runs 1, 2, 3, 5, 6, 10, 11 and 12 (`01M2H2M5S3`, `01M2H2MP1F`,
`01M2H2NQJH`, `01M2H2P1XX`, `01M2H2PGJE`, `01M2H2QK3X`, `01M2H2R1QB`, `01M2H2RKFM`);
`01M3AMY549`; `01M4RKQX5V`; `01M50FNNRS`. The thirteenth, `01M3TB1GPM`, is still dated
2026-10-21. No new open lane has been in class since pass 3: everything opened since then has an
open dependency, a guarded surface, more than three globs, a risk tag, or a non-normal stake. Arm
C's pool was not read, because nothing was handed.

**Arm B is stalled on two lanes.**

| lane | state | what the rows say |
| --- | --- | --- |
| `01M5162W38` musterd pick 5 (pass 3) | claimed since 2026-10-16 11:03 | three `dispatch_handoff` wakes then two `dispatch_continuation` wakes, 12:24 to 12:29, each `residency.wake_failed` with `native loop ended (completed) without occupying the seat`, $0.03–0.08 apiece; `residency.wake_exhausted` (breaker, 3 attempts) at 12:25:38. No lane lease since. |
| `01M4RX7NE2` idle-wake: deaf after `/mcp` reload (pass 2) | claimed since 2026-10-15 10:59:45 | claimed inside the arm-B outage; no lane lease since. |

Mason's only leases after 2026-10-16 12:31 are the nightly ones at 22:30 on 2026-10-17 and
2026-10-18, which name no lane. Per Run protocol step 2 neither lane is touched by hand at this
pass. The finding reports both as handed and unfinished. A failed wake that ends without the
seat occupying it is a host or engine reading, not a silent wake under amendment 1.

**B's handed set** is still the 11 in-class lanes, against the floor of 8. Eight are `done`
(`01M3ZC3G35`, `01M4HGY13Z`, `01M4S7N1HV`, `01M4W7HY7Z`, `01M3W6GWVN`, `01M4SB4D7R`,
`01M3W815KR`, `01M46GR8AC`), `01M50ZB4YM` is `blocked`, and the two above are claimed. Whether
each `done` came from an `accept` on a `lane_review` ask is measure 2's denominator, and the
finding reads that from the hub.

**Spend at the pass**: mason $27.16 across 58 `residency.wake_cost` rows, every one priced,
against $100; resident $0.127 across 13 against $15. Neither ceiling stops dispatch. Two days of
the window are left (it ends 2026-10-21 17:11:37 PDT).

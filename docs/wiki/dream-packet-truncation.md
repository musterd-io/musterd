# Dream packet truncation means clipped bodies, not dropped items

A dream packet reporting `truncated: true` with `used_bytes` far under the 24 KB budget is telling you learned insight bodies were cut at 600 characters — read the full text via `team_insight_search` before promoting anything from a clipped body.

> ~~FIXED 2026-10-04 by #2066 ("a dream reads every learned insight whole"): insight bodies now
> arrive whole up to the server's 2,048-byte cap with a per-insight `truncated`, and a packet-wide
> `truncated: true` never means a learned body was cut. The claim below describes pre-#2066
> behaviour and is kept for the record.~~

## truncated:true at 4–9 KB is the body clip, not the lane budget (2026-10-03; falsify: a packet with truncated true where every learned body is complete and used_bytes is under 24 KB) <!-- claim: defect -->

Three sightings on two dates. wanderer 2026-10-03: `used_bytes` 8389, zero lanes, and the clip hid the last sentence of miley's brand-asset insight 01M403XKCR5AFXZJE59D5KEGZW — a promotion condition ("promote if another asset lane fails the same way") invisible in the packet. miley 2026-10-03: `used_bytes` 8784 with 12 done lanes carrying zero acts and `memory.truncated` false, so the flag came from the learned bodies, not the lanes. ghost 2026-10-04: `used_bytes` 4710 with 3 of 5 learned bodies cut mid-sentence. Mechanism: `packages/server/src/store/dream.ts` sets `truncated` when an insight body is cut at `act_body_chars` 600 (DREAM_BUDGET); oldest lane acts drop first only against the 24 KB budget, which none of these nights approached. A lane in the window with no acts tells the dream nothing — the signal is in `learned[]`, read whole.

## A lane's acts include other lanes' acceptance asks that name it as "Follows up" (2026-10-14; falsify: in `~/.musterd/musterd.db`, `select instr(body,'01M4YDJK1N') from messages where id='01M4YFG8BD3DMXTPHE3VRTDYB6'` returns 0, or `buildDreamPacket` selects lane acts by a lane-id column instead of `instr(body, ?)`) <!-- claim: defect -->

`buildDreamPacket` (`packages/server/src/store/dream.ts`, step 2) puts an act under a lane when the lane id appears anywhere in the act's body or meta. An acceptance ask's body ends with `Follows up: <lane id> [state] "<title>"` for each lane that builds on the one being judged. So every acceptance ask on lane A is listed again under lane B when B follows up A. The duplicates count against `B.lane_acts` and the byte budget, and they read as asks about B.

Seen on two nights. 2026-10-13 (dolly, insight from lane `01M4Q7PNWW`): five acceptance asks for Tracker import 2/4 listed under Tracker import 3/4, in a packet at 49,011 bytes with two acts omitted on each lane. 2026-10-14 (miley): the two `/broadcast` acceptance asks (`01M4YFG8BD`, `01M4YJQZX3`, lane `01M4YD9AMF`) listed under lane `01M4YDJK1N` (`/live` observer), because both carry `Follows up: 01M4YDJK1NQZBK8FNGCHY3NHV3`. Read an ask's title before counting it toward a lane's routing story.

Related: [dream insights with empty bodies](dream-empty-insight-bodies.md) (empty at source, truncated false — a different failure from this clip).

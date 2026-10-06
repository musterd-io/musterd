# Dream packet truncation means clipped bodies, not dropped items

A dream packet reporting `truncated: true` with `used_bytes` far under the 24 KB budget is telling you learned insight bodies were cut at 600 characters — read the full text via `team_insight_search` before promoting anything from a clipped body.

> ~~FIXED 2026-10-04 by #2066 ("a dream reads every learned insight whole"): insight bodies now
> arrive whole up to the server's 2,048-byte cap with a per-insight `truncated`, and a packet-wide
> `truncated: true` never means a learned body was cut. The claim below describes pre-#2066
> behaviour and is kept for the record.~~

## truncated:true at 4–9 KB is the body clip, not the lane budget (2026-10-03; falsify: a packet with truncated true where every learned body is complete and used_bytes is under 24 KB) <!-- claim: defect -->

Three sightings on two dates. wanderer 2026-10-03: `used_bytes` 8389, zero lanes, and the clip hid the last sentence of miley's brand-asset insight 01M403XKCR5AFXZJE59D5KEGZW — a promotion condition ("promote if another asset lane fails the same way") invisible in the packet. miley 2026-10-03: `used_bytes` 8784 with 12 done lanes carrying zero acts and `memory.truncated` false, so the flag came from the learned bodies, not the lanes. ghost 2026-10-04: `used_bytes` 4710 with 3 of 5 learned bodies cut mid-sentence. Mechanism: `packages/server/src/store/dream.ts` sets `truncated` when an insight body is cut at `act_body_chars` 600 (DREAM_BUDGET); oldest lane acts drop first only against the 24 KB budget, which none of these nights approached. A lane in the window with no acts tells the dream nothing — the signal is in `learned[]`, read whole.

Related: [dream insights with empty bodies](dream-empty-insight-bodies.md) (empty at source, truncated false — a different failure from this clip).

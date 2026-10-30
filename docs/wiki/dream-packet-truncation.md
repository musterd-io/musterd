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

## A decline that sends a lane back is missing from the owner's packet, so the send-back reads as having no reason (2026-10-28; falsify: in `~/.musterd/musterd.db`, `select instr(body,'01M62K20XC') + instr(coalesce(meta,''),'01M62K20XC') from messages where id='01M62KP21KPSXG3QWWHBFPABN7'` returns non-zero, or a dream packet for lane `01M62K20XC`'s owner lists that decline) <!-- claim: defect -->

The same selection rule cuts the other way. A decline answers the acceptance ask by `meta.in_reply_to` alone; its meta is `{in_reply_to, otel, model, model_source}`, and a reviewer's prose rarely repeats the lane id. So the packet keeps the acceptor's `[lane] … → active` transition and drops the decline that carries the reason. An accept shows up only when its body happens to name the lane.

Seen on two nights. 2026-10-26 (alfie, insight `01M5XXFGPJ`, since superseded): the SR008 lane `01M5WVWEGQ` was sent back by izzo 37 s after the ask, and alfie's packet had "no decline note", so the dream filed it as a send-back with no reason. 2026-10-28 (dolly): two lanes, same shape. `01M61SX0PC` was sent back by izzo's decline `01M620ASD1`, and `01M62K20XC` by big-body's decline `01M62KP21K`. Neither decline names its lane, and neither is in dolly's packet. All three reasons exist. They are in the decline act and in the `note` of the `lane.review_sent_back` audit row (`packages/server/src/protocol/route.ts`), e.g. `select detail from audit where action='lane.review_sent_back' and detail like '%<lane id>%'`. Before you write "no reason given" about a send-back, read that row. One more trap: `messages.from_member` holds member ids, not seat names, so a filter on a seat name matches nothing.

## After #2066, truncated:true at 27–45 KB is lane-act clips

A post-#2066 packet with `truncated: true`, every `learned[].truncated` false, and every lane `omitted: 0` is reporting 600-character lane-act clips against the 48 KB budget, not dropped items or cut insight bodies (2026-10-11, seen again 2026-10-13 and 2026-10-21; falsify: a packet in that byte range with any `learned[].truncated` true or a lane `omitted > 0`) <!-- claim: other -->

Three sightings. ghost night 2026-10-11 (insight 01M4Q9PQD1HA8QR09HSV149CM2): 4 lanes + 30 learned, `used_bytes` 45228. ghost night 2026-10-13 (insight 01M4WEH3XPN8D3VKEGE0YGS9XP): 1 lane + 20 learned, `used_bytes` 27535. wanderer night 2026-10-21: 1 lane (`01M5DHX159`, omitted 0) + 30 learned (every `truncated: false`; nights 2026-10-18:6, 10-19:10, 10-20:13, 10-21:1), `used_bytes` 40337. The 24 KB figures in the section above predate #2066.

Related: [dream insights with empty bodies](dream-empty-insight-bodies.md) (empty at source, truncated false — a different failure from this clip).

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

Seen again on 2026-10-29 (wallow), going the other way: the acceptance ask `01M64DVP1G` for the parent review lane `01M61VTA64` ("CLI review: finish first-run, recovery and accessibility journeys") shows up under all four lanes that review opened (`01M64D0VC4`, `01M64D0RKS`, `01M64D0N77`, `01M64D0JSY`) and under `01M64CN3VY`. Also big-body's accept on `01M64D4WE4` ("CLI structured output") shows up under `01M64CN3VY`, because the accept names it as the ADR 758 follow-up. Any act whose body names a lane id is listed under that lane, whichever direction the follow-up runs.

## A send-back decline is missing from the owner's packet; only the acceptor's "→ active" shows (2026-10-28; falsify: a dream packet for the lane owner that lists a decline act whose body does not contain the lane id) <!-- claim: defect -->

When an acceptor declines, the lane goes back to `active`. The decline act carries only `{in_reply_to, otel, model, model_source}` in meta, and its body does not name the lane id. `buildDreamPacket` selects acts by lane id in body or meta, so it leaves the decline out. All the owner's dream gets is a bare `[lane] "<title>" → active` from the acceptor, with no reason. The reason is kept in audit `lane.review_sent_back.note`. Read it there: `sqlite3 -readonly ~/.musterd/musterd.db "select detail from audit where action='lane.review_sent_back' and detail like '%<lane>%'"`.

Seen on two nights. 2026-10-28 (dolly, insight `01M632AXNW`): declines `01M620ASD1` (izzo, lane `01M61SX0PC`) and `01M62KP21K` (big-body, lane `01M62K20XC`) exist in `messages` but are absent from her packet. 2026-10-29 (wallow): lane `01M64DSBQV` (pair a phone from /live) shows ask `01M64KWMAP` and then big-body's `→ active` 13m46s later, with no decline act between them. The resubmit closed 31 s later. Tonight's sighting rests on the packet alone: the audit row was not read, because the dream's shell could not run `sqlite3`.

## After #2066, truncated:true at 27–45 KB is lane-act clips

A post-#2066 packet with `truncated: true`, every `learned[].truncated` false, and every lane `omitted: 0` is reporting 600-character lane-act clips against the 48 KB budget, not dropped items or cut insight bodies (2026-10-11, seen again 2026-10-13 and 2026-10-21; falsify: a packet in that byte range with any `learned[].truncated` true or a lane `omitted > 0`) <!-- claim: other -->

Three sightings. ghost night 2026-10-11 (insight 01M4Q9PQD1HA8QR09HSV149CM2): 4 lanes + 30 learned, `used_bytes` 45228. ghost night 2026-10-13 (insight 01M4WEH3XPN8D3VKEGE0YGS9XP): 1 lane + 20 learned, `used_bytes` 27535. wanderer night 2026-10-21: 1 lane (`01M5DHX159`, omitted 0) + 30 learned (every `truncated: false`; nights 2026-10-18:6, 10-19:10, 10-20:13, 10-21:1), `used_bytes` 40337. The 24 KB figures in the section above predate #2066.

Related: [dream insights with empty bodies](dream-empty-insight-bodies.md) (empty at source, truncated false — a different failure from this clip).

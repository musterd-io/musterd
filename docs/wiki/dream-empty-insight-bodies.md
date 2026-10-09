# Dream insights with empty bodies

An insight can be stored with an empty body while truncated is false, and stay that way overnight — a promotion that reads the body for a date or falsifier finds nothing.

## The body is empty and stays empty

An insight can arrive in a dream packet with body "" and truncated false, and still have an empty body the next night (2026-10-04 grokbot packet 2 of 8 learned, 01M43ZE9DD3PCEP62RBE2TFX3P and 01M43ZEFGPRTB2957JHETEY0KF; seen again 2026-10-05 `team_insight_search` of those headlines still returns body ""; falsify: `team_insight_search` for "live 404" returns 01M43ZE9DD3PCEP62RBE2TFX3P with a non-empty body) <!-- claim: defect -->

Night 2026-10-04 grokbot insight 01M458ZX0QZENFPQTFKB6W397X: two dreamy learned entries had whole headlines and empty bodies; each entry's truncated was false, so this is not the 600-char clip on [dream packet truncation](dream-packet-truncation.md) (FIXED by #2066). Night 2026-10-05 the same two ids still search with empty bodies. Dreamy later saved a full-body insight on the same topics (01M4683F2DSXHYR0K6GVEGTV8H); the empty rows remain. Search by id hits the wrapper insight, not a filled original.

Seen again on 2026-10-08, a third night: `team_insight_search "live 404"` still returns 01M43ZE9DD3PCEP62RBE2TFX3P with body `""` and `"office-delight"` still returns 01M43ZEFGPRTB2957JHETEY0KF with body `""`, while rows saved since and read the same way arrive filled (01M4683F2DSXHYR0K6GVEGTV8H, 01M47VCQEYHJ1BTVVRYT0R9JX5). The two empty rows are the pair saved 2026-10-04T17:30Z (2026-10-08 dreamy; falsify: either headline search returns a non-empty body) <!-- claim: defect -->

Related: [dream packet truncation](dream-packet-truncation.md).

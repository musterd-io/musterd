# Dream cannot verdict a lane_review ask

A dream Presence was woken for routed acceptance asks it could not verdict — until ADR 606 (2026-10-15): the acceptance router now skips a dreaming seat, so the ask never arrives. The fence itself is unchanged.

## The interrupt still raises the ask

A `lane_review` ask is obligation-class ([which acts wake a seat](which-acts-wake-a-seat.md); [ADR 225](../decisions/225-acceptance-is-an-obligation.md)) so it rides the immediate wake lane. A dream is a wake. The dreaming write fence then refuses every Act except `insight` ([ADR 494](../decisions/494-when-a-seat-dreams.md)): `accept` / `decline` / `wait` are refused, and a dream never moves a lane. The ask sits. [Acceptance routing](acceptance-routing.md) grades `cross_family` first, so on this team the ask often lands on grokbot.

~~A dream Presence is woken for a `lane_review` ask it cannot verdict (2026-10-08 grokbot 01M4FJFNQ9QAMMJ0NXE6ACYHX1, insight 01M4FJVGMSVR95HAHEJRJSASX9; seen again 2026-10-10 two reaped `cross_family` asks from big-body, 01M4MQ2JW60E11JRDFCRCFD573 and 01M4MQ2JTQ9WZ0HSG08J7DBJBS, insight 01M4MQE6XQ5PRQM85VV7Q6HJBF)~~ FIXED 2026-10-15 by ADR 606 (lane `01M50C7QR4`): `selectReviewCandidate` excludes a live dream presence (`exclusion: dreaming`), so a routed or reaped ask falls to the next rung — or escalates when every peer dreams — instead of parking on a fenced seat. The fence keeps refusing `accept`/`decline`/`wait` from a dream; that horn was deliberately not changed (falsify: a selection snapshot after 2026-10-15 names a dream-presence addressee, or no candidate row carries `exclusion: dreaming` on a dream night) <!-- claim: defect -->

Both 2026-10-10 asks were read and left without a verdict. A dream does not ring the doorbell; answering them would be a lane move. An ask addressed to the seat *before* it began dreaming is unaffected — it was already the seat's own.

Related: [which acts wake a seat](which-acts-wake-a-seat.md), [acceptance routing](acceptance-routing.md).

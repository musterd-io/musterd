# Dream cannot verdict a lane_review ask

A dream Presence is woken for routed acceptance asks and the fence refuses the accept, decline, or wait that would answer them.

## The interrupt still raises the ask

A `lane_review` ask is obligation-class ([which acts wake a seat](which-acts-wake-a-seat.md); [ADR 225](../decisions/225-acceptance-is-an-obligation.md)) so it rides the immediate wake lane. A dream is a wake. The dreaming write fence then refuses every Act except `insight` ([ADR 494](../decisions/494-when-a-seat-dreams.md)): `accept` / `decline` / `wait` are refused, and a dream never moves a lane. The ask sits. [Acceptance routing](acceptance-routing.md) grades `cross_family` first, so on this team the ask often lands on grokbot.

A dream Presence is woken for a `lane_review` ask it cannot verdict (2026-10-08 grokbot 01M4FJFNQ9QAMMJ0NXE6ACYHX1, insight 01M4FJVGMSVR95HAHEJRJSASX9; seen again 2026-10-10 two reaped `cross_family` asks from big-body, 01M4MQ2JW60E11JRDFCRCFD573 and 01M4MQ2JTQ9WZ0HSG08J7DBJBS, insight 01M4MQE6XQ5PRQM85VV7Q6HJBF; falsify: a dream Presence that sends `act: accept` on a `lane_review` ask has the send succeed, or a dream wake's interrupt-check does not raise a `lane_review` ask) <!-- claim: defect -->

Both 2026-10-10 asks were read and left without a verdict. A dream does not ring the doorbell; answering them would be a lane move.

Related: [which acts wake a seat](which-acts-wake-a-seat.md), [acceptance routing](acceptance-routing.md).

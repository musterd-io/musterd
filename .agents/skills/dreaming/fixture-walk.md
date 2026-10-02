# Fixture walk

One pass of the consolidation loop over `fixture-packet.json`. The claims here are fixture claims. Do not save them with `team_insight_save`, and do not add the promoted page under `docs/wiki/`.

Window: `since` 1790812800000 through `until` 1790899200000. Seat `wanderer`. Nothing in the packet is truncated, and no lane act was omitted.

## 1. Inventory

- Trap. A failed claim returned no error frame (lane act `01FIXTUREACT000000000000001`, dated 2026-10-01 in the body).
- Trap. The third tick never reached the log (lane act `01FIXTUREACT000000000000002`, dated 2026-10-01).
- Number. The counter ticked 3 times (same act as the second trap; one observation, not a second claim).

`learned` already holds "A failed claim returns no error frame", dated 2026-09-30. Nothing in `learned` is about the third tick.

## 2. Insight to save

The third-tick observation has no match since `since`. Save it. The claim-hang observation matches `learned`, so it is not a new insight.

`team_insight_save`:

- headline: `The third fixture tick never reached the log`
- body: `2026-10-01 fixture: the counter ticked 3 times and the third tick never reached the log. Falsify: a run of three ticks leaves three log lines.`

Body is under 2048 bytes. `dreamMayWrite('wanderer', { kind: 'act', act: 'insight' })` is ok.

## 3. Promotion

Seen twice: "a failed claim returns no error frame" — the 2026-09-30 insight in `learned`, and the 2026-10-01 lane act. Same claim, two dates. Promote. The third-tick insight was observed once, so it stays an insight.

The page that would be committed, at `docs/wiki/fixture-claim-hang.md` (not committed by this walk):

```
# Fixture claim hang

A failed claim comes back with no error frame.

## The frame

A failed claim returns no error frame (2026-09-30, seen again 2026-10-01; falsify: a claim the server rejects comes back as an error frame the client shows) <!-- claim: defect -->
```

`dreamMayWrite('wanderer', { kind: 'file', path: 'docs/wiki/fixture-claim-hang.md' })` is ok. The falsifier fails when a rejected claim does produce an error frame. A check that always printed this sentence would not.

The PR for that page would branch from `origin/main`, and `pnpm wiki:check` would have to pass, with `pnpm wiki:index` in the same commit. This walk does not open that PR.

## 4. Note

`team_memory_save` for seat `wanderer`:

`Promoted the fixture claim-hang page (seen 2026-09-30 and 2026-10-01). Left the third-tick observation as an insight. Stopped: the fixture packet is processed.`

`dreamMayWrite('wanderer', { kind: 'memory', seat: 'wanderer' })` is ok.

## 5. One refused write

A dream that "fixed" the hang by editing the server would be code. Verdict:

`dreamMayWrite('wanderer', { kind: 'file', path: 'packages/server/src/store/dream.ts' })` → `{ ok: false, reason: 'a dream writes only docs/wiki/**/*.md, never code (packages/server/src/store/dream.ts)' }`

Stop. Quote that reason. Do not write the file.

Also refused, not taken: `dreamMayWrite('wanderer', { kind: 'act', act: 'message' })` → `a dream sends only insight acts, not message`. The server enforces this row (403, `send.denied`). The file row above is this skill's to enforce.

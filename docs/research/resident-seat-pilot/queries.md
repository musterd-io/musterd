# Resident seat pilot — queries for finding 020

The derivation the finding ran is the committed script:

```sh
pnpm pilot:readout
# node --disable-warning=ExperimentalWarning scripts/research/resident-pilot-readout.ts
```

It was pointed at the joiner db (`~/.musterd/musterd.db`, team `revive`, id
`01M3ZEHWP99K74T7HDH8GH3NYW`) on 2026-10-22. The print is
[readout-2026-10-22.txt](./readout-2026-10-22.txt). The script's numerator folds a priced
unfinished lane into the dollars it divides by the accepted count. The finding also reports the
manifest's numerator: `wake_cost` on leases whose `lane_id` is an accepted lane only.

Window start is `Date.parse('2026-10-15T00:11:37Z')` (1792023097000). Window end is seven days
later. The tail is 48 hours after that.

Accepts are not on `meta.lane_review` of the accept. They are replies:

```sql
SELECT m.id, mb.name, m.ts
  FROM messages m
  JOIN members mb ON mb.id = m.from_member
 WHERE m.team_id = :team
   AND m.act = 'ask'
   AND json_extract(m.meta, '$.lane_review.lane') = :lane
   AND m.ts BETWEEN :start AND :tail;

SELECT m.act, mb.name, m.body
  FROM messages m
  JOIN members mb ON mb.id = m.from_member
 WHERE m.team_id = :team
   AND json_extract(m.meta, '$.in_reply_to') = :ask;
```

Leases with and without a cost row, per lane:

```sql
SELECT w.id, w.edge, w.lane_id,
       json_extract(c.detail, '$.cost_usd') AS cost,
       (SELECT SUM(t.cost_usd) FROM wake_turns t WHERE t.lease_id = w.id) AS turns
  FROM wake_leases w
  JOIN members m ON m.id = w.member_id
  LEFT JOIN audit c
    ON c.team_id = w.team_id
   AND c.action = 'residency.wake_cost'
   AND json_extract(c.detail, '$.lease_id') = w.id
 WHERE w.team_id = :team
   AND m.name = :seat
   AND w.lane_id = :lane;
```

The hub check was `sqlite3 ~/.musterd/musterd.db` on `100.100.246.14` as nick, team
`01KWHV06HQDCWF3N9058RCTJHV`. Same `residency.wake_cost` sum for `target` mason and resident
between the window bounds. `wake_leases` joined to the hub's mason and resident member ids
returned no rows. `wake_turns` for lease `01M5AMGEPX41GZTJHKEZGSFTJA` returned no rows there;
the cost row for that lease id is present on both.

`pnpm wake:rail --since 2026-10-14` buckets from local midnight (`2026-10-14T07:00:00Z`). The
finding's harness table keeps wakes whose `ts` is inside the pilot window.

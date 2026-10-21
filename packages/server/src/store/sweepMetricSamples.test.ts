import { makeEnvelope, type Act, type MetricInput } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { appendAudit, listAudit } from './audit.js';
import { getLane, openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { recordSample } from './laneSamples.js';
import {
  __clearLiveSamplesCache,
  liveMetricSamples,
  SAMPLE_SWEEP_DELAY_MS,
  metricSampleGate,
  sweepMetricSamples,
  zoneMidnight,
} from './sweepMetricSamples.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

const MIN = 60_000;
/** 2026-10-18 in the read-status zone (America/Los_Angeles, PDT): 07:00Z to 07:00Z next day. */
const DAY = '2026-10-18';
const START = Date.UTC(2026, 9, 18, 7);
const END = Date.UTC(2026, 9, 19, 7);
/** The morning after, well past the delay. */
const NOW = END + 60 * MIN;

const metric = (source: MetricInput['source']): MetricInput => ({
  name: 'm',
  unit: 'ms',
  baseline: 1,
  target: 2,
  direction: 'down',
  source,
});

/** ADR 673 §2, lane 2: the daemon's own daily samples for the derived metric sources. */
withDrivers('sweepMetricSamples', (o) => {
  beforeEach(() => {
    openStore = o;
    __clearLiveSamplesCache();
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
    const bo = (await addMember(db, team, { name: 'bo', kind: 'agent' })).row;
    const lane = (source: MetricInput['source']) =>
      openLane(db, team.id, team.slug, 'nick', {
        title: `reads ${source}`,
        reads_on: '2026-10-30',
        metric: metric(source),
      });
    return { db, team, nick, ada, bo, lane };
  }

  async function put(
    db: Driver,
    teamId: string,
    from: { id: string; name: string },
    id: string,
    act: Act,
    ts: number,
    meta: Record<string, unknown> | null = null,
  ) {
    await insertMessage(
      db,
      teamId,
      from.id,
      null,
      makeEnvelope({
        id,
        team: 'revive',
        from: from.name,
        to: { kind: 'team' },
        act,
        body: 'x',
        ts,
        meta,
      }),
    );
  }

  async function woke(db: Driver, teamId: string, seat: string, act: string, ts: number) {
    await appendAudit(db, teamId, {
      actor: null,
      action: 'residency.woke',
      target: seat,
      result: 'allow',
      detail: { act, lease_id: `L-${act}` },
    });
    await db.run(
      'UPDATE audit SET ts = ? WHERE id = (SELECT id FROM audit ORDER BY id DESC LIMIT 1)',
      [ts],
    );
  }

  it('finds midnight in the zone across a daylight-saving change', () => {
    const tz = 'America/Los_Angeles';
    expect(zoneMidnight(tz, DAY)).toBe(START);
    expect(zoneMidnight(tz, '2026-11-01')).toBe(Date.UTC(2026, 10, 1, 7));
    expect(zoneMidnight(tz, '2026-11-02')).toBe(Date.UTC(2026, 10, 2, 8));
  });

  it("writes yesterday's wake p50 and dispute rate to the lanes that name them, as the seat given", async () => {
    const { db, team, nick, ada, bo, lane } = await seed();
    const wakeLane = await lane('wake_latency_p50_ms');
    const disputeLane = await lane('dispute_rate');
    const manual = await lane('manual');
    const closed = await lane('dispute_rate');
    await updateLane(db, team.id, closed.id, team.slug, { state: 'abandoned' }, START);

    // Three woken acts that day, answered after 2, 4 and 10 minutes; one woken the day before.
    for (const [id, gap] of [
      ['h1', 2],
      ['h2', 4],
      ['h3', 10],
    ] as const) {
      const t = START + 60 * MIN * (id === 'h1' ? 1 : id === 'h2' ? 2 : 3);
      await put(db, team.id, nick, id, 'handoff', t);
      await woke(db, team.id, 'ada', id, t + MIN);
      await put(db, team.id, ada, `${id}-r`, 'status_update', t + gap * MIN);
    }
    await put(db, team.id, nick, 'h0', 'handoff', START - 120 * MIN);
    await woke(db, team.id, 'ada', 'h0', START - 119 * MIN);

    // Two acceptance verdicts that day, one of them a review decline (a dispute), plus a challenge.
    const review = (id: string, t: number) =>
      put(db, team.id, nick, id, 'ask', t, {
        lane_review: { lane: 'L' },
        species: 'approve',
        tier: 'standard',
      });
    await review('ask1', START + 10 * MIN);
    await put(db, team.id, bo, 'acc1', 'accept', START + 11 * MIN, { in_reply_to: 'ask1' });
    await review('ask2', START + 20 * MIN);
    await put(db, team.id, bo, 'dec2', 'decline', START + 21 * MIN, { in_reply_to: 'ask2' });
    await put(db, team.id, nick, 'ch1', 'challenge', START + 30 * MIN);
    // A verdict the next day is not this day's.
    await review('ask3', END + 5 * MIN);
    await put(db, team.id, bo, 'acc3', 'accept', END + 6 * MIN, { in_reply_to: 'ask3' });

    const written = await sweepMetricSamples(db, team.id, team.slug, NOW, 'digest');
    expect(written).toEqual(
      expect.arrayContaining([
        { lane: wakeLane.id, source: 'wake_latency_p50_ms', day: DAY, value: 4 * MIN, n: 3 },
        { lane: disputeLane.id, source: 'dispute_rate', day: DAY, value: 1, n: 2 },
      ]),
    );
    expect(written).toHaveLength(2);

    expect((await getLane(db, team.id, wakeLane.id, team.slug))?.samples).toEqual([
      { day: DAY, value: 4 * MIN, n: 3, by: 'digest', at: NOW },
    ]);
    expect((await getLane(db, team.id, manual.id, team.slug))?.samples).toEqual([]);
    expect((await getLane(db, team.id, closed.id, team.slug))?.samples).toEqual([]);
  });

  it('rerunning a day replaces its row and records what it replaced', async () => {
    const { db, team, nick, ada, lane } = await seed();
    const wakeLane = await lane('wake_latency_p50_ms');
    await put(db, team.id, nick, 'h1', 'handoff', START + 60 * MIN);
    await woke(db, team.id, 'ada', 'h1', START + 61 * MIN);
    await put(db, team.id, ada, 'r1', 'status_update', START + 66 * MIN);

    await sweepMetricSamples(db, team.id, team.slug, NOW, 'digest');
    await sweepMetricSamples(db, team.id, team.slug, NOW + MIN, 'digest');

    expect((await getLane(db, team.id, wakeLane.id, team.slug))?.samples).toEqual([
      { day: DAY, value: 6 * MIN, n: 1, by: 'digest', at: NOW + MIN },
    ]);
    const rows = (await listAudit(db, team.id)).filter((r) => r.action === 'lane.sample_recorded');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => JSON.parse(String(r.detail)).replaced)).toContainEqual({
      value: 6 * MIN,
      n: 1,
      by: 'digest',
    });
  });

  it('writes nothing for a day with nothing to measure, or before the delay past midnight', async () => {
    const { db, team, lane } = await seed();
    await lane('wake_latency_p50_ms');
    await lane('dispute_rate');
    expect(await sweepMetricSamples(db, team.id, team.slug, NOW, 'digest')).toEqual([]);
    expect(
      await sweepMetricSamples(db, team.id, team.slug, END + SAMPLE_SWEEP_DELAY_MS - 1, 'digest'),
    ).toEqual([]);
  });

  it('the gate is due once per team per day, after the delay, and only once done', () => {
    const gate = metricSampleGate();
    expect(gate.due('t1', END + SAMPLE_SWEEP_DELAY_MS - 1)).toBe(false);
    expect(gate.due('t1', END + SAMPLE_SWEEP_DELAY_MS)).toBe(true);
    // A failed pass never called done: still due on the next tick.
    expect(gate.due('t1', NOW)).toBe(true);
    gate.done('t1', NOW);
    expect(gate.due('t1', NOW + MIN)).toBe(false);
    expect(gate.due('t2', NOW + MIN)).toBe(true);
    expect(gate.due('t1', NOW + 24 * 60 * MIN)).toBe(true);
  });

  describe('live points (ADR 701)', () => {
    /** Mid-morning on DAY: the live window is DAY's midnight to now. */
    const MID = START + 4 * 60 * MIN;

    async function enroll(db: Driver, teamId: string, memberId: string, harness: string) {
      await db.run(
        `INSERT INTO residency (id, team_id, member_id, harness, host, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'h', 0, 0)`,
        [`r-${memberId}`, teamId, memberId, harness],
      );
    }

    it("measures today so far for a derived source, and reads today's stored sample for a manual one", async () => {
      const { db, team, nick, ada, lane } = await seed();
      const wakeLane = await lane('wake_latency_p50_ms');
      const manual = await lane('manual');
      await put(db, team.id, nick, 'h1', 'handoff', START + 60 * MIN);
      await woke(db, team.id, 'ada', 'h1', START + 61 * MIN);
      await put(db, team.id, ada, 'r1', 'status_update', START + 64 * MIN);
      // Not yet: an act woken after `now` is not in today-so-far.
      await put(db, team.id, nick, 'h2', 'handoff', MID + 10 * MIN);
      await woke(db, team.id, 'ada', 'h2', MID + 11 * MIN);
      await put(db, team.id, ada, 'r2', 'status_update', MID + 30 * MIN);
      const m = (await getLane(db, team.id, manual.id, team.slug))!;
      await recordSample(db, team.id, m, { day: DAY, value: 1.4, n: 5 }, 'ryder', MID - MIN);

      const live = await liveMetricSamples(db, team.id, team.slug, MID);
      expect(live).toEqual(
        expect.arrayContaining([
          { lane: wakeLane.id, day: DAY, value: 4 * MIN, n: 1, as_of: MID },
          { lane: manual.id, day: DAY, value: 1.4, n: 5, as_of: MID - MIN },
        ]),
      );
      expect(live).toHaveLength(2);
      // Nothing was stored: the sweep writes the whole day tomorrow.
      expect((await getLane(db, team.id, wakeLane.id, team.slug))?.samples).toEqual([]);
    });

    it('a harness-scoped wake metric counts only seats enrolled on that harness', async () => {
      const { db, team, nick, ada, bo } = await seed();
      await enroll(db, team.id, ada.id, 'claude-code');
      await enroll(db, team.id, bo.id, 'codex');
      const codexLane = await openLane(db, team.id, team.slug, 'nick', {
        title: 'codex wakes',
        reads_on: '2026-10-30',
        metric: { ...metric('wake_latency_p50_ms'), harness: 'codex' },
      });
      await put(db, team.id, nick, 'h1', 'handoff', START + 60 * MIN);
      await woke(db, team.id, 'ada', 'h1', START + 61 * MIN);
      await put(db, team.id, ada, 'r1', 'status_update', START + 62 * MIN);
      await put(db, team.id, nick, 'h2', 'handoff', START + 70 * MIN);
      await woke(db, team.id, 'bo', 'h2', START + 71 * MIN);
      await put(db, team.id, bo, 'r2', 'status_update', START + 80 * MIN);

      const live = await liveMetricSamples(db, team.id, team.slug, MID);
      expect(live).toEqual([{ lane: codexLane.id, day: DAY, value: 10 * MIN, n: 1, as_of: MID }]);
      // The sweep honours the same scope.
      const written = await sweepMetricSamples(db, team.id, team.slug, NOW, 'digest');
      expect(written).toEqual([
        { lane: codexLane.id, source: "wake_latency_p50_ms", day: DAY, value: 10 * MIN, n: 1 },
      ]);
    });

    it('reuses a team’s points within the poll interval, and has no point for a quiet day', async () => {
      const { db, team, lane } = await seed();
      await lane('dispute_rate');
      expect(await liveMetricSamples(db, team.id, team.slug, MID)).toEqual([]);
      const manual = await lane('manual');
      const m = (await getLane(db, team.id, manual.id, team.slug))!;
      await recordSample(db, team.id, m, { day: DAY, value: 2, n: 1 }, 'ryder', MID + 1);
      // Still cached: the new sample shows on the next window.
      expect(await liveMetricSamples(db, team.id, team.slug, MID + 1_000)).toEqual([]);
      expect(await liveMetricSamples(db, team.id, team.slug, MID + 31_000)).toHaveLength(1);
    });
  });
});

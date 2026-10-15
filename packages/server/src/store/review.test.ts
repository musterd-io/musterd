import { GENERALIST_CAPABILITIES, describeFamilyPosture, makeEnvelope } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { attach } from './presence.js';
import { enrollResidency } from './residency.js';
import { abandonedAcceptances, heldAcceptances, teamFamilyPosture } from './review.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('review', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  /**
   * The team model-family posture (ADR 172) — through-DB, like the rest of store/. The cases that
   * matter are the ones a two-state design would get wrong: one attester is `unknown`, not
   * `monoculture`; a live human never makes an all-claude agent fleet `diverse`; an agent attesting
   * `unknown` is present but proves nothing.
   */

  const TIMEOUT = 60_000;

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'dawn' });
    return { db, team };
  }

  async function agent(
    db: ReturnType<typeof seed>['db'],
    team: ReturnType<typeof seed>['team'],
    name: string,
    model?: string,
  ): void {
    const { row } = await addMember(db, team, { kind: 'agent', name, role: '' });
    if (model !== undefined) await attach(db, row.id, 'claude-code', `conn-${name}`, { model });
  }

  describe('teamFamilyPosture (ADR 172)', async () => {
    it('monoculture: ≥2 live agents attesting, all one family — enrolled-idle seats listed as the remedy', async () => {
      const { db, team } = await seed();
      await agent(db, team, 'ada', 'claude-opus-5');
      await agent(db, team, 'lin', 'claude-fable-5');
      await agent(db, team, 'kim', 'claude-opus-5');
      await agent(db, team, 'grokbot'); // enrolled, never attached — the wake pool
      await agent(db, team, 'gptbot');
      const p = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(p.state).toBe('monoculture');
      expect(p.attesting).toBe(3);
      expect(p.families).toEqual({ claude: 3 });
      // ADR 187: idle seats carry what they would bring. Never attested here, so `unknown` — the
      // durable-record cases are covered in their own describe below.
      expect(p.wake_pool.map((c) => c.seat).sort()).toEqual(['gptbot', 'grokbot']);
      expect(p.wake_pool.every((c) => c.family === 'unknown')).toBe(true);
      // ADR 189: never enrolled in these fixtures → marked, not filtered.
      expect(p.wake_pool.every((c) => c.wakeability === 'not_enrolled')).toBe(true);
    });

    it('diverse: one cross-family attester flips it', async () => {
      const { db, team } = await seed();
      await agent(db, team, 'ada', 'claude-opus-5');
      await agent(db, team, 'grokbot', 'grok-4.5');
      const p = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(p.state).toBe('diverse');
      expect(p.families).toEqual({ claude: 1, grok: 1 });
    });

    it('unknown, not monoculture, with a single attester — one data point cannot tell', async () => {
      const { db, team } = await seed();
      await agent(db, team, 'ada', 'claude-opus-5');
      await agent(db, team, 'grokbot');
      const p = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(p.state).toBe('unknown');
      expect(p.attesting).toBe(1);
    });

    it('a service seat is invisible to the posture: not unattested, never in the wake pool (ADR 232)', async () => {
      const { db, team } = await seed();
      await agent(db, team, 'ada', 'claude-opus-5');
      await agent(db, team, 'lin', 'claude-fable-5');
      const { row } = await addMember(db, team, { kind: 'service', name: 'autorefresh', role: '' });
      await attach(db, row.id, 'cli', 'conn-autorefresh'); // live, attests no model — correctly
      const p = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(p.state).toBe('monoculture');
      expect(p.unattested).toBe(0); // NOT an evidence hole — services attest none, by design
      expect(p.wake_pool.map((c) => c.seat)).not.toContain('autorefresh');
    });

    it('a live agent attesting nothing is unattested — present, proves nothing, not in the denominator', async () => {
      const { db, team } = await seed();
      await agent(db, team, 'ada', 'claude-opus-5');
      await agent(db, team, 'lin', 'claude-fable-5');
      const { row } = await addMember(db, team, { kind: 'agent', name: 'mist', role: '' });
      await attach(db, row.id, 'claude-code', 'conn-mist'); // live, no model
      const p = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(p.state).toBe('monoculture'); // the unknown seat neither proves nor breaks it
      expect(p.attesting).toBe(2);
      expect(p.unattested).toBe(1);
    });

    it('a live human never makes an all-claude agent fleet diverse — counted beside, not inside', async () => {
      const { db, team } = await seed();
      await agent(db, team, 'ada', 'claude-opus-5');
      await agent(db, team, 'lin', 'claude-fable-5');
      const { row } = await addMember(db, team, { kind: 'human', name: 'nick', role: '' });
      await attach(db, row.id, 'cli', 'conn-nick');
      const p = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(p.state).toBe('monoculture');
      expect(p.humans_live).toBe(1);
      expect(p.wake_pool).toEqual([]); // a human is never "wakeable" here
    });

    it('empty team → unknown with zeros, never a throw', async () => {
      const { db, team } = await seed();
      const p = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(p.state).toBe('unknown');
      expect(p.attesting).toBe(0);
      expect(p.families).toEqual({});
    });
  });

  /**
   * ADR 187. `presence` holds an attestation only while a seat is live and is reaped when it goes
   * offline, so reading it alone made every idle seat's family `unknown` — which silently emptied the
   * cross-family remedy while the durable `occupancy.model_attested` record knew the answer all along.
   */
  describe('the wake pool reads the durable attestation record (ADR 187)', async () => {
    /** An agent that attested once and then went away — no presence row survives it. */
    async function wentOffline(
      db: ReturnType<typeof seed>['db'],
      team: ReturnType<typeof seed>['team'],
      name: string,
      model: string,
      at: number = Date.now(),
    ): void {
      if (
        !(await db.get('SELECT 1 FROM members WHERE team_id = ? AND name = ?', [team.id, name]))
      ) {
        await addMember(db, team, { kind: 'agent', name, role: '' });
      }
      await db.run(
        `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
       VALUES (?, ?, ?, NULL, 'occupancy.model_attested', ?, 'allow', ?, ?)`,
        [
          `a-${name}-${String(at)}`,
          team.id,
          at,
          name,
          JSON.stringify({ old: null, new: model, source: 'claim' }),
          at,
        ],
      );
    }

    it('an idle seat carries the family it last attested, with the age of that claim', async () => {
      const { db, team } = await seed();
      await agent(db, team, 'ada', 'claude-opus-5');
      await agent(db, team, 'lin', 'claude-opus-5');
      const when = Date.now() - 86_400_000 * 21;
      await wentOffline(db, team, 'grokbot', 'grok-4.5', when);

      const p = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(p.state).toBe('monoculture'); // still — an idle seat never counts as attesting
      expect(p.wake_pool).toEqual([
        { seat: 'grokbot', family: 'grok', attested_at: when, wakeability: 'not_enrolled' },
      ]);
    });

    it('newest attestation wins — a seat that switched models is not remembered as its old one', async () => {
      const { db, team } = await seed();
      const old = Date.now() - 86_400_000 * 30;
      await wentOffline(db, team, 'drifter', 'grok-4.5', old);
      await wentOffline(db, team, 'drifter', 'claude-opus-5', old + 86_400_000);

      const p = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(p.wake_pool).toEqual([
        {
          seat: 'drifter',
          family: 'claude',
          attested_at: old + 86_400_000,
          wakeability: 'not_enrolled',
        },
      ]);
    });

    /**
     * ADR 219. The wake pool is everyone presence calls offline — but presence lapses for
     * reasons other than going away. A seat whose audit trail shows it acting seconds ago is not
     * idle; it is mid-something with a stale heartbeat, and waking it buys a duplicate, not a
     * remedy. Marked, never filtered: the seat stays in the pool so the diversity gap is still
     * named, exactly as ADR 189 does for unenrolled seats.
     */
    describe('quiescence marks a busy seat unspendable (ADR 219)', async () => {
      const acted = async (
        db: ReturnType<typeof seed>['db'],
        team: { id: string },
        actor: string,
        at: number,
      ) =>
        await db.run(
          `INSERT INTO audit (id, team_id, actor, action, target, result, ts, created_at)
           VALUES (?, ?, ?, 'x.did', NULL, 'allow', ?, ?)`,
          [`aud-${actor}-${String(at)}`, team.id, actor, at, at],
        );

      it('an enrolled seat acting seconds ago is enrolled_seat_busy, and stays in the pool', async () => {
        const { db, team } = await seed();
        await agent(db, team, 'grokbot');
        const row = await db.get('SELECT id FROM members WHERE name = ?', ['grokbot'])!;
        await enrollResidency(db, team.id, {
          member_id: row.id,
          harness: 'claude-code',
          host: 'h',
          grant_id: null,
          authorized_by: null,
        });
        await acted(db, team, 'grokbot', Date.now() - 5_000);
        const p = await teamFamilyPosture(db, team.id, TIMEOUT);
        expect(p.wake_pool.map((c) => c.seat)).toEqual(['grokbot']); // marked, NOT filtered
        expect(p.wake_pool[0]?.wakeability).toBe('enrolled_seat_busy');
      });

      it('the same seat quiet past the line is wakeable again — the mark is transient', async () => {
        const { db, team } = await seed();
        await agent(db, team, 'grokbot');
        const row = await db.get('SELECT id FROM members WHERE name = ?', ['grokbot'])!;
        await enrollResidency(db, team.id, {
          member_id: row.id,
          harness: 'claude-code',
          host: 'h',
          grant_id: null,
          authorized_by: null,
        });
        await acted(db, team, 'grokbot', Date.now() - 10 * 60_000);
        expect((await teamFamilyPosture(db, team.id, TIMEOUT)).wake_pool[0]?.wakeability).toBe(
          'wakeable',
        );
      });

      it('no audited action leaves the seat exactly as it read before the fact existed', async () => {
        const { db, team } = await seed();
        await agent(db, team, 'grokbot');
        const row = await db.get('SELECT id FROM members WHERE name = ?', ['grokbot'])!;
        await enrollResidency(db, team.id, {
          member_id: row.id,
          harness: 'claude-code',
          host: 'h',
          grant_id: null,
          authorized_by: null,
        });
        // unknown → omit the fact (ADR 169/189). Never "quiet by absence of evidence".
        expect((await teamFamilyPosture(db, team.id, TIMEOUT)).wake_pool[0]?.wakeability).toBe(
          'wakeable',
        );
      });

      it('a reachability defect outranks busy — the operator gets the actionable reason', async () => {
        const { db, team } = await seed();
        await agent(db, team, 'grokbot'); // never enrolled
        await acted(db, team, 'grokbot', Date.now() - 5_000);
        expect((await teamFamilyPosture(db, team.id, TIMEOUT)).wake_pool[0]?.wakeability).toBe(
          'not_enrolled',
        );
      });
    });

    it('a seat that never attested stays unknown — the record cannot invent one', async () => {
      const { db, team } = await seed();
      await agent(db, team, 'ghost'); // enrolled, never attached, never attested
      const p = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(p.wake_pool).toEqual([
        { seat: 'ghost', family: 'unknown', attested_at: null, wakeability: 'not_enrolled' },
      ]);
    });

    /**
     * The hazard this design must not introduce. A LIVE seat whose current occupancy attested nothing
     * must read `unknown`, NOT whatever it attested last week — otherwise a stale memory could certify
     * a live review as cross-family, and a review whose diversity claim is false is worse than no
     * review at all (ADR 056). The durable record answers "what would waking this seat bring", never
     * "what is this seat running now".
     */
    it('a LIVE seat is never described by its durable record — no stale cross-family claim', async () => {
      const { db, team } = await seed();
      await agent(db, team, 'ada', 'claude-opus-5');
      await agent(db, team, 'lin', 'claude-opus-5');
      // grokbot attested grok long ago, then came back on a session that attests nothing.
      await wentOffline(db, team, 'grokbot', 'grok-4.5', Date.now() - 86_400_000 * 21);
      const row = await db.get('SELECT id FROM members WHERE name = ?', ['grokbot'])!;
      await attach(db, row.id, 'claude-code', 'conn-grokbot'); // live, no model

      const p = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(p.unattested).toBe(1); // present, proves nothing
      expect(p.families).toEqual({ claude: 2 }); // NOT { claude: 2, grok: 1 }
      expect(p.state).toBe('monoculture'); // a stale memory must not read as diversity
      expect(p.wake_pool).toEqual([]); // and it is not idle, so it is not a remedy either
    });

    it('the posture line names the cross-family remedy first, with its age', async () => {
      const { db, team } = await seed();
      await agent(db, team, 'ada', 'claude-opus-5');
      await agent(db, team, 'lin', 'claude-opus-5');
      await wentOffline(db, team, 'sleepy', 'claude-opus-5', Date.now() - 3_600_000);
      await wentOffline(db, team, 'grokbot', 'grok-4.5', Date.now() - 86_400_000 * 3);

      const line = describeFamilyPosture(await teamFamilyPosture(db, team.id, TIMEOUT));
      expect(line).toContain('idle: grokbot (grok, 3d ago, not_enrolled)');
    });

    it('an enrolled idle seat is marked wakeable — mark-not-filter, never filter (ADR 189)', async () => {
      const { db, team } = await seed();
      await agent(db, team, 'ada', 'claude-opus-5');
      await agent(db, team, 'lin', 'claude-opus-5');
      const when = Date.now() - 86_400_000 * 3;
      await wentOffline(db, team, 'grokbot', 'grok-4.5', when);
      await wentOffline(db, team, 'compo', 'composer-2', when);
      const grok = await db.get('SELECT id FROM members WHERE name = ?', ['grokbot'])!;
      await enrollResidency(db, team.id, {
        member_id: grok.id,
        harness: 'claude-code',
        host: 'mac.lan',
        grant_id: 'g1',
        authorized_by: 'nick',
      });

      const p = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(p.wake_pool).toEqual(
        expect.arrayContaining([
          { seat: 'grokbot', family: 'grok', attested_at: when, wakeability: 'wakeable' },
          { seat: 'compo', family: 'composer', attested_at: when, wakeability: 'not_enrolled' },
        ]),
      );
      // Both stay in the pool — mark, don't filter.
      expect(p.wake_pool.map((c) => c.seat).sort()).toEqual(['compo', 'grokbot']);
      const line = describeFamilyPosture(p);
      // Wakeable cross-family wins the first slot over not_enrolled cross-family.
      expect(line).toMatch(/idle: grokbot \(grok, 3d ago\)/);
      expect(line).toContain('compo (composer, 3d ago, not_enrolled)');
    });
  });

  describe('pickReviewCounterpart — risky-lane human requirement (ADR 172)', () => {
    it('never routes a risky lane to an agent, even one whose stale row still carries is_admin', async () => {
      // Admins can only be humans (ADR 172). Reconcile clamps new projections, but a row written
      // before the clamp can still carry is_admin in its capabilities JSON — and the one review that
      // exists to demand a human's judgment must not route to it.
      const { openLane } = await import('./lanes.js');
      const { setMemberGovernance } = await import('./members.js');
      const { db, team } = await seed();
      await agent(db, team, 'ada', 'claude-opus-5'); // the worker
      const { row: botty } = await addMember(db, team, { kind: 'agent', name: 'botty', role: '' });
      await attach(db, botty.id, 'claude-code', 'conn-botty', { model: 'gpt-5.2-codex' });
      await setMemberGovernance(
        db,
        botty.id,
        null,
        JSON.stringify({ ...GENERALIST_CAPABILITIES, is_admin: true }),
      ); // the stale shape — a full blob, or it parses to the generalist and proves nothing
      const lane = await openLane(db, team.id, 'dawn', 'ada', {
        title: 'prod deploy',
        risk: ['production'],
        claim: true,
      });
      const { pickReviewCounterpart, pickHumanReviewer } = await import('./review.js');
      // ADR 188: botty IS routable — as the stage-one PEER (an intended agent review). What the
      // stale admin bit must never do is satisfy the HUMAN stage: pickHumanReviewer is kind-only.
      expect(await pickReviewCounterpart(db, team.id, lane, 'ada', TIMEOUT)).toMatchObject({
        reviewer: 'botty',
        grade: 'cross_family',
      });
      expect(await pickHumanReviewer(db, team.id, 'ada', TIMEOUT)).toBeNull();
    });
  });

  describe('pickReviewCounterpart — graded ladder (ADR 188)', async () => {
    async function pick(
      setup: (h: Awaited<ReturnType<typeof seed>>) => void | Promise<void>,
      risk: string[] = [],
    ) {
      const { openLane } = await import('./lanes.js');
      const { pickReviewCounterpart } = await import('./review.js');
      const h = await seed();
      await agent(h.db, h.team, 'worker', 'claude-opus-5');
      await setup(h);
      const lane = await openLane(h.db, h.team.id, 'dawn', 'worker', {
        title: 'a change',
        risk,
        claim: true,
      });
      return await pickReviewCounterpart(h.db, h.team.id, lane, 'worker', TIMEOUT);
    }

    it('cross_model is now routable: opus-5 worker, opus-4.8 reviewer', async () => {
      const p = await pick(
        async ({ db, team }) => await agent(db, team, 'dolly', 'claude-opus-4-8'),
      );
      expect(p).toMatchObject({ reviewer: 'dolly', grade: 'cross_model' });
    });

    it('cross_family beats cross_model when both are live', async () => {
      const p = await pick(async ({ db, team }) => {
        await agent(db, team, 'dolly', 'claude-opus-4-8');
        await agent(db, team, 'gptbot', 'gpt-5.6-sol');
      });
      expect(p).toMatchObject({ reviewer: 'gptbot', grade: 'cross_family' });
    });

    it('same_model is never routed — two opus-5 seats still find no candidate', async () => {
      expect(
        await pick(async ({ db, team }) => await agent(db, team, 'twin', 'claude-opus-5')),
      ).toBeNull();
    });

    it('an unattested live seat stays ineligible (null grade is not a grade)', async () => {
      expect(await pick(async ({ db, team }) => await agent(db, team, 'mist'))).toBeNull();
    });

    it('a live human is never picked on a non-risky lane — the cross-family agent is (ADR 253)', async () => {
      const p = await pick(async ({ db, team }) => {
        await agent(db, team, 'gptbot', 'gpt-5.6-sol');
        const { row } = await addMember(db, team, { kind: 'human', name: 'nick', role: '' });
        await attach(db, row.id, 'cli', 'conn-nick');
      });
      expect(p).toMatchObject({ reviewer: 'gptbot', grade: 'cross_family' });
    });

    it('a live human alone is not a candidate on a non-risky lane (ADR 253)', async () => {
      expect(
        await pick(async ({ db, team }) => {
          const { row } = await addMember(db, team, { kind: 'human', name: 'nick', role: '' });
          await attach(db, row.id, 'cli', 'conn-nick');
        }),
      ).toBeNull();
    });

    it('a dreaming seat is excluded `dreaming` and the ladder falls through (ADR 606)', async () => {
      const { openLane } = await import('./lanes.js');
      const { selectReviewCounterpart } = await import('./review.js');
      const { db, team } = await seed();
      await agent(db, team, 'worker', 'claude-opus-5');
      // Would win at cross_family, but its live presence is a dream — fenced, so an ask routed
      // to it could never be verdicted (docs/wiki/dream-cannot-verdict-acceptance.md).
      const { row: grokbot } = await addMember(db, team, {
        kind: 'agent',
        name: 'grokbot',
        role: '',
      });
      await attach(db, grokbot.id, 'claude-code', 'conn-grokbot', {
        model: 'gpt-5.6-sol',
        provenance: 'dream',
      });
      await agent(db, team, 'dolly', 'claude-opus-4-8');
      const lane = await openLane(db, team.id, 'dawn', 'worker', {
        title: 'a change',
        claim: true,
      });
      const p = await selectReviewCounterpart(db, team.id, lane, 'worker', TIMEOUT);
      expect(p.pick).toMatchObject({ reviewer: 'dolly', grade: 'cross_model' });
      expect(p.snapshot.candidates).toEqual(
        expect.arrayContaining([
          { member: 'grokbot', family: 'gpt', eligible: false, exclusion: 'dreaming' },
        ]),
      );
    });

    it('a dream-only pool routes no verdict — the ask escalates, it does not park (ADR 606)', async () => {
      expect(
        await pick(async ({ db, team }) => {
          const { row } = await addMember(db, team, { kind: 'agent', name: 'grokbot', role: '' });
          await attach(db, row.id, 'claude-code', 'conn-grokbot', {
            model: 'gpt-5.6-sol',
            provenance: 'dream',
          });
        }),
      ).toBeNull();
    });
  });

  describe('selectReviewCounterpart — decision-time audit snapshot (ADR 303)', () => {
    it('records the selected grade and a bounded reason for every rejected seat', async () => {
      const { openLane } = await import('./lanes.js');
      const { selectReviewCounterpart } = await import('./review.js');
      const { db, team } = await seed();
      await agent(db, team, 'worker', 'claude-opus-5');
      await agent(db, team, 'cross-model', 'claude-opus-4-8');
      await agent(db, team, 'winner', 'gpt-5.6-sol');
      await agent(db, team, 'twin', 'claude-opus-5');
      const { row: unknown } = await addMember(db, team, {
        kind: 'agent',
        name: 'unknown',
        role: '',
      });
      await attach(db, unknown.id, 'cli', 'conn-unknown'); // live but deliberately without a model attestation
      await agent(db, team, 'busy', 'grok-4.5');
      const { row: service } = await addMember(db, team, {
        kind: 'service',
        name: 'autorefresh',
        role: '',
      });
      await attach(db, service.id, 'cli', 'conn-autorefresh', { model: 'gpt-5.6-sol' });
      const { row: observer } = await addMember(db, team, {
        kind: 'human',
        name: 'watcher',
        role: '',
        observer: true,
      });
      await attach(db, observer.id, 'cli', 'conn-watcher');
      const { row: offline } = await addMember(db, team, {
        kind: 'agent',
        name: 'offline',
        role: '',
      });
      // `offline` intentionally has no Presence.
      expect(offline.name).toBe('offline');
      await db.run(
        `INSERT INTO audit (id, team_id, actor, action, target, result, ts, created_at)
         VALUES (?, ?, ?, 'x.did', NULL, 'allow', ?, ?)`,
        ['aud-busy', team.id, 'busy', Date.now() - 5_000, Date.now() - 5_000],
      );
      const lane = await openLane(db, team.id, 'dawn', 'worker', {
        title: 'a change',
        claim: true,
      });

      expect(await selectReviewCounterpart(db, team.id, lane, 'worker', TIMEOUT)).toMatchObject({
        pick: expect.objectContaining({ reviewer: 'winner', grade: 'cross_family' }),
        snapshot: {
          selected: { reviewer: 'winner', grade: 'cross_family' },
          candidates: expect.arrayContaining([
            { member: 'worker', family: 'claude', eligible: false, exclusion: 'self' },
            {
              member: 'autorefresh',
              family: 'gpt',
              eligible: false,
              exclusion: 'service_or_observer',
            },
            {
              member: 'watcher',
              family: 'human',
              eligible: false,
              exclusion: 'service_or_observer',
            },
            {
              member: 'offline',
              family: 'unknown',
              eligible: false,
              exclusion: 'no_live_presence',
            },
            { member: 'busy', family: 'grok', eligible: false, exclusion: 'busy' },
            { member: 'unknown', family: 'unknown', eligible: false, exclusion: 'unknown_grade' },
            { member: 'twin', family: 'claude', eligible: false, exclusion: 'same_model' },
            { member: 'cross-model', family: 'claude', eligible: false, exclusion: 'lower_grade' },
            { member: 'winner', family: 'gpt', eligible: true, grade: 'cross_family' },
          ]),
        },
      });
    });

    // An ungradeable WORKER is not an absent candidate set. Before this, `reviewGrade` returned null
    // for every candidate when the worker's live occupancy attested nothing, and the picker filed each
    // of those nulls as the CANDIDATE's `unknown_grade` — so one unattested asker knocked out every
    // eligible reviewer, and the row read as "the team had nobody" (10 of 129 no_candidate rows,
    // measured 2026-09-01: worker unattested in all 10, every excluded candidate a known family).
    //
    // ADR 351 (2026-09-02): an unattested worker now ROUTES, at the bottom rung `ungraded`. The
    // pairing proves nothing about diversity and says so — the grade is not one of ADR 188's three,
    // the route is its own value so the ADR 260 eval keeps it out of `liveRouted`, and the close edge
    // abstains (`review_grade_unknown`). An ungraded review beats no review; a false grade beats neither.
    it('an unattested worker routes to a live attested reviewer at the `ungraded` rung (ADR 351)', async () => {
      const { openLane } = await import('./lanes.js');
      const { selectReviewCounterpart } = await import('./review.js');
      const { db, team } = await seed();
      const { row: worker } = await addMember(db, team, {
        kind: 'agent',
        name: 'worker',
        role: '',
      });
      await attach(db, worker.id, 'cli', 'conn-worker'); // live, attests nothing (the bare-CLI-claim shape)
      await agent(db, team, 'gptbot', 'gpt-5.6-sol'); // live, attested — would be cross_family if we knew
      await agent(db, team, 'dolly', 'claude-opus-4-8'); // live, attested — could be cross_model or same
      const { row: unknown } = await addMember(db, team, {
        kind: 'agent',
        name: 'unknown',
        role: '',
      });
      await attach(db, unknown.id, 'cli', 'conn-unknown'); // a candidate that is itself unattested

      const lane = await openLane(db, team.id, 'dawn', 'worker', {
        title: 'a change',
        claim: true,
      });
      const selection = await selectReviewCounterpart(db, team.id, lane, 'worker', TIMEOUT);
      // Roster order among equals: gptbot was added first. No rung above `ungraded` is claimable
      // because nothing can be graded against an unknown worker — gptbot's gpt family is NOT a
      // cross_family claim here, and the pick must not say it is.
      expect(selection.pick).toMatchObject({
        reviewer: 'gptbot',
        route: 'ungraded',
        grade: 'ungraded',
        reviewer_family: 'gpt',
      });
      expect(selection.snapshot).toMatchObject({
        selected: { reviewer: 'gptbot', grade: 'ungraded' },
        worker_family: 'unknown',
        candidates: expect.arrayContaining([
          { member: 'worker', family: 'unknown', eligible: false, exclusion: 'self' },
          { member: 'gptbot', family: 'gpt', eligible: true, grade: 'ungraded' },
          { member: 'dolly', family: 'claude', eligible: false, exclusion: 'tie_break' },
          // A candidate that attests nothing is still its own `unknown_grade` — never routed, at
          // any rung: two unknowns prove even less than one.
          { member: 'unknown', family: 'unknown', eligible: false, exclusion: 'unknown_grade' },
        ]),
      });
      // The attested snapshot names the worker's family too, so a reader need not join the close row.
      const attested = await selectReviewCounterpart(db, team.id, lane, 'gptbot', TIMEOUT);
      expect(attested.snapshot.worker_family).toBe('gpt');
    });

    it('`ungraded` is a bottom rung, never a substitute: an attested worker still grades every candidate (ADR 351)', async () => {
      const { openLane } = await import('./lanes.js');
      const { selectReviewCounterpart } = await import('./review.js');
      const { db, team } = await seed();
      await agent(db, team, 'worker', 'claude-opus-5');
      await agent(db, team, 'twin', 'claude-opus-5'); // same_model — must stay excluded, not fall to ungraded
      const { row: unknown } = await addMember(db, team, {
        kind: 'agent',
        name: 'unknown',
        role: '',
      });
      await attach(db, unknown.id, 'cli', 'conn-unknown');
      const lane = await openLane(db, team.id, 'dawn', 'worker', {
        title: 'a change',
        claim: true,
      });
      const selection = await selectReviewCounterpart(db, team.id, lane, 'worker', TIMEOUT);
      expect(selection.pick).toBeNull();
      expect(selection.snapshot.candidates).toEqual(
        expect.arrayContaining([
          { member: 'twin', family: 'claude', eligible: false, exclusion: 'same_model' },
          { member: 'unknown', family: 'unknown', eligible: false, exclusion: 'unknown_grade' },
        ]),
      );
    });
  });

  describe('pickReviewCounterpart — busy is a preference (ADR 404)', async () => {
    const acted = async (
      db: ReturnType<typeof seed>['db'],
      team: { id: string },
      actor: string,
      agoMs: number,
    ) =>
      await db.run(
        `INSERT INTO audit (id, team_id, actor, action, target, result, ts, created_at)
         VALUES (?, ?, ?, 'x.did', NULL, 'allow', ?, ?)`,
        [`aud-${actor}-${String(agoMs)}`, team.id, actor, Date.now() - agoMs, Date.now() - agoMs],
      );

    async function pick(setup: (h: Awaited<ReturnType<typeof seed>>) => void | Promise<void>) {
      const { openLane } = await import('./lanes.js');
      const { pickReviewCounterpart } = await import('./review.js');
      const h = await seed();
      await agent(h.db, h.team, 'worker', 'claude-opus-5');
      await setup(h);
      const lane = await openLane(h.db, h.team.id, 'dawn', 'worker', {
        title: 'a change',
        claim: true,
      });
      return await pickReviewCounterpart(h.db, h.team.id, lane, 'worker', TIMEOUT);
    }

    it('a live busy cross-family seat loses to a quiet cross-model seat', async () => {
      const p = await pick(async ({ db, team }) => {
        await agent(db, team, 'gptbot', 'gpt-5.6-sol');
        await agent(db, team, 'dolly', 'claude-opus-4-8');
        await acted(db, team, 'gptbot', 5_000); // busy
        await acted(db, team, 'dolly', 180_000); // quiet (≥ 120s)
      });
      expect(p).toMatchObject({ reviewer: 'dolly', grade: 'cross_model' });
    });

    it('a team of only-busy live agents still asks the busy cross-family seat (ADR 404)', async () => {
      const p = await pick(async ({ db, team }) => {
        await agent(db, team, 'gptbot', 'gpt-5.6-sol');
        await acted(db, team, 'gptbot', 5_000);
      });
      expect(p).toMatchObject({ reviewer: 'gptbot', grade: 'cross_family' });
    });

    it('an only-busy winner is eligible, not left marked busy', async () => {
      const { openLane } = await import('./lanes.js');
      const { selectReviewCounterpart } = await import('./review.js');
      const h = await seed();
      await agent(h.db, h.team, 'worker', 'claude-opus-5');
      await agent(h.db, h.team, 'gptbot', 'gpt-5.6-sol');
      await acted(h.db, h.team, 'gptbot', 5_000);
      const lane = await openLane(h.db, h.team.id, 'dawn', 'worker', {
        title: 'a change',
        claim: true,
      });
      const sel = await selectReviewCounterpart(h.db, h.team.id, lane, 'worker', TIMEOUT);
      expect(sel.snapshot.candidates).toEqual(
        expect.arrayContaining([
          { member: 'gptbot', family: 'gpt', eligible: true, grade: 'cross_family' },
        ]),
      );
      expect(sel.snapshot.candidates.find((c) => c.member === 'gptbot')).not.toHaveProperty(
        'exclusion',
      );
    });

    it('unknown (no work audit) stays eligible — occupancy attestation is not work', async () => {
      // await agent() calls attach(), which writes occupancy.model_attested as actor=name at now.
      // If the picker treats that as work, this is null and every ladder test above breaks.
      const p = await pick(async ({ db, team }) => await agent(db, team, 'gptbot', 'gpt-5.6-sol'));
      expect(p).toMatchObject({ reviewer: 'gptbot', grade: 'cross_family' });
    });

    it('pickHumanReviewer still returns a live human who acted seconds ago', async () => {
      const { pickHumanReviewer } = await import('./review.js');
      const { db, team } = await seed();
      await agent(db, team, 'ada', 'claude-opus-5');
      const { row } = await addMember(db, team, { kind: 'human', name: 'nick', role: '' });
      await attach(db, row.id, 'cli', 'conn-nick');
      await acted(db, team, 'nick', 5_000);
      expect(await pickHumanReviewer(db, team.id, 'ada', TIMEOUT)).toMatchObject({
        reviewer: 'nick',
        grade: 'human',
      });
    });
  });

  describe('pickWakeReviewer (ADR 191)', () => {
    async function wentOffline(
      db: ReturnType<typeof seed>['db'],
      team: ReturnType<typeof seed>['team'],
      name: string,
      model: string,
      enrolled = true,
    ): void {
      const { row } = await addMember(db, team, { kind: 'agent', name, role: '' });
      await db.run(
        `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
       VALUES (?, ?, ?, NULL, 'occupancy.model_attested', ?, 'allow', ?, ?)`,
        [
          `a-${name}`,
          team.id,
          Date.now() - 3_600_000,
          name,
          JSON.stringify({ old: null, new: model, source: 'claim' }),
          Date.now() - 3_600_000,
        ],
      );
      if (enrolled) {
        await enrollResidency(db, team.id, {
          member_id: row.id,
          harness: 'claude-code',
          host: 'h',
          grant_id: 'g',
          authorized_by: 'nick',
        });
      }
    }

    it('picks a wakeable cross_family idle seat over a wakeable cross_model one', async () => {
      const { pickWakeReviewer } = await import('./review.js');
      const { db, team } = await seed();
      await agent(db, team, 'worker', 'claude-opus-5');
      await wentOffline(db, team, 'dolly', 'claude-opus-4-8');
      await wentOffline(db, team, 'gptbot', 'gpt-5.6-sol');
      const posture = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(await pickWakeReviewer(db, team.id, 'worker', posture)).toMatchObject({
        reviewer: 'gptbot',
        grade: 'cross_family',
      });
    });

    it('skips not_enrolled seats even when they would restore family diversity', async () => {
      const { pickWakeReviewer } = await import('./review.js');
      const { db, team } = await seed();
      await agent(db, team, 'worker', 'claude-opus-5');
      await agent(db, team, 'twin', 'claude-opus-5'); // monoculture live
      await wentOffline(db, team, 'grokbot', 'grok-4.5', false);
      const posture = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(await pickWakeReviewer(db, team.id, 'worker', posture)).toBeNull();
    });

    it('never routes same_model from the wake pool', async () => {
      const { pickWakeReviewer } = await import('./review.js');
      const { db, team } = await seed();
      await agent(db, team, 'worker', 'claude-opus-5');
      await wentOffline(db, team, 'twin', 'claude-opus-5');
      const posture = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(await pickWakeReviewer(db, team.id, 'worker', posture)).toBeNull();
    });
  });

  /**
   * Lane 01M1S6GZ96. Both pickers sorted by grade and took [0], so an equal-grade tie fell to
   * listMembers order — measured 32 of 32 ties in the 30 days to 2026-09-05 resolved to the earlier
   * roster seat, while the seat that kept winning held up to 14 open acceptance asks. The ladder
   * still decides first; these cases are all about what happens AMONG equal grades.
   */
  describe('tie-break among equal grades: load, then recency, then roster (lane 01M1S6GZ96)', () => {
    // Raw rows, each with its own replication stamp: (origin_node, origin_seq) is UNIQUE, and two
    // hand-inserted rows on the default stamp collide. A fixture counter keeps them apart.
    let seq = 1_000;
    const ask = async (
      db: ReturnType<typeof seed>['db'],
      team: { id: string },
      fromId: string,
      toId: string,
      laneId: string,
      id: string,
      ts = Date.now() - 60_000,
    ) =>
      await db.run(
        `INSERT INTO messages (id, team_id, from_member, to_kind, to_member, act, body, meta, ts, created_at, origin_node, origin_seq)
         VALUES (?, ?, ?, 'member', ?, 'ask', 'accept?', ?, ?, ?, 'fixture', ?)`,
        [
          id,
          team.id,
          fromId,
          toId,
          JSON.stringify({ lane_review: { lane: laneId } }),
          ts,
          ts,
          seq++,
        ],
      );
    const verdict = async (
      db: ReturnType<typeof seed>['db'],
      team: { id: string },
      fromId: string,
      askId: string,
      id: string,
    ) =>
      await db.run(
        `INSERT INTO messages (id, team_id, from_member, to_kind, act, body, meta, ts, created_at, origin_node, origin_seq)
         VALUES (?, ?, ?, 'team', 'accept', 'ok', ?, ?, ?, 'fixture', ?)`,
        [
          id,
          team.id,
          fromId,
          JSON.stringify({ in_reply_to: askId }),
          Date.now(),
          Date.now(),
          seq++,
        ],
      );
    const picked = async (
      db: ReturnType<typeof seed>['db'],
      team: { id: string },
      reviewer: string,
      laneId: string,
      at: number,
    ) =>
      await db.run(
        `INSERT INTO audit (id, team_id, actor, action, target, result, detail, ts, created_at)
         VALUES (?, ?, 'x', 'lane.ready_for_review', ?, 'allow', ?, ?, ?)`,
        [
          `r-${reviewer}-${String(at)}`,
          team.id,
          laneId,
          JSON.stringify({ lane: laneId, reviewer }),
          at,
          at,
        ],
      );

    async function room() {
      const { openLane } = await import('./lanes.js');
      const { db, team } = await seed();
      const worker = (await addMember(db, team, { kind: 'agent', name: 'worker', role: '' })).row;
      await attach(db, worker.id, 'claude-code', 'conn-worker', { model: 'claude-opus-5' });
      // `first` is created before `second`, so roster order alone would always pick `first`.
      const first = (await addMember(db, team, { kind: 'agent', name: 'first', role: '' })).row;
      await attach(db, first.id, 'codex', 'conn-first', { model: 'gpt-5.6-sol' });
      const second = (await addMember(db, team, { kind: 'agent', name: 'second', role: '' })).row;
      await attach(db, second.id, 'codex', 'conn-second', { model: 'gpt-5.6-sol' });
      const lane = await openLane(db, team.id, 'dawn', 'worker', {
        title: 'judge me',
        claim: true,
      });
      const other = await openLane(db, team.id, 'dawn', 'worker', {
        title: 'held elsewhere',
        claim: true,
      });
      await db.run(`UPDATE lanes SET state = 'awaiting_acceptance' WHERE id = ?`, [other.id]);
      return { db, team, worker, first, second, lane, other };
    }

    it('picks the equal-grade seat holding fewer open acceptance asks, and says so', async () => {
      const { selectReviewCounterpart } = await import('./review.js');
      const { db, team, worker, first, lane, other } = await room();
      await ask(db, team, worker.id, first.id, other.id, 'ask-1');
      const sel = await selectReviewCounterpart(db, team.id, lane, 'worker', TIMEOUT);
      expect(sel.pick).toMatchObject({ reviewer: 'second', grade: 'cross_family' });
      expect(sel.snapshot.selected).toEqual({
        reviewer: 'second',
        grade: 'cross_family',
        tie_decided_by: 'load',
      });
      expect(sel.snapshot.candidates).toContainEqual({
        member: 'first',
        family: 'gpt',
        eligible: false,
        exclusion: 'tie_break',
      });
    });

    it('an answered ask and an ask on a closed lane are not load', async () => {
      const { selectReviewCounterpart, openAcceptanceLoad } = await import('./review.js');
      const { db, team, worker, second, lane, other } = await room();
      await ask(db, team, worker.id, second.id, other.id, 'ask-answered');
      await verdict(db, team, second.id, 'ask-answered', 'v-1');
      const done = (await db.get(`SELECT id FROM lanes WHERE id = ?`, [other.id])) as {
        id: string;
      };
      await db.run(`UPDATE lanes SET state = 'done' WHERE id = ?`, [done.id]);
      await ask(db, team, worker.id, second.id, done.id, 'ask-on-done-lane');
      // `first` holds nothing at all; with `second`'s two asks discounted the pair ties on load.
      expect(await openAcceptanceLoad(db, team.id)).toEqual(new Map());
      const sel = await selectReviewCounterpart(db, team.id, lane, 'worker', TIMEOUT);
      expect(sel.snapshot.selected?.tie_decided_by).toBe('roster');
      expect(sel.pick?.reviewer).toBe('first');
    });

    it('on equal load, the least recently picked seat wins', async () => {
      const { selectReviewCounterpart } = await import('./review.js');
      const { db, team, lane, other } = await room();
      await picked(db, team, 'first', other.id, Date.now() - 1_000);
      await picked(db, team, 'second', other.id, Date.now() - 3_600_000);
      const sel = await selectReviewCounterpart(db, team.id, lane, 'worker', TIMEOUT);
      expect(sel.pick?.reviewer).toBe('second');
      expect(sel.snapshot.selected?.tie_decided_by).toBe('recency');
    });

    it('a full tie still falls to roster order — the last resort, and named as such', async () => {
      const { selectReviewCounterpart } = await import('./review.js');
      const { db, team, lane } = await room();
      const sel = await selectReviewCounterpart(db, team.id, lane, 'worker', TIMEOUT);
      expect(sel.pick?.reviewer).toBe('first');
      expect(sel.snapshot.selected?.tie_decided_by).toBe('roster');
    });

    it('no equal-grade rival: decided by grade, and load never reorders across rungs', async () => {
      const { selectReviewCounterpart } = await import('./review.js');
      // Built here rather than from await room(): `second` must be cross_model from its FIRST attestation.
      // Re-attaching it under a second model in the same millisecond made "latest attestation" a
      // coin flip between the two rows, and the test flaked 2 in 3 runs.
      const { openLane } = await import('./lanes.js');
      const { db, team } = await seed();
      const worker = (await addMember(db, team, { kind: 'agent', name: 'worker', role: '' })).row;
      await attach(db, worker.id, 'claude-code', 'conn-worker', { model: 'claude-opus-5' });
      const first = (await addMember(db, team, { kind: 'agent', name: 'first', role: '' })).row;
      await attach(db, first.id, 'codex', 'conn-first', { model: 'gpt-5.6-sol' });
      const second = (await addMember(db, team, { kind: 'agent', name: 'second', role: '' })).row;
      await attach(db, second.id, 'claude-code', 'conn-second', { model: 'claude-opus-4-8' });
      const lane = await openLane(db, team.id, 'dawn', 'worker', {
        title: 'judge me',
        claim: true,
      });
      const other = await openLane(db, team.id, 'dawn', 'worker', { title: 'held', claim: true });
      await db.run(`UPDATE lanes SET state = 'awaiting_acceptance' WHERE id = ?`, [other.id]);
      // Load `first` (cross_family) heavily. Grade must still win over the lighter cross_model seat.
      for (let i = 0; i < 5; i++)
        await ask(db, team, worker.id, first.id, other.id, `ask-heavy-${i}`);
      const sel = await selectReviewCounterpart(db, team.id, lane, 'worker', TIMEOUT);
      expect(sel.pick).toMatchObject({ reviewer: 'first', grade: 'cross_family' });
      expect(sel.snapshot.selected?.tie_decided_by).toBe('grade');
    });

    it('the wake picker breaks an equal-grade tie by load too', async () => {
      const { pickWakeReviewer } = await import('./review.js');
      const { openLane } = await import('./lanes.js');
      const { db, team } = await seed();
      const worker = (await addMember(db, team, { kind: 'agent', name: 'worker', role: '' })).row;
      await attach(db, worker.id, 'claude-code', 'conn-worker', { model: 'claude-opus-5' });
      const offline = async (name: string) => {
        const { row } = await addMember(db, team, { kind: 'agent', name, role: '' });
        await db.run(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
         VALUES (?, ?, ?, NULL, 'occupancy.model_attested', ?, 'allow', ?, ?)`,
          [
            `a-${name}`,
            team.id,
            Date.now() - 3_600_000,
            name,
            JSON.stringify({ old: null, new: 'gpt-5.6-sol', source: 'claim' }),
            Date.now() - 3_600_000,
          ],
        );
        await enrollResidency(db, team.id, {
          member_id: row.id,
          harness: 'claude-code',
          host: 'h',
          grant_id: 'g',
          authorized_by: 'nick',
        });
        return row;
      };
      const first = await offline('first');
      await offline('second');
      const held = await openLane(db, team.id, 'dawn', 'worker', { title: 'held', claim: true });
      await db.run(`UPDATE lanes SET state = 'awaiting_acceptance' WHERE id = ?`, [held.id]);
      await ask(db, team, worker.id, first.id, held.id, 'ask-wake');
      const posture = await teamFamilyPosture(db, team.id, TIMEOUT);
      expect(await pickWakeReviewer(db, team.id, 'worker', posture)).toMatchObject({
        reviewer: 'second',
      });
    });
  });

  describe('reviewLoopBounceCount (ADR 191)', () => {
    it('counts prior ready_for_review audit rows for the lane', async () => {
      const { reviewLoopBounceCount, REVIEW_LOOP_BREAKER_N } = await import('./review.js');
      const { appendAudit } = await import('./audit.js');
      const { db, team } = await seed();
      expect(REVIEW_LOOP_BREAKER_N).toBe(3);
      expect(await reviewLoopBounceCount(db, team.id, 'lane-1')).toBe(0);
      await appendAudit(db, team.id, {
        actor: 'ada',
        action: 'lane.ready_for_review',
        target: 'lane-1',
        result: 'allow',
        detail: { lane: 'lane-1' },
      });
      await appendAudit(db, team.id, {
        actor: 'ada',
        action: 'lane.ready_for_review',
        target: 'lane-1',
        result: 'allow',
        detail: { lane: 'lane-1' },
      });
      expect(await reviewLoopBounceCount(db, team.id, 'lane-1')).toBe(2);
      expect(await reviewLoopBounceCount(db, team.id, 'other')).toBe(0);
    });
  });

  /**
   * Lane 01M2RNBRGRWCSD89JTE1BVQ3QG — an acceptance ask outlives the session it was routed to.
   *
   * Measured 2026-09-17: big-body raised a `lane_review` ask to delta at 16:11:47 and delta's session
   * ended at 16:14:11 — two and a half minutes later. Nothing reacted. The only recovery today is
   * `staleAcceptanceWarning` at ACCEPTANCE_STALE_MS (12h), which downgrades a directed ask to "any
   * seat may answer" and waits to be read; the ask sat 22h.
   *
   * `abandonedAcceptances` is the read that makes the departure actionable: which open acceptance
   * asks are held by a seat that is no longer live. It decides nothing and mints nothing — the caller
   * re-routes, using the machinery `lane.review_rerouted` already provides.
   */
  describe('selectReviewCounterpart — the departing seat (lane 01M2RNBRGRWCSD89JTE1BVQ3QG)', () => {
    /**
     * A seat re-routing its own acceptance on the way out is still attached when it says so: the
     * `/residency/session` end route is presence-neutral and moves no presence row. So the picker has
     * to be told, or it hands the ask straight back to the seat that is leaving.
     */
    it('never re-picks the seat named as departing, and files it under its own reason', async () => {
      const { openLane } = await import('./lanes.js');
      const { selectReviewCounterpart } = await import('./review.js');
      const { db, team } = await seed();
      await agent(db, team, 'worker', 'claude-opus-5');
      await agent(db, team, 'delta', 'gpt-5.6-sol');
      await agent(db, team, 'kim', 'gpt-5.6-sol');
      const lane = await openLane(db, team.id, team.slug, 'worker', { title: 'l', claim: true });

      const open = await selectReviewCounterpart(db, team.id, lane, 'worker', TIMEOUT);
      expect(['delta', 'kim']).toContain(open.pick?.reviewer);

      const leaving = await selectReviewCounterpart(db, team.id, lane, 'worker', TIMEOUT, {
        departing: 'delta',
      });
      expect(leaving.pick?.reviewer).toBe('kim');
      expect(leaving.snapshot.candidates.find((c) => c.member === 'delta')?.exclusion).toBe(
        'departing',
      );
    });
  });

  describe('abandonedAcceptances (lane 01M2RNBRGRWCSD89JTE1BVQ3QG)', async () => {
    async function laneAwaitingAcceptanceHeldBy(holder: string) {
      const { db, team } = await seed();
      const worker = (await addMember(db, team, { kind: 'agent', name: 'ada', role: '' })).row;
      const reviewer = (await addMember(db, team, { kind: 'agent', name: holder, role: '' })).row;
      const lane = await openLane(db, team.id, team.slug, worker.name, {
        title: 'a lane awaiting acceptance',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, team.slug, { state: 'awaiting_acceptance' });
      await insertMessage(
        db,
        team.id,
        worker.id,
        reviewer.id,
        makeEnvelope({
          id: 'ask-abandoned-1',
          team: team.slug,
          from: worker.name,
          to: { kind: 'member', name: reviewer.name },
          act: 'ask',
          body: '[lane] acceptance requested',
          meta: { species: 'approve', tier: 'standard', lane_review: { lane: lane.id } },
          ts: 1_000,
        }),
      );
      return { db, team, lane, reviewer };
    }

    it('names the lane when the seat holding the ask has no live Presence', async () => {
      const { db, team, lane, reviewer } = await laneAwaitingAcceptanceHeldBy('delta');
      // delta never attached, which is what its session having ended looks like from here.
      expect(await abandonedAcceptances(db, team.id, reviewer.name, TIMEOUT)).toEqual([
        { lane: lane.id, ask: 'ask-abandoned-1', holder: 'delta' },
      ]);
    });

    it('names nothing once the ask has been answered, however long the seat has been gone', async () => {
      const { db, team, lane, reviewer } = await laneAwaitingAcceptanceHeldBy('delta');
      const verdict = (await addMember(db, team, { kind: 'agent', name: 'kim', role: '' })).row;
      await insertMessage(
        db,
        team.id,
        verdict.id,
        null,
        makeEnvelope({
          id: 'verdict-1',
          team: team.slug,
          from: 'kim',
          to: { kind: 'team' },
          act: 'accept',
          body: 'ACCEPTED',
          meta: { in_reply_to: 'ask-abandoned-1', lane_review: { lane: lane.id } },
          ts: 2_000,
        }),
      );
      expect(await abandonedAcceptances(db, team.id, reviewer.name, TIMEOUT)).toEqual([]);
    });

    it("heldAcceptances names it regardless of liveness — the goodbye is the caller's signal", async () => {
      const { db, team, lane, reviewer } = await laneAwaitingAcceptanceHeldBy('delta');
      await attach(db, reviewer.id, 'claude-code', 'conn-delta');
      // Still attached, because a seat reporting its own session end has not detached yet.
      expect(await heldAcceptances(db, team.id, reviewer.name)).toEqual([
        { lane: lane.id, ask: 'ask-abandoned-1', holder: 'delta' },
      ]);
    });

    it('names nothing while that seat is still live', async () => {
      const { db, team, reviewer } = await laneAwaitingAcceptanceHeldBy('delta');
      await attach(db, reviewer.id, 'claude-code', 'conn-delta');
      expect(await abandonedAcceptances(db, team.id, reviewer.name, TIMEOUT)).toEqual([]);
    });
  });

  describe('acceptanceWaits — who an awaiting lane waits on, for the board (ADR 518)', () => {
    let seq = 5_000;
    async function room() {
      const { db, team } = await seed();
      const owner = (await addMember(db, team, { kind: 'agent', name: 'izzo', role: '' })).row;
      const ghost = (await addMember(db, team, { kind: 'agent', name: 'ghost', role: '' })).row;
      const dolly = (await addMember(db, team, { kind: 'agent', name: 'dolly', role: '' })).row;
      const lane = await openLane(db, team.id, 'dawn', 'izzo', { title: 'judge me', claim: true });
      await db.run(`UPDATE lanes SET state = 'awaiting_acceptance' WHERE id = ?`, [lane.id]);
      return { db, team, owner, ghost, dolly, lane };
    }
    const ask = async (
      db: Driver,
      teamId: string,
      fromId: string,
      toId: string,
      laneId: string,
      id: string,
      ts: number,
    ) =>
      await db.run(
        `INSERT INTO messages (id, team_id, from_member, to_kind, to_member, act, body, meta, ts, created_at, origin_node, origin_seq)
         VALUES (?, ?, ?, 'member', ?, 'ask', 'accept?', ?, ?, ?, 'fixture', ?)`,
        [
          id,
          teamId,
          fromId,
          toId,
          JSON.stringify({ lane_review: { lane: laneId } }),
          ts,
          ts,
          seq++,
        ],
      );
    const audit = async (
      db: Driver,
      teamId: string,
      action: string,
      laneId: string,
      detail: object,
      ts: number,
    ) =>
      await db.run(
        `INSERT INTO audit (id, team_id, actor, action, target, result, detail, ts, created_at)
         VALUES (?, ?, 'x', ?, ?, 'allow', ?, ?, ?)`,
        [`a-${String(seq++)}`, teamId, action, laneId, JSON.stringify(detail), ts, ts],
      );

    it('names the seat holding the open ask, and the route the ready row recorded', async () => {
      const { acceptanceWaits } = await import('./review.js');
      const { db, team, owner, ghost, lane } = await room();
      await audit(
        db,
        team.id,
        'lane.ready_for_review',
        lane.id,
        {
          lane: lane.id,
          review_selection: { outcome: 'peer_selected', selected: { reviewer: 'ghost' } },
          reviewer: 'ghost',
        },
        1_000,
      );
      await ask(db, team.id, owner.id, ghost.id, lane.id, 'ask-1', 1_000);
      expect((await acceptanceWaits(db, team.id)).get(lane.id)).toEqual({
        reviewer: 'ghost',
        route: 'peer_selected',
      });
    });

    it('follows a re-route: the superseding ask’s holder, never the first pick', async () => {
      const { acceptanceWaits } = await import('./review.js');
      const { db, team, owner, ghost, dolly, lane } = await room();
      await ask(db, team.id, owner.id, ghost.id, lane.id, 'ask-old', 1_000);
      await ask(db, team.id, owner.id, dolly.id, lane.id, 'ask-new', 2_000);
      await audit(
        db,
        team.id,
        'lane.review_rerouted',
        lane.id,
        {
          reviewer: 'dolly',
          superseded_ask: 'ask-old',
        },
        2_000,
      );
      expect((await acceptanceWaits(db, team.id)).get(lane.id)?.reviewer).toBe('dolly');
    });

    it('a superseded newest ask holds nothing, exactly as openAcceptanceAsk says', async () => {
      const { acceptanceWaits, openAcceptanceAsk } = await import('./review.js');
      const { db, team, owner, ghost, lane } = await room();
      await ask(db, team.id, owner.id, ghost.id, lane.id, 'ask-1', 1_000);
      await audit(db, team.id, 'lane.review_rerouted', lane.id, { superseded_ask: 'ask-1' }, 2_000);
      expect(await openAcceptanceAsk(db, team.id, lane.id)).toBeNull();
      expect((await acceptanceWaits(db, team.id)).get(lane.id)?.reviewer).toBeUndefined();
    });

    it('reads the pre-ADR 303 flat fields, and drops a route it does not know', async () => {
      const { acceptanceWaits } = await import('./review.js');
      const { db, team, lane } = await room();
      await audit(db, team.id, 'lane.ready_for_review', lane.id, { no_candidate: true }, 1_000);
      expect((await acceptanceWaits(db, team.id)).get(lane.id)).toEqual({ route: 'no_candidate' });
      await audit(
        db,
        team.id,
        'lane.ready_for_review',
        lane.id,
        {
          review_selection: { outcome: 'something_newer' },
        },
        2_000,
      );
      expect((await acceptanceWaits(db, team.id)).get(lane.id)).toBeUndefined();
    });

    it('annotates only lanes still awaiting acceptance', async () => {
      const { acceptanceWaits } = await import('./review.js');
      const { db, team, owner, ghost, lane } = await room();
      await ask(db, team.id, owner.id, ghost.id, lane.id, 'ask-1', 1_000);
      await db.run(`UPDATE lanes SET state = 'done' WHERE id = ?`, [lane.id]);
      expect(await acceptanceWaits(db, team.id)).toEqual(new Map());
    });
  });
});

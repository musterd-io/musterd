import {
  type CaptureRepoSeed,
  type NextBrief,
  type PromoteSeed,
  type RelaySeed,
  type Seed,
  SeedSchema,
  type SubmitSeedBrief,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { MusterdError } from '../errors.js';
import { log } from '../log.js';
import { appendReplicatedEvent } from './audit.js';
import { openLane } from './lanes.js';
import { getMemberByName } from './members.js';
import type { MemberRow } from './rows.js';

interface SeedRow {
  id: string;
  team_id: string;
  relay_id: string;
  source: 'slack' | 'repo';
  body: string;
  captured_at: number;
  slack_user_id: string | null;
  submitted_by: string;
  state: Seed['state'];
  explorer_id: string | null;
  final_brief: string | null;
  conclusion: string | null;
  linked_lane_id: string | null;
  promotion_kind: 'automatic' | 'manual' | null;
  research_skipped: number | null;
  promoted_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

async function toSeed(row: SeedRow, team: string, db: Driver): Promise<Seed> {
  const thread = (
    await db.all<{ id: string; kind: string; body: string; name: string; created_at: number }>(
      `SELECT e.id, e.kind, e.body, m.name, e.created_at
       FROM seed_thread_entries e JOIN members m ON m.id = e.member_id
       WHERE e.seed_id = ? ORDER BY e.created_at, e.id`,
      [row.id],
    )
  ).map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    body: entry.body,
    by: entry.name,
    created_at: entry.created_at,
  }));
  const memberName = (
    await db.get<{ name: string }>('SELECT name FROM members WHERE id = ?', [row.submitted_by])
  )?.name;
  const explorer = row.explorer_id
    ? ((await db.get<{ name: string }>('SELECT name FROM members WHERE id = ?', [row.explorer_id]))
        ?.name ?? null)
    : null;
  return SeedSchema.parse({
    ...row,
    team,
    submitted_by: memberName,
    explorer,
    thread,
    final_brief: row.final_brief ? JSON.parse(row.final_brief) : null,
    promotion: row.promotion_kind
      ? {
          kind: row.promotion_kind,
          research_skipped: Boolean(row.research_skipped),
          at: row.promoted_at,
        }
      : null,
  });
}

export async function createSeedFromRelay(
  db: Driver,
  teamId: string,
  relay: RelaySeed,
  now = Date.now(),
): Promise<Seed> {
  const prior = await db.get<SeedRow>('SELECT * FROM seeds WHERE team_id = ? AND relay_id = ?', [
    teamId,
    relay.id,
  ]);
  const team = (await db.get<{ slug: string }>('SELECT slug FROM teams WHERE id = ?', [teamId]))!;
  if (prior) return await toSeed(prior, team.slug, db);
  const submitter = await db.get<{ id: string }>(
    `SELECT id FROM members
       WHERE team_id = ? AND kind = 'human' AND left_at IS NULL AND slack_user_id = ?`,
    [teamId, relay.meta.user],
  );
  if (!submitter) throw new Error('unknown_submitter');
  const id = ulid(now);
  await db.run(
    `INSERT INTO seeds
       (id, team_id, relay_id, source, body, captured_at, slack_user_id, submitted_by, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    [
      id,
      teamId,
      relay.id,
      relay.source,
      relay.body,
      relay.ts,
      relay.meta.user,
      submitter.id,
      now,
      now,
    ],
  );
  const row = (await db.get<SeedRow>('SELECT * FROM seeds WHERE id = ?', [id]))!;
  await projectHeldThreads(db, teamId, row); // ADR 500
  // ADR 399: the capture crosses to every joiner, so a seat on a second machine holds the team's
  // ideation without holding the relay's bearer token.
  const submitterName = await db.get<{ name: string }>('SELECT name FROM members WHERE id = ?', [
    submitter.id,
  ]);
  if (submitterName) await stampSeedCapture(db, teamId, row, submitterName.name, now);
  return await toSeed(row, team.slug, db);
}

/** `relay_id` for a document-recorded intention: the source's own identifier, namespaced so it can
 *  never collide with a relay record id. */
export function repoRelayId(ref: string): string {
  return `repo:${ref.trim()}`;
}

/**
 * ADR 373 increment 2: capture a document-recorded intention as a Seed — the same shape the relay
 * ingest produces, with the repo path + anchor where the Slack record id would be. Idempotent on
 * that key: a second capture returns the row the first one made, body untouched (the source is
 * immutable, ADR 291), so a batch capture can be re-run safely. (Its bulk caller, `intents:ingest`,
 * was retired by ADR 487 on 2026-09-30.)
 *
 * `lane_id` is a `Follows-up: <lane-id>` already written: the Seed is born (or moves to) `promoted`
 * with `linked_lane_id` set — the seed → lane edge ADR 248 built — so "which document asked for this
 * lane?" is a query over seeds, not a new lane field. An open Seed whose ref is later disposed with
 * a lane id is linked the same way; a Seed already promoted elsewhere is left alone.
 */
export async function captureRepoSeed(
  db: Driver,
  teamId: string,
  actor: MemberRow,
  input: CaptureRepoSeed,
  now = Date.now(),
): Promise<Seed> {
  const team = (await db.get<{ slug: string }>('SELECT slug FROM teams WHERE id = ?', [teamId]))!;
  const relayId = repoRelayId(input.ref);
  const tx = () =>
    db.tx(async (t): Promise<Seed> => {
      if (input.lane_id !== undefined) {
        const lane = await t.get<{ id: string }>(
          'SELECT id FROM lanes WHERE team_id = ? AND id = ?',
          [teamId, input.lane_id],
        );
        if (!lane) throw new MusterdError('bad_request', `Lane "${input.lane_id}" not found`);
      }
      const prior = await t.get<SeedRow>('SELECT * FROM seeds WHERE team_id = ? AND relay_id = ?', [
        teamId,
        relayId,
      ]);
      if (prior) {
        if (input.lane_id !== undefined && prior.linked_lane_id === null) {
          await t.run(
            `UPDATE seeds
           SET state = 'promoted', explorer_id = NULL, linked_lane_id = ?, promotion_kind = 'manual',
               research_skipped = 1, promoted_at = ?, updated_at = ?
           WHERE team_id = ? AND id = ?`,
            [input.lane_id, now, now, teamId, prior.id],
          );
        }
        return await toSeed(
          (await t.get<SeedRow>('SELECT * FROM seeds WHERE id = ?', [prior.id]))!,
          team.slug,
          t,
        );
      }
      const id = ulid(now);
      const promoted = input.lane_id !== undefined;
      await t.run(
        `INSERT INTO seeds
         (id, team_id, relay_id, source, body, captured_at, slack_user_id, submitted_by, state,
          linked_lane_id, promotion_kind, research_skipped, promoted_at, created_at, updated_at)
       VALUES (?, ?, ?, 'repo', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          teamId,
          relayId,
          input.body,
          input.captured_at ?? now,
          actor.id,
          promoted ? 'promoted' : 'open',
          input.lane_id ?? null,
          promoted ? 'manual' : null,
          promoted ? 1 : null,
          promoted ? now : null,
          now,
          now,
        ],
      );
      const row = (await t.get<SeedRow>('SELECT * FROM seeds WHERE id = ?', [id]))!;
      await projectHeldThreads(t, teamId, row); // ADR 500
      await stampSeedCapture(t, teamId, row, actor.name, now); // ADR 399
      return await toSeed(row, team.slug, t);
    });
  return tx();
}

export async function listSeeds(db: Driver, teamId: string): Promise<Seed[]> {
  const team = (await db.get<{ slug: string }>('SELECT slug FROM teams WHERE id = ?', [teamId]))!;
  const rows = await db.all<SeedRow>(
    'SELECT * FROM seeds WHERE team_id = ? ORDER BY created_at, id',
    [teamId],
  );
  return Promise.all(rows.map((row) => toSeed(row, team.slug, db)));
}

/**
 * ADR 373 increment 4: the open Seeds the orientation brief leads its up-next section with, oldest
 * capture first, plus how many are open in total.
 *
 * A lean projection, not `listSeeds` — that one hydrates the exploration thread and the final brief
 * for every row, and this runs on every `next`. `summary` is the body's first non-blank line, which
 * for a repo Seed is the promise as written (the `— path:line` provenance line beneath it is
 * already carried by `ref`).
 */
export async function openSeedsForBrief(
  db: Driver,
  teamId: string,
  limit: number,
): Promise<{ seeds: NextBrief['up_next_seeds']; total: number }> {
  const total = (await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM seeds WHERE team_id = ? AND state = 'open'",
    [teamId],
  ))!.n;
  const rows = await db.all<{
    id: string;
    source: 'slack' | 'repo';
    relay_id: string;
    body: string;
    captured_at: number;
    name: string;
  }>(
    `SELECT s.id, s.source, s.relay_id, s.body, s.captured_at, m.name
       FROM seeds s JOIN members m ON m.id = s.submitted_by
       WHERE s.team_id = ? AND s.state = 'open'
       ORDER BY s.captured_at, s.id
       LIMIT ?`,
    [teamId, limit],
  );
  return {
    total,
    seeds: rows.map((row) => ({
      id: row.id,
      source: row.source,
      ref: row.source === 'repo' ? repoRefFromRelayId(row.relay_id) : null,
      summary: firstLine(row.body),
      submitted_by: row.name,
      captured_at: row.captured_at,
    })),
  };
}

/** The repo path + anchor a `repo:` relay id carries, or null if it is not one. */
function repoRefFromRelayId(relayId: string): string | null {
  return relayId.startsWith('repo:') ? relayId.slice('repo:'.length) : null;
}

/** The first line with text in it, bounded — a brief renders this on one line. */
function firstLine(body: string): string {
  const first = body
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  return (first || 'Seed').slice(0, 120);
}

export async function getSeed(db: Driver, teamId: string, seedId: string): Promise<Seed | null> {
  const team = await db.get<{ slug: string }>('SELECT slug FROM teams WHERE id = ?', [teamId]);
  if (!team) return null;
  const row = await db.get<SeedRow>('SELECT * FROM seeds WHERE team_id = ? AND id = ?', [
    teamId,
    seedId,
  ]);
  return row ? await toSeed(row, team.slug, db) : null;
}

async function requireSeed(db: Driver, teamId: string, seedId: string): Promise<Seed> {
  const seed = await getSeed(db, teamId, seedId);
  if (!seed) throw new MusterdError('not_found', `Seed "${seedId}" not found`);
  return seed;
}

/**
 * Stamp a relay capture as `seed.captured` (ADR 399), in the caller's transaction.
 *
 * The event names the seed by `relay_id` and the submitter by NAME — `seeds.id` and `members.id`
 * are minted per daemon and mean nothing off this machine, exactly as `record.seed_thread` already
 * has it. Lifecycle state is deliberately NOT carried: this replicates the capture, not the claim
 * (ADR 371 §3, unchanged). `promoted` seeds ship their `linked_lane_id` because the lane itself
 * replicates and a repo capture is born promoted; the explorer claim still never crosses.
 *
 * Hub-minted by rule: `sync/log.ts` refuses a pushed `seed` event from any node but the hub, so the
 * relay has one poller per team and a capture has one birth.
 */
async function stampSeedCapture(
  db: Driver,
  teamId: string,
  seed: SeedRow,
  submitterName: string,
  now: number,
): Promise<void> {
  await appendReplicatedEvent(db, teamId, {
    actor: submitterName,
    action: 'seed.captured',
    target: seed.relay_id,
    result: 'allow',
    detail: {
      relay_id: seed.relay_id,
      source: seed.source,
      body: seed.body,
      captured_at: seed.captured_at,
      slack_user_id: seed.slack_user_id,
      by: submitterName,
      linked_lane_id: seed.linked_lane_id,
      promotion_kind: seed.promotion_kind,
      created_at: now,
    },
  });
}

/** What a folded `seed.captured` carries. Mirrors `stampSeedCapture`'s detail. */
export interface SeedCapture {
  relay_id: string;
  source: string;
  body: string;
  captured_at: number;
  slack_user_id: string | null;
  linked_lane_id: string | null;
  promotion_kind: string | null;
}

/**
 * The fold's projector primitive for `seed.captured` (ADR 399): one seed row, no stamp.
 *
 * Idempotent on `(team_id, relay_id)` — the table's own UNIQUE — so a re-delivered pull batch is a
 * no-op rather than a duplicate, and a node that had already relay-ingested the same capture keeps
 * its local row. The local `seeds.id` stays daemon-private: it is minted here, and the thread
 * entries that arrive later resolve to it by `relay_id`, which is the whole reason that key exists.
 */
export async function applySeedCapture(
  db: Driver,
  teamId: string,
  capture: SeedCapture,
  submitterId: string,
  now: number,
): Promise<'applied' | 'held'> {
  const prior = await db.get<{ id: string }>(
    'SELECT id FROM seeds WHERE team_id = ? AND relay_id = ?',
    [teamId, capture.relay_id],
  );
  if (prior) return 'held';
  const promoted = capture.linked_lane_id !== null;
  const id = ulid(now);
  await db.run(
    `INSERT INTO seeds
       (id, team_id, relay_id, source, body, captured_at, slack_user_id, submitted_by, state,
        linked_lane_id, promotion_kind, research_skipped, promoted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      teamId,
      capture.relay_id,
      capture.source,
      capture.body,
      capture.captured_at,
      capture.slack_user_id,
      submitterId,
      promoted ? 'promoted' : 'open',
      capture.linked_lane_id,
      capture.promotion_kind,
      promoted ? 1 : null,
      promoted ? now : null,
      now,
      now,
    ],
  );
  await projectHeldThreads(db, teamId, { id, relay_id: capture.relay_id }); // ADR 500
  return 'applied';
}

/**
 * Project the thread entries this daemon folded BEFORE it held their seed (ADR 500), now that it
 * does. The fold holds such an entry in `audit` — stamp and all, so `heldPair` never offers it
 * again — instead of stopping on it, because an entry is an append: projecting it late yields the
 * same row as projecting it on time. This is the other half of that bargain, and it runs on every
 * local birth: a folded capture, a relay ingest, a repo capture.
 *
 * Selected on `audit.target`, which `applyThread` sets to the seed's `relay_id` (no JSON operator,
 * so both drivers read it alike), and then REQUIRED to name this seed in `detail.relay_id` too: the
 * fold decides "held" from `detail.relay_id`, and hub ingest never checks the two agree, so a push
 * with `target` Y and `relay_id` X would be held on a node lacking X and then projected onto Y
 * (lane 01M400A31W, the #2011 review). A null `target` is selected as well, so an entry the fold held
 * on its `relay_id` is not stranded for want of the column. `INSERT OR IGNORE` on the entry id makes
 * it a no-op for every entry already projected — on a hub, that is all of them. A writer whose name
 * no longer resolves here is left in `audit` rather than guessed at — the fold resolved it once, so
 * this is a roster change, not a hole — and logged, so the skip is not silent.
 */
export async function projectHeldThreads(
  db: Driver,
  teamId: string,
  seed: { id: string; relay_id: string },
): Promise<number> {
  const held = await db.all<{ actor: string | null; ts: number; detail: string | null }>(
    `SELECT actor, ts, detail FROM audit
      WHERE team_id = ? AND action = 'record.seed_thread' AND (target = ? OR target IS NULL)`,
    [teamId, seed.relay_id],
  );
  let projected = 0;
  for (const row of held) {
    const d = row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : {};
    const entryId = d['entry_id'];
    const kind = d['kind'];
    const body = d['body'];
    const name = typeof d['by'] === 'string' ? d['by'] : (row.actor ?? '');
    if (typeof entryId !== 'string' || typeof kind !== 'string' || typeof body !== 'string') {
      continue;
    }
    // The entry must name THIS seed where the fold read it, not only in the column we selected on.
    if (d['relay_id'] !== seed.relay_id) continue;
    const member = await getMemberByName(db, teamId, name);
    if (!member) {
      log.warn({
        msg: 'seed_thread_projection_skipped',
        team: teamId,
        relay_id: seed.relay_id,
        entry_id: entryId,
        writer: name,
        reason: 'writer_unresolved',
      });
      continue;
    }
    const { changes } = await db.run(
      `INSERT OR IGNORE INTO seed_thread_entries (id, seed_id, team_id, kind, body, member_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entryId,
        seed.id,
        teamId,
        kind,
        body,
        member.id,
        typeof d['created_at'] === 'number' ? d['created_at'] : row.ts,
      ],
    );
    projected += changes;
  }
  return projected;
}

type ThreadKind = 'clarification' | 'answer' | 'brief' | 'conclusion';

/** The fold's silent projector primitive: one thread row, no stamp (ADR 371 §1). */
async function appendThread(
  db: Driver,
  entryId: string,
  teamId: string,
  seedId: string,
  memberId: string,
  kind: ThreadKind,
  body: string,
  now: number,
): Promise<void> {
  await db.run(
    `INSERT INTO seed_thread_entries (id, seed_id, team_id, kind, body, member_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [entryId, seedId, teamId, kind, body, memberId, now],
  );
}

/**
 * Append a thread entry AND stamp it as `record.seed_thread` (ADR 371 §3), in the caller's
 * transaction. The event names the seed by `relay_id` and the writer by NAME — `seeds.id` and
 * `members.id` are minted per daemon and mean nothing off this machine — and carries the entry's
 * own id, so both machines hold the same row under the same key. The seed's lifecycle state does
 * NOT cross with it (§3): a brief replicates, the `state = 'completed'` beside it stays local.
 */
async function applyThread(
  db: Driver,
  teamId: string,
  seed: { id: string; relay_id: string },
  actor: MemberRow,
  kind: ThreadKind,
  body: string,
  now: number,
): Promise<void> {
  const entryId = ulid(now);
  await appendThread(db, entryId, teamId, seed.id, actor.id, kind, body, now);
  await appendReplicatedEvent(db, teamId, {
    actor: actor.name,
    action: 'record.seed_thread',
    target: seed.relay_id,
    result: 'allow',
    detail: {
      entry_id: entryId,
      relay_id: seed.relay_id,
      kind,
      body,
      by: actor.name,
      created_at: now,
    },
  });
}

export async function claimSeed(
  db: Driver,
  teamId: string,
  seedId: string,
  actor: MemberRow,
  now = Date.now(),
): Promise<Seed> {
  if (actor.kind !== 'agent')
    throw new MusterdError('forbidden', 'only an agent Member may explore a Seed');
  const seed = await requireSeed(db, teamId, seedId);
  if (seed.state !== 'open' && seed.state !== 'clarified')
    throw new MusterdError('conflict', `Seed "${seedId}" is not claimable`);
  // The WHERE repeats the check: two agents claiming at once both read `open`, and only one UPDATE
  // may win (review I5, 2026-09-30).
  const { changes } = await db.run(
    `UPDATE seeds SET state = 'exploring', explorer_id = ?, updated_at = ?
     WHERE team_id = ? AND id = ? AND state IN ('open', 'clarified')`,
    [actor.id, now, teamId, seedId],
  );
  if (changes === 0) throw new MusterdError('conflict', `Seed "${seedId}" is not claimable`);
  return await requireSeed(db, teamId, seedId);
}

export async function askSeedClarification(
  db: Driver,
  teamId: string,
  seedId: string,
  actor: MemberRow,
  body: string,
  now = Date.now(),
): Promise<Seed> {
  const seed = await requireSeed(db, teamId, seedId);
  if (seed.state !== 'exploring' || seed.explorer !== actor.name)
    throw new MusterdError('forbidden', 'only the active explorer may ask a clarification');
  const tx = () =>
    db.tx(async (t) => {
      await applyThread(t, teamId, seed, actor, 'clarification', body, now);
      await t.run(
        `UPDATE seeds SET state = 'needs_clarification', explorer_id = NULL, updated_at = ?
       WHERE team_id = ? AND id = ?`,
        [now, teamId, seedId],
      );
    });
  await tx();
  return await requireSeed(db, teamId, seedId);
}

export async function answerSeedClarification(
  db: Driver,
  teamId: string,
  seedId: string,
  actor: MemberRow,
  body: string,
  now = Date.now(),
): Promise<Seed> {
  const seed = await requireSeed(db, teamId, seedId);
  if (seed.submitted_by !== actor.name)
    throw new MusterdError('forbidden', 'only the submitting Member may answer a clarification');
  if (seed.state !== 'needs_clarification')
    throw new MusterdError('conflict', `Seed "${seedId}" is not awaiting clarification`);
  const tx = () =>
    db.tx(async (t) => {
      await applyThread(t, teamId, seed, actor, 'answer', body, now);
      await t.run(
        `UPDATE seeds SET state = 'clarified', updated_at = ? WHERE team_id = ? AND id = ?`,
        [now, teamId, seedId],
      );
    });
  await tx();
  return await requireSeed(db, teamId, seedId);
}

async function promote(
  db: Driver,
  teamId: string,
  teamSlug: string,
  seed: Seed,
  actor: MemberRow,
  title: string,
  detail: string,
  kind: 'automatic' | 'manual',
  researchSkipped: boolean,
  now: number,
): Promise<Seed> {
  const tx = () =>
    db.tx(async (t) => {
      const current = await requireSeed(t, teamId, seed.id);
      if (current.state === 'promoted') return current;
      const lane = await openLane(
        t,
        teamId,
        teamSlug,
        actor.name,
        {
          title,
          detail,
          // ADR 629: the asker is the seed's submitter, not whoever promoted it.
          requested: { basis: 'seed', ref: seed.id, by: seed.submitted_by },
        },
        now,
      );
      await t.run(
        `UPDATE seeds
       SET state = 'promoted', explorer_id = NULL, linked_lane_id = ?, promotion_kind = ?,
           research_skipped = ?, promoted_at = ?, updated_at = ?
       WHERE team_id = ? AND id = ?`,
        [lane.id, kind, researchSkipped ? 1 : 0, now, now, teamId, seed.id],
      );
      return await requireSeed(t, teamId, seed.id);
    });
  return tx();
}

export async function submitSeedBrief(
  db: Driver,
  teamId: string,
  teamSlug: string,
  seedId: string,
  actor: MemberRow,
  input: SubmitSeedBrief,
  now = Date.now(),
): Promise<Seed> {
  const seed = await requireSeed(db, teamId, seedId);
  if (seed.state === 'promoted' && input.result === 'promote') return seed;
  if (seed.state !== 'exploring' || seed.explorer !== actor.name)
    throw new MusterdError('forbidden', 'only the active explorer may submit a final brief');
  if (input.result === 'promote') {
    const tx = () =>
      db.tx(async (t) => {
        await applyThread(t, teamId, seed, actor, 'brief', JSON.stringify(input.brief), now);
        await t.run(
          'UPDATE seeds SET final_brief = ?, updated_at = ? WHERE team_id = ? AND id = ?',
          [JSON.stringify(input.brief), now, teamId, seedId],
        );
        return await promote(
          t,
          teamId,
          teamSlug,
          seed,
          actor,
          input.brief.proposed_lane.title,
          input.brief.proposed_lane.detail,
          'automatic',
          false,
          now,
        );
      });
    return tx();
  }
  const tx = () =>
    db.tx(async (t) => {
      await applyThread(t, teamId, seed, actor, 'brief', JSON.stringify(input.brief), now);
      await applyThread(t, teamId, seed, actor, 'conclusion', input.conclusion, now);
      await t.run(
        `UPDATE seeds
       SET state = 'completed', explorer_id = NULL, final_brief = ?, conclusion = ?,
           completed_at = ?, updated_at = ?
       WHERE team_id = ? AND id = ?`,
        [JSON.stringify(input.brief), input.conclusion, now, now, teamId, seedId],
      );
    });
  await tx();
  return await requireSeed(db, teamId, seedId);
}

function rawSeedTitle(body: string): string {
  const first = body
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  return (first || 'Seed').slice(0, 80);
}

export async function promoteSeed(
  db: Driver,
  teamId: string,
  teamSlug: string,
  seedId: string,
  actor: MemberRow,
  input: PromoteSeed,
  now = Date.now(),
): Promise<Seed> {
  const seed = await requireSeed(db, teamId, seedId);
  if (seed.state === 'promoted') return seed;
  const title = input.title ?? seed.final_brief?.proposed_lane.title ?? rawSeedTitle(seed.body);
  const detail = input.detail ?? seed.final_brief?.proposed_lane.detail ?? seed.body;
  return await promote(
    db,
    teamId,
    teamSlug,
    seed,
    actor,
    title,
    detail,
    'manual',
    seed.final_brief === null,
    now,
  );
}

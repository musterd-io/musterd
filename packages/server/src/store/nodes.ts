import { TOKEN_PREFIXES, type NodeSummary } from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { hashToken, newSecret } from './members.js';

/**
 * The machine-credential store (ADR 328), increment 3a of the ADR 325 federation build.
 *
 * Every guarded write here takes the `requests.ts` shape — a `WHERE`-conditioned write whose
 * `changes === 0` is a refusal *returned as a value*, never thrown. That is a choice between two
 * shapes the codebase already has, not the only one: `lanes.ts` reads-compares-throws because a
 * lane conflict has to tell a human what moved under them, while a losing enrollment race is an
 * ordinary outcome the caller turns into a 409.
 *
 * ADR 328 §Consequences asked the build to extract a shared guarded-write helper, on the premise
 * that this made "a third and fourth instance". Checked at `5c1b35f0`: there were two instances in
 * two shapes, and they disagree on how a conflict is reported — a helper spanning them would force
 * one call site to adopt the other's failure model. Extraction declined and recorded in the design
 * doc rather than silently skipped. If 3b or 3c adds a third site that genuinely matches THIS
 * shape, extract then, across three that agree.
 */

/** ADR 328 §2: trust-on-first-use, bounded by a short window. */
export const NODE_INVITE_TTL_MS = 15 * 60 * 1000;

/**
 * Mint a single-use enrollment code. The plaintext is returned once and never persisted — only its
 * sha256, the same handling the four token kinds before it get (SPEC A.2).
 */
export async function mintInvite(
  db: Driver,
  teamId: string,
  label: string,
  createdBy: string,
  now: number = Date.now(),
): Promise<{ invite: string; expires_at: number }> {
  const invite = newSecret(TOKEN_PREFIXES.node_invite);
  const expires_at = now + NODE_INVITE_TTL_MS;
  await db.run(
    `INSERT INTO node_invites (id, team_id, code_hash, label, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ulid(), teamId, hashToken(invite), label, createdBy, now, expires_at],
  );
  return { invite, expires_at };
}

/**
 * Consume an invite — the guarded CAS. `null` is a refusal, and deliberately does not say which of
 * the four reasons applies (unknown code, wrong team, already consumed, expired): the caller turns
 * all four into one 409, because telling an unauthenticated caller *which* guess was close is how a
 * code becomes searchable.
 *
 * `WHERE consumed_at IS NULL` is what makes it single-use. Two daemons racing one invite must not
 * both enroll (ADR 328 §2) — SQLite's single writer serialises them, and the loser's UPDATE matches
 * no row.
 */
export async function consumeInvite(
  db: Driver,
  teamId: string,
  code: string,
  nodeId: string,
  now: number = Date.now(),
): Promise<{ id: string } | null> {
  return (
    (await db.get<{ id: string }>(
      `UPDATE node_invites SET consumed_at = ?, consumed_by = ?
          WHERE team_id = ? AND code_hash = ? AND consumed_at IS NULL AND expires_at > ?
        RETURNING id`,
      [now, nodeId, teamId, hashToken(code), now],
    )) ?? null
  );
}

/**
 * Bind a credential to a node id the joiner presented (ADR 331 §Decision 1). `null` is a refusal.
 *
 * On the hub the presented id names a row that does not exist yet — the hub has its own row for
 * this team, under a different id — so adoption is an INSERT, not the UPDATE the word "adopt"
 * suggests. (Worth stating plainly: ADR 331's Experiment predicted "write two fields onto an
 * existing row", and on the hub side that prediction is wrong. Recorded rather than smoothed over,
 * because 331 named this increment as where the evidence arrives.)
 *
 * **Any id the hub already knows is refused, whatever state it is in.** A legitimate joiner's id is
 * fresh to the hub *by construction*: it is the ULID migration v47 minted on the joiner's own
 * machine, which the hub has never seen. So a conflict on `nodes.id` is never a case to reconcile —
 * it is always one of three attacks or mistakes, and all three want the same answer:
 *
 *  1. **An already-enrolled node.** Re-binding a live credential by enrollment would let a spent
 *     machine be impersonated by whoever holds the next invite. Replacing a credential is
 *     `rotateNode`, under admin authority, never a path an invite can reach. (This is the refusal
 *     ADR 331 §Consequences left owed.)
 *  2. **The hub's own row for this team.** A hub never enrolls with itself, so its `local_node` row
 *     is unbound *permanently*. Binding it would let the joiner stamp events **as the hub**.
 *  3. **The hub's own row for a DIFFERENT team it hosts** — miley's review finding, 2026-08-27
 *     (`01M12KQHT8`). This is the one an earlier draft got wrong: the guard was
 *     `credential_hash IS NULL` plus an exclusion scoped to the *enrolling* team, and every part of
 *     it passes when a joiner enrolling into A presents the id of the hub's local row for B. The
 *     `DO UPDATE` then wrote a foreign credential onto B's origin identity, left `team_id` as B, and
 *     reported success — after which the joiner authenticates as team B's node.
 *
 * `DO NOTHING` answers all three with one clause and no subselect. The earlier shape needed a
 * `local_node` lookup that was correct only for the team being enrolled, which is precisely the
 * scoping that let (3) through; a guard that has to enumerate what it excludes will keep missing
 * cases, while "the hub has never seen this id" is the property actually required.
 *
 * `local_node` remains load-bearing for `insertMessage` (v48) — it is simply no longer part of this
 * guard.
 */
export async function bindNode(
  db: Driver,
  teamId: string,
  nodeId: string,
  label: string,
  credential: string,
  enrolledBy: string,
  now: number = Date.now(),
): Promise<{ id: string } | null> {
  const res = await db.run(
    `INSERT INTO nodes (id, team_id, label, next_seq, credential_hash, enrolled_at, enrolled_by)
       VALUES (?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    [nodeId, teamId, label, hashToken(credential), now, enrolledBy],
  );
  return res.changes === 0 ? null : { id: nodeId };
}

/**
 * Rotate: mint a fresh `msnode_` against the SAME node row (ADR 328 §5). The id — and therefore
 * every `origin_node` already stamped in the log — is stable across credential changes, which is
 * why §5 made the id a ULID on the row and explicitly never derived it from the credential.
 *
 * This is the one path allowed to overwrite a non-NULL hash, which is exactly why it is separate
 * from `bindNode` and gated on admin authority at the route rather than on an invite. Refuses a
 * revoked node: re-arming a retired credential is an enrollment decision, not a rotation.
 */
export async function rotateNode(
  db: Driver,
  teamId: string,
  nodeId: string,
  now: number = Date.now(),
): Promise<{ credential: string } | null> {
  const credential = newSecret(TOKEN_PREFIXES.node);
  const res = await db.run(
    `UPDATE nodes SET credential_hash = ?, enrolled_at = ?
        WHERE id = ? AND team_id = ? AND revoked_at IS NULL`,
    [hashToken(credential), now, nodeId, teamId],
  );
  return res.changes === 0 ? null : { credential };
}

/**
 * Revoke: the hub refuses push, pull, and claim from this node immediately (ADR 328 §5).
 *
 * What revocation deliberately does NOT do: events already ingested stay, because the log is
 * append-only and those events are attested history — revoking a credential is not retro-repudiating
 * what was said under it. Lanes held by that node's seats are not auto-released either; a cascade
 * would close work on a judgement-free timer, and releasing them stays an ordinary human act.
 *
 * `false` means already revoked or unknown — idempotent without claiming to have acted.
 */
export async function revokeNode(
  db: Driver,
  teamId: string,
  nodeId: string,
  now: number = Date.now(),
): Promise<boolean> {
  return (
    (
      await db.run(
        'UPDATE nodes SET revoked_at = ? WHERE id = ? AND team_id = ? AND revoked_at IS NULL',
        [now, nodeId, teamId],
      )
    ).changes > 0
  );
}

/**
 * Authenticate a presented `msnode_`. Null unless the credential is bound, unrevoked, and belongs
 * to *this* team — a node speaks for the team it was admitted to and no other (ADR 325's one team,
 * one authority).
 *
 * Note what this does not grant: ADR 328 §3 admits an `msnode_` to the sync surface only. It is not
 * a seat credential and cannot claim a seat, read as a member, or raise an act — that separation is
 * enforced at the routes, since a machine being admitted and a seat being authorized are
 * independent axes.
 */
export async function authenticateNode(
  db: Driver,
  teamId: string,
  token: string,
): Promise<{ id: string; label: string } | null> {
  if (!token) return null;
  return (
    (await db.get<{ id: string; label: string }>(
      `SELECT id, label FROM nodes
          WHERE team_id = ? AND credential_hash = ? AND revoked_at IS NULL`,
      [teamId, hashToken(token)],
    )) ?? null
  );
}

/**
 * The seat→node residence binding, minted (ADR 328 §4): "seat X binds to node N the first time N
 * speaks for X", first-writer-wins. `{ bound: true }` when this node holds the seat — freshly, or
 * already; `{ bound: false, node_id, label }` names a node that does, so the refusal means
 * something a caller can act on ("this seat is bound to laptop-a", not "no residency row").
 *
 * Since ADR 358 a seat's binding is a SET of nodes, keyed `(member_id, node_id)`. The first-writer
 * CAS is the guarded insert: `INSERT … WHERE NOT EXISTS (any row for this seat)`, so two nodes
 * racing one unbound seat serialise on SQLite's single writer and exactly one inserts. A seat that
 * already has rows accepts only a node in its set; the way a second node JOINS the set is
 * `trustNodeForSeat` — an explicit act from a node already in it — never by speaking first.
 * `unbindSeat` under admin authority clears the whole set and is the release valve.
 *
 * Applies to every seat kind. Human seats fan out across surfaces (ADR 042) and, after ADR 358,
 * across the machines they have trusted; agents stay one-node, which `trustNodeForSeat` enforces.
 */
export async function bindSeatToNode(
  db: Driver,
  teamId: string,
  memberId: string,
  nodeId: string,
  now: number = Date.now(),
): Promise<{ bound: true } | { bound: false; node_id: string; label: string }> {
  await db.run(
    `INSERT INTO seat_nodes (member_id, team_id, node_id, bound_at)
     SELECT ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM seat_nodes WHERE member_id = ?)`,
    [memberId, teamId, nodeId, now, memberId],
  );
  const holders = await seatBindings(db, memberId);
  if (holders.some((h) => h.node_id === nodeId)) return { bound: true };
  const first = holders[0]!;
  return { bound: false, node_id: first.node_id, label: first.label };
}

/** Where the hub believes this seat lives — the first-bound node — or undefined when unbound. */
export async function seatBinding(
  db: Driver,
  memberId: string,
): Promise<{ node_id: string; label: string; bound_at: number } | undefined> {
  return (await seatBindings(db, memberId))[0];
}

/** Every node the seat is bound to, earliest first; empty when no node has spoken for it yet. */
export async function seatBindings(
  db: Driver,
  memberId: string,
): Promise<{ node_id: string; label: string; bound_at: number }[]> {
  return await db.all<{ node_id: string; label: string; bound_at: number }>(
    `SELECT s.node_id, n.label, s.bound_at FROM seat_nodes s JOIN nodes n ON n.id = s.node_id
        WHERE s.member_id = ? ORDER BY s.bound_at, s.node_id`,
    [memberId],
  );
}

/**
 * The explicit trust act (ADR 358): a node already in a human seat's set adds another. The speaker
 * must be in the set — that is the whole rule; a fresh machine cannot self-trust, and an admitted
 * credential cannot widen a seat it does not hold. Idempotent when the target is already trusted.
 *
 *  - `not_resident`: the speaking node is not in the seat's set (or the set is empty — a seat
 *    nobody has spoken for yet has no session that could vouch).
 *  - `not_human`: agents stay one-node (ADR 042's kind scope, carried to machines).
 *  - `unknown_node`: the target is not an unrevoked node of this team.
 */
export async function trustNodeForSeat(
  db: Driver,
  teamId: string,
  seat: { id: string; kind: string },
  speakingNodeId: string,
  targetNodeId: string,
  now: number = Date.now(),
): Promise<
  | { trusted: true; already: boolean }
  | { trusted: false; reason: 'not_resident' | 'not_human' | 'unknown_node' }
> {
  if (seat.kind !== 'human') return { trusted: false, reason: 'not_human' };
  const holders = await seatBindings(db, seat.id);
  if (!holders.some((h) => h.node_id === speakingNodeId)) {
    return { trusted: false, reason: 'not_resident' };
  }
  const target = await db.get<{ id: string }>(
    'SELECT id FROM nodes WHERE id = ? AND team_id = ? AND revoked_at IS NULL',
    [targetNodeId, teamId],
  );
  if (!target) return { trusted: false, reason: 'unknown_node' };
  if (holders.some((h) => h.node_id === targetNodeId)) return { trusted: true, already: true };
  await db.run(
    `INSERT INTO seat_nodes (member_id, team_id, node_id, bound_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(member_id, node_id) DO NOTHING`,
    [seat.id, teamId, targetNodeId, now],
  );
  return { trusted: true, already: false };
}

/** Every binding of the team by member NAME, for the pull page (ADR 509). Earliest first. */
export async function listSeatBindings(
  db: Driver,
  teamId: string,
): Promise<{ member: string; node_id: string; bound_at: number }[]> {
  return await db.all<{ member: string; node_id: string; bound_at: number }>(
    `SELECT m.name AS member, s.node_id, s.bound_at
       FROM seat_nodes s JOIN members m ON m.id = s.member_id
      WHERE s.team_id = ? ORDER BY s.bound_at, s.node_id`,
    [teamId],
  );
}

/**
 * ADR 509: a joiner takes the hub's bindings as its own. Replace, not merge — the hub arbitrates
 * every bind (`assertSeatResident` runs there for a forwarded claim), so what it holds IS the
 * truth. A name this roster does not hold yet (git lag) is skipped, not stopped: a binding
 * decides no act, only what a picker row says. A node id this daemon has not seen is skipped
 * for the same reason — the page's `nodes` summary lands first and normally has it.
 */
export async function replaceSeatBindings(
  db: Driver,
  teamId: string,
  rows: readonly { member: string; node_id: string; bound_at: number }[],
): Promise<{ applied: number; skipped: number }> {
  await db.run('DELETE FROM seat_nodes WHERE team_id = ?', [teamId]);
  let applied = 0;
  let skipped = 0;
  for (const r of rows) {
    const member = await db.get<{ id: string }>(
      'SELECT id FROM members WHERE team_id = ? AND name = ? AND left_at IS NULL',
      [teamId, r.member],
    );
    const node = await db.get<{ id: string }>('SELECT id FROM nodes WHERE id = ? AND team_id = ?', [
      r.node_id,
      teamId,
    ]);
    if (!member || !node) {
      skipped++;
      continue;
    }
    await db.run(
      `INSERT INTO seat_nodes (member_id, team_id, node_id, bound_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(member_id, node_id) DO NOTHING`,
      [member.id, teamId, r.node_id, r.bound_at],
    );
    applied++;
  }
  return { applied, skipped };
}

/** The explicit re-bind act (ADR 328 §4): drop every binding so the next node to speak may take it. */
export async function unbindSeat(
  db: Driver,
  memberId: string,
): Promise<{ node_id: string } | null> {
  const rows = await db.all<{ node_id: string }>(
    'DELETE FROM seat_nodes WHERE member_id = ? RETURNING node_id',
    [memberId],
  );
  return rows[0] ?? null;
}

/** The hub's stamp on every authenticated sync contact (push, pull, claim): the node is alive now. */
export async function touchNode(db: Driver, nodeId: string, now: number): Promise<void> {
  await db.run('UPDATE nodes SET last_seen_at = ? WHERE id = ?', [now, nodeId]);
}

/**
 * A node this daemon learned of from the hub's pull summary (presence replication, 2026-09-02).
 * Writes identity and liveness ONLY: `next_seq` is an allocator this daemon must never mint from
 * for a foreign node, and the credential columns are the hub's business (ADR 328).
 */
export async function upsertForeignNode(
  db: Driver,
  teamId: string,
  node: { id: string; label: string; last_seen_at: number | null },
): Promise<void> {
  await db.run(
    `INSERT INTO nodes (id, team_id, label, next_seq, last_seen_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, last_seen_at = excluded.last_seen_at`,
    [node.id, teamId, node.label, node.last_seen_at],
  );
}

/** Every node of the team with its liveness stamp — the pull response's `nodes`. */
export async function listNodeLiveness(
  db: Driver,
  teamId: string,
): Promise<{ id: string; label: string; last_seen_at: number | null }[]> {
  return await db.all<{ id: string; label: string; last_seen_at: number | null }>(
    'SELECT id, label, last_seen_at FROM nodes WHERE team_id = ? ORDER BY id',
    [teamId],
  );
}

/**
 * Admin listing. The hash never leaves the store — `credential_prefix` is the token *kind*, not a
 * leading slice of the secret, so it says "enrolled" without handing over anything to start from.
 * Unenrolled rows (this daemon's own, and any minted-but-never-joined) list with nulls: "enrolled"
 * is a state to check, not one the row's existence guarantees (ADR 331 §Consequences).
 */
export async function listNodes(db: Driver, teamId: string): Promise<NodeSummary[]> {
  return (
    await db.all<{
      id: string;
      label: string;
      enrolled_at: number | null;
      revoked_at: number | null;
      last_seen_at: number | null;
      credential_hash: string | null;
    }>(
      `SELECT id, label, enrolled_at, revoked_at, last_seen_at, credential_hash
         FROM nodes WHERE team_id = ? ORDER BY enrolled_at IS NULL, enrolled_at DESC, id`,
      [teamId],
    )
  ).map((r) => ({
    id: r.id,
    label: r.label,
    enrolled_at: r.enrolled_at,
    revoked_at: r.revoked_at,
    last_seen_at: r.last_seen_at,
    credential_prefix: r.credential_hash ? TOKEN_PREFIXES.node : null,
  }));
}

import {
  closeReasonCopy,
  incidentBannerLines,
  shortDuration,
  type Lane,
  type NextBrief,
  type ReviewPromiseReference,
} from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { theme } from '../render/theme.js';
import { resolve } from './helpers.js';

/**
 * `musterd next` — the orientation brief (ADR 049/084). A fresh session self-orients without a
 * human-authored copy-paste prompt: what you're carrying, what just shipped, what to pick up, and the
 * latest handoff *why*. The projection is computed server-side (`GET /next`); this only renders it.
 */

function laneLine(l: Lane): string {
  const goal = l.goal_id ? theme.meta(` ◆ ${l.goal_id}`) : '';
  const branch = l.branch ? theme.meta(` ⎇ ${l.branch}`) : '';
  return `  ${theme.meta(l.id)} ${l.state} "${l.title}"${goal}${branch}`;
}

/** ADR 490: the artifact a review promise names, one short token — never a credential. */
function reviewRef(r: ReviewPromiseReference): string {
  switch (r.kind) {
    case 'pr':
      return `PR ${r.repo}#${r.number}`;
    case 'commit':
      return `${r.repo}@${r.sha.slice(0, 7)}${r.path ? ` ${r.path}` : ''}`;
    case 'lane':
      return `lane ${r.id}`;
    case 'url':
      return r.url;
  }
}

/**
 * Coarse elapsed time — the reader needs "hours, not minutes", never a precise duration. `now` is
 * injectable so the `cmd/next` frame can be pinned character-for-character.
 */
export function renderNext(brief: NextBrief, now = Date.now()): void {
  const w = process.stdout.write.bind(process.stdout);
  w(`${theme.accent('next')} — as ${theme.memberName(brief.member, 'agent')}\n`);

  // Incident banner FIRST, above everything including owed reviews (spec 2026-08-14 §4). Most of
  // the measured waste in the motivating episode was seats STARTING SESSIONS into a shared red they
  // assumed was theirs — so this is the one line that has to land before a seat reads anything else
  // and decides what it is working on.
  //
  // This surface had it missing entirely through increments 1 and 2: the banner was written into the
  // MCP renderer and never here, so every CLI seat got none of it. Words now come from the protocol
  // package so a third surface cannot repeat that. `?? []` for the same daemon-skew reason as
  // owed_reviews below — the brief arrives cast, not parsed.
  for (const inc of brief.incidents ?? []) {
    for (const line of incidentBannerLines(inc)) w(`${theme.warn(line)}\n`);
  }

  // FIRST, above your own work, on purpose (ADR 233). This is the one item in the brief that
  // someone else is blocked on, and the one that loses when a seat is busy: half the unverified
  // closes had the named reviewer online for ~40 minutes and still never answering. Printing it
  // under `carrying` would reproduce the failure it exists to fix.
  // `?? []` is not defensive noise: the brief arrives cast, not parsed through NextBriefSchema, so
  // a daemon predating ADR 233 omits the key and this would throw on `.length`. Additive means the
  // OLD daemon can omit it, which makes tolerating that the new client's job.
  const owed = brief.owed_reviews ?? [];
  if (owed.length > 0) {
    w(`\n${theme.accent('owed by you')} — ${owed.length} lane(s) waiting on your verdict:\n`);
    for (const r of owed) {
      w(
        `  ${theme.meta(r.lane.id)} "${r.lane.title}" — ${theme.memberName(r.from, 'agent')} has waited ${shortDuration(now - r.ts)}\n`,
      );
      w(theme.meta(`    answer: \`musterd send --act accept --reply-to ${r.ask_id} "…"\``) + '\n');
    }
  }
  // ADR 490: review promises — accepted typed review requests, derived by the daemon from the Act
  // ledger. Three sections, kept apart from `owed by you` on purpose: a promise on a standalone
  // request is not a Lane verdict, and folding them would make "owed" mean two things. Each array is
  // optional with no default, and the two states are different claims: absent means the daemon
  // predates the projection and the brief says so; `[]` means supported and nothing to show.
  const promised = brief.request_reviews;
  const asked = brief.requested_reviews;
  const closed = brief.review_closures;
  if (promised === undefined)
    w(theme.meta('\nreview promises: not reported by this daemon — it predates ADR 490') + '\n');
  else if (promised.length > 0) {
    w(`\n${theme.accent('review promises')} — ${promised.length} you accepted, still open:\n`);
    for (const p of promised) {
      w(
        `  ${theme.meta(p.request_id)} for ${theme.memberName(p.requester, 'agent')} · accepted ${shortDuration(now - p.accepted_at)} ago\n`,
      );
      w(`    "${p.context}" · ${reviewRef(p.review)}\n`);
      w(
        theme.meta(`    close: \`musterd send --act resolve --thread ${p.request_id} "…"\``) + '\n',
      );
    }
  }
  if (asked !== undefined && asked.length > 0) {
    w(`\n${theme.accent('reviews you asked for')} — ${asked.length} accepted, still open:\n`);
    for (const p of asked) {
      w(
        `  ${theme.meta(p.request_id)} ${theme.memberName(p.owner, 'agent')} accepted ${shortDuration(now - p.accepted_at)} ago\n`,
      );
      w(`    "${p.context}" · ${reviewRef(p.review)}\n`);
    }
  }
  if (closed !== undefined && closed.length > 0) {
    w(`\n${theme.accent('review closed for you')} — by someone else, ${closed.length}:\n`);
    for (const c of closed) {
      w(
        `  ${theme.meta(c.request_id)} closed by ${theme.memberName(c.closer, 'agent')} ${shortDuration(now - c.resolved_at)} ago\n`,
      );
      w(theme.meta(`    resolve ${c.resolve_id} — read your inbox and it is gone`) + '\n');
    }
  }
  // ADR 487 §5.4: a goal whose live lanes have all stopped moving. `?? []` for an older daemon.
  for (const g of brief.stale_goals ?? [])
    w(
      theme.warn(`⚠ goal ${g.goal} has not moved in ${shortDuration(g.idle_ms)}`) +
        theme.meta(` — oldest untouched: ${g.lane} "${g.lane_title}"`) +
        '\n',
    );
  if (brief.in_flight.length > 0) {
    w(`\n${theme.accent('carrying')} (${brief.in_flight.length}):\n`);
    for (const l of brief.in_flight) w(laneLine(l) + '\n');
  }
  // ADR 373 increment 4: recorded intentions ABOVE the open lanes — a Seed is the same question one
  // step earlier, and the whole point of ADR 373 is that these were legible to a reader and to no
  // surface. The `ref` is what makes one actionable: it names the document that asked.
  const seeds = brief.up_next_seeds ?? [];
  if (seeds.length > 0) {
    const total = brief.up_next_seeds_total ?? seeds.length;
    const more = total > seeds.length ? theme.meta(` (${seeds.length} of ${total})`) : '';
    w(`\n${theme.accent('up next')} — recorded intentions nobody has started${more}:\n`);
    for (const s of seeds) {
      w(`  ${theme.meta(s.id)} ${s.summary}\n`);
      w(
        theme.meta(
          `    ${s.ref ?? `from ${s.submitted_by}`} · take it: \`musterd seed claim ${s.id}\``,
        ) + '\n',
      );
    }
  }
  if (brief.up_next.length > 0) {
    w(`\n${theme.accent('up next')} — open lanes you could pick up:\n`);
    for (const l of brief.up_next) w(laneLine(l) + '\n');
  }
  if ((brief.parked_total ?? 0) > 0)
    w(theme.meta(`\nparked: ${brief.parked_total} — kept, not offered (\`musterd lanes\`)`) + '\n');
  if (brief.shipped.length > 0) {
    w(`\n${theme.meta('recently shipped:')}\n`);
    for (const l of brief.shipped)
      w(
        `  ${theme.ok('✓')} "${l.title}"${l.goal_id ? theme.meta(` ◆ ${l.goal_id}`) : ''}` +
          // ADR 192's copy, matching the web board's chip (ADR 169). Only on an explicit `false`:
          // an absent verdict is unknown, not unconfirmed.
          (l.verified === false ? theme.meta(' — unconfirmed') : '') +
          // ADR 283: and WHY — "chase a person" and "look at the roster" are different next moves.
          (l.close_reason !== undefined && closeReasonCopy(l.close_reason) !== null
            ? theme.meta(` (${closeReasonCopy(l.close_reason)!})`)
            : '') +
          '\n',
      );
  }
  if (brief.next_goal) {
    const g = brief.next_goal;
    const wave = g.wave !== null ? theme.meta(` wave:${g.wave}`) : '';
    w(`\n${theme.accent('next goal')} — ${theme.meta(g.id)} "${g.title}"${wave}\n`);
    w(theme.meta(`  claim a lane on it: \`musterd lane open "…" --goal ${g.id} --claim\``) + '\n');
  }
  if (brief.why) {
    const when = new Date(brief.why.ts).toISOString().slice(0, 10);
    const goal = brief.why.goal_id ? theme.meta(` ◆ ${brief.why.goal_id}`) : '';
    w(
      `\n${theme.accent('why')} — handoff from ${theme.memberName(brief.why.from, 'agent')}${goal} ${theme.meta(`(${when})`)}\n`,
    );
    w(`  ${brief.why.body}\n`);
  }

  if (
    owed.length === 0 &&
    (promised?.length ?? 0) === 0 &&
    (asked?.length ?? 0) === 0 &&
    (closed?.length ?? 0) === 0 &&
    brief.in_flight.length === 0 &&
    brief.up_next.length === 0 &&
    seeds.length === 0 &&
    brief.shipped.length === 0 &&
    !brief.next_goal &&
    !brief.why
  ) {
    w(
      theme.meta('nothing in flight — `musterd lane open "<title>" --claim` to declare your work') +
        '\n',
    );
  }
}

export async function nextCommand(parsed: Parsed): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const brief = await http.next(team);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(brief) + '\n');
    return 0;
  }
  renderNext(brief);
  return 0;
}

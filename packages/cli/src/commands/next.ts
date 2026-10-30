import {
  claimCheckLines,
  closeReasonCopy,
  describeHoldLine,
  emptyPoolCopy,
  fmtOwnDisputes,
  incidentBannerLines,
  shortDuration,
  type Lane,
  type NextBrief,
  type ReviewPromiseReference,
} from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { GLOBAL_FLAGS, rejectUnknownFlags } from '../args.js';
import { cut } from '../render/rows.js';
import { theme } from '../render/theme.js';
import { termWidth, visibleLen } from '../render/ui.js';
import { resolve } from './helpers.js';

/** The 10-character lane prefix every lane command takes, as the daily view prints it. */
const shortId = (id: string) => id.slice(0, 10);

/**
 * `musterd next` — the orientation brief (ADR 049/084). A fresh session self-orients without a
 * human-authored copy-paste prompt: what you're carrying, what just shipped, what to pick up, and the
 * latest handoff *why*. The projection is computed server-side (`GET /next`); this only renders it.
 */

/**
 * ADR 536 §4.5 — the `up next` count's words: the same as `team_next`'s render (each surface
 * keeps its own copy, as every brief section does — ADR 084 shares the derivation, not the
 * string). Empty when the daemon reports no total, so nothing is zero-filled.
 */
export function upNextCountCopy(brief: {
  up_next: readonly unknown[];
  up_next_total?: number;
  up_next_blocked_total?: number;
}): string {
  const total = brief.up_next_total ?? 0;
  const blocked = brief.up_next_blocked_total ?? 0;
  if (total === 0 && blocked === 0) return '';
  const shown = brief.up_next.length;
  const window = shown < total ? `${shown} of ${total} claimable` : `all ${total} claimable`;
  const wait = blocked > 0 ? ` · ${blocked} more wait on a dependency` : '';
  return `${window}${wait}`;
}

function laneLine(l: Lane, dimTail = ''): string {
  // The daily view's row grammar (lane 01M653W2N4): state first, the title cut at the column
  // edge, the short id after it. The title wins the line: the goal, areas, branch and any
  // why-tag ride the dim second line and are cut there instead — the first landing cut the
  // title to a stub to make room for the tail and the line still ran past the edge
  // (acceptance measured `blocked · First-r… — … ⎇ copy/tour-cold-read` at 104 cells, and
  // the open-lane rows repeated the fault at 92 through their why-tags).
  const width = termWidth();
  const head = `  ${l.state} · `;
  const idPart = ` — ${shortId(l.id)}`;
  const title = cut(l.title, Math.max(8, width - visibleLen(head + idPart)));
  let out = `  ${l.state} ${theme.meta('·')} ${title}` + theme.meta(idPart);
  const hint = [
    l.goal_id ? `◆ ${l.goal_id}` : '',
    l.areas?.length ? l.areas.join(', ') : '',
    l.branch ? `⎇ ${l.branch}` : '',
    dimTail,
  ]
    .filter(Boolean)
    .join(' · ');
  if (hint) out += '\n' + theme.meta(`    ${cut(hint, Math.max(8, width - 4))}`);
  return out;
}

/**
 * ADR 536 increment 2 — why an offered lane is where it is, as a trailing tag: ` · role: platform ·
 * near what you shipped`. The server composes the strings (fixed, never a lane body); this joins
 * them. Nothing for tier 5, and nothing on an epoch-30 daemon (no `up_next_why`).
 */
function whyTag(brief: NextBrief, laneId: string): string {
  const reasons = (brief.up_next_why ?? []).find((w) => w.lane === laneId)?.reasons ?? [];
  return reasons.join(' · ');
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
  // ADR 516: the Team's active holds, right under the incident banner — a rule the whole Team is
  // under, with its author and end, read here instead of carried in anyone's memory. `?? []`: an
  // older daemon omits the key.
  for (const h of brief.holds ?? []) w(`${theme.warn(`⏸ ${describeHoldLine(h, now)}`)}\n`);

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
      // The suffix is inside the cut (lane 01M653W2N4, third landing): budget the title
      // against the whole line, so `— <owner> has waited …` cannot push it past the edge
      // (acceptance measured 101 cells).
      const head = `  ${shortId(r.lane.id)} "`;
      const suffix = `" — ${r.from} has waited ${shortDuration(now - r.ts)}`;
      w(
        `  ${theme.meta(shortId(r.lane.id))} "${cut(r.lane.title, Math.max(8, termWidth() - visibleLen(head + suffix)))}" — ${theme.memberName(r.from, 'agent')} has waited ${shortDuration(now - r.ts)}\n`,
      );
      w(theme.meta(`    answer: \`musterd send --act accept --reply-to ${r.ask_id} "…"\``) + '\n');
    }
  }
  // ADR 505 §3: rejections on MY lanes I have not answered — the mirror of `owed by you`, same
  // copy and order as the MCP renderer. `?? []` for an older daemon.
  const disputed = brief.owed_disputes ?? [];
  if (disputed.length > 0) {
    w(
      `\n${theme.accent('disputed')} — ${disputed.length} rejection(s) on your lanes waiting on your answer:\n`,
    );
    for (const d of disputed) {
      const head = `  ${shortId(d.lane.id)} "`;
      const note = cut(d.note, 30);
      const suffix = `" — ${d.from} rejected ${shortDuration(now - d.ts)} ago: ${note}`;
      w(
        `  ${theme.meta(shortId(d.lane.id))} "${cut(d.lane.title, Math.max(8, termWidth() - visibleLen(head + suffix)))}" — ${theme.memberName(d.from, 'agent')} rejected ${shortDuration(now - d.ts)} ago: ${note}\n`,
      );
      w(
        theme.meta(
          `    answer (ADR 505): re-run the check, then \`musterd send --act accept --reply-to ${d.dispute_id} "<what you re-checked>"\` to concede and fix, or \`--act decline\` with the evidence to hold — a hold goes to a second reviewer.`,
        ) + '\n',
      );
    }
  }
  // ADR 483: the seat's own dispute row — the protocol's one string, same place as the MCP renderer.
  if (brief.own_disputes) w(`\n${theme.meta(fmtOwnDisputes(brief.own_disputes))}\n`);
  // value-layer design / ADR 276: ambient review debt — the oldest lanes waiting on ANY seat's
  // acceptance (`owed by you` above is the directed slice). `team_next` has rendered this since the
  // design landed; the CLI never did (ADR 276 Consequences named the gap, lane 01M3TAM44Q closes
  // it). Same copy as the MCP renderer: owner stays visible, "nobody was asked" is said outright,
  // and an attestation with no SHA is called what it is. `?? []` for an older daemon.
  const debt = brief.review_debt ?? [];
  if (debt.length > 0) {
    const total = brief.review_debt_total ?? 0;
    const more = total > debt.length ? theme.meta(` (showing ${debt.length} of ${total})`) : '';
    w(`\n${theme.accent('review debt')} — waiting on any seat's acceptance${more}:\n`);
    for (const r of debt) {
      // Suffix inside the cut, as owed above (rows measured 81 — one cell of indent).
      const debtSuffix = ` — ${shortId(r.id)}`;
      w(
        `  "${cut(r.title, Math.max(8, termWidth() - 4 - visibleLen(debtSuffix)))}"${theme.meta(debtSuffix)}\n` +
          theme.meta(
            `    ${r.owner ? `${r.owner} · ` : ''}waiting ${Math.floor(r.waited_ms / 3_600_000)}h`,
          ) +
          (r.no_candidate
            ? theme.warn(
                ` — NO REVIEWER WAS ASKED (${r.empty_pool ? emptyPoolCopy(r.empty_pool) : 'no eligible counterpart at submit'})`,
              )
            : '') +
          (r.unlanded
            ? theme.warn(
                ' — NO MERGE ATTESTATION (nothing landed — waiting on its author, not you)',
              )
            : '') +
          // ADR 539: the peer stage is done; the wait is on a human coming live, not on a reviewer.
          (r.pending_human
            ? theme.warn(
                ` — PEER-CONFIRMED${r.peer_confirmed_by ? ` by ${r.peer_confirmed_by}` : ''}, waiting for a human (none was live to ask; asked when one comes live)`,
              )
            : '') +
          '\n',
      );
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
  // Same row grammar as a lane (lane 01M653W2N4): the warning on one line cut at the edge,
  // the oldest lane as `"title…" — <short id>` under it — the full goal and lane ULIDs ran
  // these lines to 151–273 cells (acceptance, 2026-10-30).
  for (const g of brief.stale_goals ?? []) {
    w(theme.warn(cut(`⚠ ${g.goal} · quiet ${shortDuration(g.idle_ms)}`, termWidth())) + '\n');
    const suffix = ` — ${shortId(g.lane)} · oldest untouched`;
    w(
      `  "${cut(g.lane_title, Math.max(8, termWidth() - 4 - visibleLen(suffix)))}"${theme.meta(suffix)}\n`,
    );
  }
  if (brief.in_flight.length > 0) {
    w(`\n${theme.accent('carrying')} (${brief.in_flight.length}):\n`);
    // ADR 664: carried work no wake will reach — the owner hears it here, not only on the board.
    const stalled = new Map((brief.stalled_continuations ?? []).map((x) => [x.subject, x.detail]));
    for (const l of brief.in_flight) {
      w(laneLine(l) + '\n');
      const why = stalled.get(l.id);
      // The detail already opens "no wake due: …" — saying it twice, once shouted, was the
      // seam (lane 01M653W2N4). Cut at the column edge: `lane show` carries the full text,
      // and the uncut detail wrapped to three lines (acceptance measured 180 cells).
      if (why) w(theme.warn(`    ↳ ${cut(why, Math.max(8, termWidth() - 6))}`) + '\n');
    }
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
      // The full id stays (`seed claim` takes it); the summary is cut at the edge like every
      // other title on the page (lane 01M653W2N4).
      w(
        `  ${theme.meta(s.id)} ${cut(s.summary, Math.max(8, termWidth() - visibleLen(s.id) - 3))}\n`,
      );
      w(
        theme.meta(
          `    ${s.ref ?? `from ${s.submitted_by}`} · take it: \`musterd seed claim ${s.id}\``,
        ) + '\n',
      );
    }
  }
  if (brief.up_next.length > 0) {
    // ADR 536: the window says how much it is a window on. Absent on an older daemon (both counts
    // default to 0) → no parenthetical, not a zero-filled one.
    // The count parenthetical can carry the header past the edge (measured 90 cells):
    // it drops to its own dim line instead of being cut — the counts are the point of it.
    const upNextCopy = upNextCountCopy(brief);
    w(`\n${theme.accent('up next')} — open lanes you could pick up:\n`);
    if (upNextCopy) w(theme.meta(`  (${upNextCopy})`) + '\n');
    for (const l of brief.up_next) w(laneLine(l, whyTag(brief, l.id)) + '\n');
  }
  if ((brief.parked_total ?? 0) > 0)
    w(theme.meta(`\nparked: ${brief.parked_total} — kept, not offered (\`musterd lanes\`)`) + '\n');
  if (brief.shipped.length > 0) {
    w(`\n${theme.meta('recently shipped:')}\n`);
    for (const l of brief.shipped) {
      // The title is cut at the edge like every other title on the page (rows measured
      // 113–184 cells uncut); the badges ride after it, inside the same budget.
      const badges =
        (l.goal_id ? ` ◆ ${l.goal_id}` : '') +
        // ADR 192's copy, matching the web board's chip (ADR 169). Only on an explicit `false`:
        // an absent verdict is unknown, not unconfirmed.
        (l.verified === false ? ' — unconfirmed' : '') +
        // ADR 283: and WHY — "chase a person" and "look at the roster" are different next moves.
        (l.close_reason !== undefined && closeReasonCopy(l.close_reason) !== null
          ? ` (${closeReasonCopy(l.close_reason)!})`
          : '');
      w(
        `  ${theme.ok('✓')} "${cut(l.title, Math.max(8, termWidth() - 6 - visibleLen(badges)))}"${theme.meta(badges)}\n`,
      );
    }
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
    // The handoff body and its check lines cut at the edge (measured 266–290 cells);
    // the act itself carries the full text.
    w(`  ${cut(brief.why.body.replace(/\s+/g, ' '), Math.max(8, termWidth() - 2))}\n`);
    // ADR 522: what the handoff says, checked against the Team now.
    for (const line of claimCheckLines(brief.why.checks ?? []))
      w(`  ${theme.warn(cut(line, Math.max(8, termWidth() - 2)))}\n`);
  }

  if (
    owed.length === 0 &&
    debt.length === 0 &&
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

/**
 * The flags `musterd next` takes (lane
 * `01M5D907S74XVT5YECNWB5VW5A`). A flag this command does not know takes the NEXT argument as
 * its value and drops it, so a typo loses an argument — the lane id, the target, the words of a
 * message. A command knows its own flags, so it refuses the ones it does not, before anything
 * is composed. The global flags every command inherits come from `GLOBAL_FLAGS`; this list is
 * the command's own — and the flags the helpers it calls read, because a helper's read is this
 * command's vocabulary too.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads, so a flag added
 * without being declared fails the build instead of working in the field.
 */
/**
 * The flags `musterd next` takes (lane
 * `01M5D907S74XVT5YECNWB5VW5A`). A flag this command does not know takes the NEXT argument as
 * its value and drops it, so a typo loses an argument — the lane id, the target, the words of a
 * message. A command knows its own flags, so it refuses the ones it does not, before anything
 * is composed. The global flags every command inherits come from `GLOBAL_FLAGS`; this list is
 * the command's own — and the flags the helpers it calls read, because a helper's read is this
 * command's vocabulary too.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads, so a flag added
 * without being declared fails the build instead of working in the field.
 */
export const NEXT_FLAGS = ['carrying', 'disputed', 'next', 'why'] as const;

export async function nextCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...NEXT_FLAGS],
    'the flags `musterd next` takes are listed by `musterd help next`',
  );
  const { team, http } = resolve(parsed.flags);
  const brief = await http.next(team);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(brief) + '\n');
    return 0;
  }
  renderNext(brief);
  return 0;
}

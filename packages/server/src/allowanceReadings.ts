import type {
  AllowancePost,
  AllowanceProvider,
  AllowanceView,
  MemberKind,
} from '@musterd/protocol';

/**
 * Account-keyed allowance posts (ADR 723). Memory only: a restart drops them, and nothing here is
 * replicated. The roster view never includes the account key.
 */

interface Reading {
  provider: AllowanceProvider;
  account: string;
  label: string;
  readAt: number;
  windows: AllowanceView['accounts'][number]['windows'];
  holders: Set<string>;
  /** `''` is this daemon. A remote post does not write that. */
  nodes: Set<string>;
}

const byTeam = new Map<string, Map<string, Reading>>();

const PROVIDER_ORDER: readonly AllowanceProvider[] = [
  'claude',
  'openai',
  'cursor',
  'elevenlabs',
  'muse',
];

export interface AllowanceRosterSeat {
  name: string;
  kind: MemberKind;
  /** Online, away, or a human who is steering a live agent. */
  present: boolean;
  presences: readonly {
    status: string;
    model?: string | null;
    driver?: string | null;
    node?: string | null;
  }[];
}

function storeKey(provider: string, account: string): string {
  return `${provider}:${account}`;
}

function teamMap(teamId: string): Map<string, Reading> {
  let team = byTeam.get(teamId);
  if (!team) {
    team = new Map();
    byTeam.set(teamId, team);
  }
  return team;
}

function copyWindow(
  window: AllowancePost['accounts'][number]['windows'][number],
): AllowanceView['accounts'][number]['windows'][number] {
  if (window.kind === 'amount') {
    return {
      name: window.name,
      left: window.left,
      resetsAt: window.resetsAt,
      kind: 'amount',
      used: window.used,
      limit: window.limit,
      unit: window.unit,
    };
  }
  return { name: window.name, left: window.left, resetsAt: window.resetsAt, kind: 'percent' };
}

/** Drop every reading, or one team's. Tests call this so the process map does not leak. */
export function clearAllowance(teamId?: string): void {
  if (teamId === undefined) byTeam.clear();
  else byTeam.delete(teamId);
}

/**
 * Fold one post into the team. The newest `readAt` wins the label and the windows. An older post
 * still records its holder and, when it came from this machine, node `''`.
 *
 * A holder who moved to a different account of the same provider is taken off the old key. When
 * that key has no holders left, node `''` goes too. An anonymous local post clears node `''` only
 * on other same-provider keys that also have no holder, so two humans on one machine do not erase
 * each other.
 */
export function ingestAllowance(
  teamId: string,
  body: AllowancePost,
  opts: { holder: string | null; local: boolean },
): void {
  const team = teamMap(teamId);
  const touched = new Set<string>();
  const providers = new Set<AllowanceProvider>();
  for (const account of body.accounts) {
    const key = storeKey(account.provider, account.account);
    touched.add(key);
    providers.add(account.provider);
    const existing = team.get(key);
    if (!existing || account.readAt > existing.readAt) {
      const reading: Reading = {
        provider: account.provider,
        account: account.account,
        label: account.label,
        readAt: account.readAt,
        windows: account.windows.map(copyWindow),
        holders: existing?.holders ?? new Set(),
        nodes: existing?.nodes ?? new Set(),
      };
      if (opts.holder) reading.holders.add(opts.holder);
      if (opts.local) reading.nodes.add('');
      team.set(key, reading);
    } else {
      if (opts.holder) existing.holders.add(opts.holder);
      if (opts.local) existing.nodes.add('');
    }
  }
  for (const provider of providers) {
    for (const [key, reading] of [...team.entries()]) {
      if (reading.provider !== provider || touched.has(key)) continue;
      if (opts.holder) {
        if (reading.holders.delete(opts.holder) && reading.holders.size === 0) {
          reading.nodes.delete('');
        }
      } else if (opts.local && reading.holders.size === 0) {
        reading.nodes.delete('');
      }
      if (reading.holders.size === 0 && reading.nodes.size === 0) team.delete(key);
    }
  }
}

function providerOfModel(model: string | null | undefined): 'claude' | 'openai' | 'muse' | null {
  if (!model) return null;
  const lower = model.trim().toLowerCase();
  if (!lower) return null;
  if (/\b(opus|sonnet|haiku|fable)\b/.test(lower) || lower.includes('claude')) return 'claude';
  if (/\bgpt\b/.test(lower) || /\bo[1-9]\b/.test(lower)) return 'openai';
  // A word, so muse-wonder matches and musterd does not.
  if (/\bmuse\b/.test(lower)) return 'muse';
  return null;
}

function viewOf(reading: Reading): AllowanceView['accounts'][number] {
  return {
    provider: reading.provider,
    label: reading.label,
    readAt: reading.readAt,
    windows: reading.windows.map((window) =>
      window.kind === 'amount'
        ? { ...window }
        : { name: window.name, left: window.left, resetsAt: window.resetsAt, kind: 'percent' },
    ),
  };
}

function humansByNode(seats: readonly AllowanceRosterSeat[]): Map<string, string[]> {
  const nodes = new Map<string, string[]>();
  for (const seat of seats) {
    if (seat.kind !== 'human' || !seat.present) continue;
    const seen = new Set<string>();
    for (const presence of seat.presences) {
      if (presence.status === 'offline') continue;
      seen.add(presence.node ?? '');
    }
    for (const node of seen) {
      const names = nodes.get(node) ?? [];
      names.push(seat.name);
      nodes.set(node, names);
    }
  }
  return nodes;
}

function onOnlyHumanNode(
  seat: AllowanceRosterSeat,
  reading: Reading,
  humans: Map<string, string[]>,
): boolean {
  if (!seat.present) return false;
  for (const presence of seat.presences) {
    if (presence.status === 'offline') continue;
    const node = presence.node ?? '';
    if (!reading.nodes.has(node)) continue;
    const names = humans.get(node) ?? [];
    if (names.length === 1 && names[0] === seat.name) return true;
  }
  return false;
}

function readingForPresence(
  readings: readonly Reading[],
  provider: 'claude' | 'openai' | 'muse',
  presence: AllowanceRosterSeat['presences'][number],
): Reading | null | 'ambiguous' {
  if (providerOfModel(presence.model) !== provider) return null;
  const node = presence.node ?? '';
  const driver = presence.driver ?? null;
  const candidates = readings.filter(
    (reading) =>
      reading.provider === provider &&
      (reading.nodes.has(node) || (driver !== null && reading.holders.has(driver))),
  );
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1 && driver) {
    const held = candidates.filter((reading) => reading.holders.has(driver));
    if (held.length === 1) return held[0]!;
  }
  return candidates.length > 1 ? 'ambiguous' : null;
}

function agentAccounts(
  seat: AllowanceRosterSeat,
  readings: readonly Reading[],
): AllowanceView['accounts'] {
  const accounts: AllowanceView['accounts'] = [];
  const live = seat.presences.filter((presence) => presence.status !== 'offline');
  for (const provider of ['claude', 'openai', 'muse'] as const) {
    let chosen: Reading | null = null;
    let drop = false;
    for (const presence of live) {
      const match = readingForPresence(readings, provider, presence);
      if (match === null) continue;
      if (match === 'ambiguous') {
        drop = true;
        break;
      }
      const key = storeKey(match.provider, match.account);
      if (chosen && storeKey(chosen.provider, chosen.account) !== key) {
        drop = true;
        break;
      }
      chosen = match;
    }
    if (!drop && chosen) accounts.push(viewOf(chosen));
  }
  return accounts;
}

/** Which reading paints on which roster row. The account key stays in memory. */
export function allowanceForRoster(
  teamId: string,
  seats: readonly AllowanceRosterSeat[],
): Map<string, AllowanceView> {
  const out = new Map<string, AllowanceView>();
  const team = byTeam.get(teamId);
  if (!team || team.size === 0) return out;
  const readings = [...team.values()];
  const humans = humansByNode(seats);
  for (const seat of seats) {
    if (seat.kind === 'service') continue;
    const accounts =
      seat.kind === 'human'
        ? readings
            .filter(
              (reading) => reading.holders.has(seat.name) || onOnlyHumanNode(seat, reading, humans),
            )
            .map(viewOf)
        : agentAccounts(seat, readings);
    if (accounts.length === 0) continue;
    accounts.sort(
      (a, b) =>
        PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider) ||
        a.label.localeCompare(b.label),
    );
    out.set(seat.name, {
      readAt: Math.max(...accounts.map((account) => account.readAt)),
      accounts,
    });
  }
  return out;
}

/** Omit the field for a broadcast reader and when this member has no reading. Public keeps it. */
export function allowanceSpread(
  grade: string,
  view: AllowanceView | null,
): { allowance: AllowanceView } | Record<string, never> {
  if (grade === 'broadcast' || view === null) return {};
  return { allowance: view };
}

import type { Board, LiveProvider, Window } from './types.js';

/** A key already hashed. The snapshot never sees the material it was hashed from. */
export interface AccountMaterial {
  provider: 'claude' | 'openai' | 'cursor' | 'elevenlabs';
  accountKey: string;
}

export interface SnapshotWindow {
  name: string;
  left: number;
  resetsAt: number | null;
  kind: 'percent' | 'amount';
  used?: number;
  limit?: number;
  unit?: string;
}

export interface SnapshotAccount {
  provider: AccountMaterial['provider'];
  account: string;
  label: string;
  readAt: number;
  windows: SnapshotWindow[];
}

export interface AllowanceSnapshot {
  accounts: SnapshotAccount[];
}

const PROVIDERS = new Set<AccountMaterial['provider']>([
  'claude',
  'openai',
  'cursor',
  'elevenlabs',
]);

function isProvider(id: string): id is AccountMaterial['provider'] {
  return PROVIDERS.has(id as AccountMaterial['provider']);
}

function clip(value: string): string {
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length <= 40 ? text : text.slice(0, 40).trim();
}

function accountLabel(card: LiveProvider): string {
  const detail = card.detail?.trim() ?? '';
  if (detail === '') return clip(card.name);
  if (card.id === 'claude') return clip(detail);
  if (card.id === 'openai') {
    return clip(detail.toLowerCase().startsWith('openai') ? detail : `OpenAI ${detail}`);
  }
  if (card.id === 'elevenlabs') return clip(`ElevenLabs ${detail}`);
  return clip(card.name);
}

/** Short words for the card. Anything else keeps the window id (`characters`, `on-demand`). */
function shortName(window: Window): string {
  const text = `${window.label ?? ''} ${window.id}`.toLowerCase();
  if (text.includes('week')) return 'week';
  if (text.includes('5-hour') || text.includes('5 hour')) return '5h';
  if (text.includes('daily') || text.includes('day')) return 'day';
  if (text.includes('month')) return 'month';
  return window.id;
}

function leftOf(window: Window): number {
  if (!(window.limit > 0) || !Number.isFinite(window.used)) return 0;
  return Math.min(1, Math.max(0, (window.limit - window.used) / window.limit));
}

function toWindow(window: Window): SnapshotWindow | null {
  const name = shortName(window);
  if (name.length < 1 || name.length > 40) return null;
  const left = leftOf(window);
  const resetsAt =
    window.resetsAt !== null && Number.isInteger(window.resetsAt) ? window.resetsAt : null;
  const percent = window.label !== undefined || window.unit === 'percent';
  if (percent) return { name, left, resetsAt, kind: 'percent' };
  if (!(window.limit > 0) || !Number.isFinite(window.used) || window.used < 0) return null;
  const unit = window.unit.trim();
  if (unit.length < 1 || unit.length > 24) return null;
  return { name, left, resetsAt, kind: 'amount', used: window.used, limit: window.limit, unit };
}

/**
 * The post body for one good read. Live providers only. A token, a raw account id, and a quiet
 * provider are not on it — they were never copied onto the board either.
 */
export function allowanceSnapshot(
  board: Board,
  keys: readonly AccountMaterial[],
): AllowanceSnapshot | null {
  if (!Number.isInteger(board.readAt) || board.readAt <= 0) return null;
  const byProvider = new Map(keys.map((key) => [key.provider, key.accountKey]));
  const accounts: SnapshotAccount[] = [];
  for (const card of board.providers) {
    if (card.state !== 'live' || !isProvider(card.id)) continue;
    const account = byProvider.get(card.id);
    if (!account) continue;
    const windows = card.windows
      .map(toWindow)
      .filter((window) => window !== null)
      .slice(0, 8);
    if (windows.length === 0) continue;
    const label = accountLabel(card);
    if (label.length < 1) continue;
    accounts.push({ provider: card.id, account, label, readAt: board.readAt, windows });
    if (accounts.length === 8) break;
  }
  return accounts.length === 0 ? null : { accounts };
}

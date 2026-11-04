import type { MemberSummary } from '@musterd/protocol';
import type { LiveConfig } from './client';
import { MemberFace } from './MemberFace';
import { QuickButton, useQuickSend } from './quickActions';
import './OfflineSeats.css';

/**
 * The seats that are not in the room, opened from the team column's "N offline" fold (lane
 * 01M6KZZ5WH, nick 2026-11-04: putting ryder on shift took the phone). One compact row each: the
 * face, the name, why it is out, and — for an agent seat that can be woken — the same Start the
 * phone's Seats screen offers (`seatActions`). Lazy: it loads when the fold first opens.
 */
export function OfflineSeats({
  members,
  roster,
  cfg,
  canAct,
}: {
  members: readonly MemberSummary[];
  roster: Map<string, MemberSummary>;
  cfg: LiveConfig | null;
  canAct: boolean;
}) {
  return (
    <ul className="ofs" aria-label="Offline seats">
      {[...members].sort(byReach).map((m, i) => (
        <OfflineRow
          key={m.name}
          m={m}
          roster={roster}
          cfg={canAct ? cfg : null}
          i={i}
        />
      ))}
    </ul>
  );
}

/** Wakeable agents first (they have a button), then the other agents, then people. */
function byReach(a: MemberSummary, b: MemberSummary): number {
  const rank = (m: MemberSummary) => (m.kind === 'human' ? 2 : canWake(m) ? 0 : 1);
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

/** A directed act can reach it now: enrolled, and the five-state read (ADR 357) says so. */
export function canWake(m: MemberSummary): boolean {
  return m.kind !== 'human' && m.wakeable === true && (m.wakeability ?? 'wakeable') === 'wakeable';
}

/** Why it is out, in a word or two — the roster chip's reasons, said plainly. */
export function outWord(m: MemberSummary): string {
  if (m.kind === 'human') return 'away';
  if (canWake(m)) return 'asleep';
  switch (m.wakeability) {
    case 'enrolled_host_stale':
      return 'its machine is quiet';
    case 'enrolled_dead_workspace':
      return 'workspace gone';
    case 'enrolled_seat_busy':
      return 'busy elsewhere';
    default:
      return 'can’t be woken from here';
  }
}

function OfflineRow({
  m,
  roster,
  cfg,
  i,
}: {
  m: MemberSummary;
  roster: Map<string, MemberSummary>;
  cfg: LiveConfig | null;
  i: number;
}) {
  const wake = cfg !== null && canWake(m);
  return (
    <li className={`ofs__row${canWake(m) ? ' is-asleep' : ''}`} style={{ '--i': i } as React.CSSProperties}>
      <span className="ofs__face">
        <MemberFace name={m.name} roster={roster} size={22} />
      </span>
      <span className="ofs__who">
        <span className="ofs__name">{m.name}</span>
        <span className="ofs__out">{outWord(m)}</span>
      </span>
      {wake && <StartChip cfg={cfg} seat={m.name} />}
    </li>
  );
}

function StartChip({ cfg, seat }: { cfg: LiveConfig; seat: string }) {
  const { states, send } = useQuickSend(cfg, seat);
  return (
    <span className="qa qa--compact ofs__act">
      <QuickButton action="start" seat={seat} state={states.start} onPress={() => void send('start')} />
    </span>
  );
}

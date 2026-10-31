import { useCallback, useEffect, useState } from 'react';
import { apiGet, type LiveConfig } from '../client';
import type { SheetNote } from '../StyleSheet';
import { Row, Segmented } from './controls';

/** ADR 779 §5: how loud a seat's question is, per channel and per seat. Absent ⇒ the default. */
export type QuestionNotifyPrefs = {
  channels?: Partial<Record<QuestionChannel, 'buzz' | 'quiet'>>;
  seats?: Record<string, 'always' | 'never'>;
};
export const QUESTION_CHANNELS = ['app', 'slack', 'browser', 'email'] as const;
export type QuestionChannel = (typeof QUESTION_CHANNELS)[number];

const CHANNEL_NAME: Record<QuestionChannel, string> = {
  app: 'Phone',
  slack: 'Slack',
  browser: 'Browser',
  email: 'Email',
};
const LEVELS = [
  { value: 'buzz', label: 'Buzz' },
  { value: 'quiet', label: 'Quiet' },
] as const;
const SEAT_LEVELS = [
  { value: '', label: 'Default' },
  { value: 'always', label: 'Always buzz' },
  { value: 'never', label: 'Never buzz' },
] as const;

function path(cfg: LiveConfig): string {
  return `/teams/${encodeURIComponent(cfg.team)}/channels/question-notify`;
}

async function putPrefs(cfg: LiveConfig, body: QuestionNotifyPrefs): Promise<QuestionNotifyPrefs> {
  const res = await fetch(path(cfg), {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${cfg.token}`,
      'x-musterd-surface': 'web',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    prefs?: QuestionNotifyPrefs;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json.prefs ?? body;
}

/** The person's prefs with one channel or seat set; '' clears a seat back to the default. */
export function withChange(
  prefs: QuestionNotifyPrefs,
  change: { channel: QuestionChannel; level: 'buzz' | 'quiet' } | { seat: string; level: '' | 'always' | 'never' },
): QuestionNotifyPrefs {
  if ('channel' in change) return { ...prefs, channels: { ...prefs.channels, [change.channel]: change.level } };
  const seats = { ...prefs.seats };
  if (change.level === '') delete seats[change.seat];
  else seats[change.seat] = change.level;
  return { ...prefs, seats };
}

/**
 * Settings → You: questions from seats (seats ask 2f, ADR 779 §5). Turning a channel on or off and
 * "only while I'm away" stay with Away channels above; quiet hours are the person's working hours.
 * This section sets only how loud a question is, per channel and per seat.
 */
export function QuestionNotify({
  cfg,
  seats,
}: {
  cfg: LiveConfig;
  /** The team's agent seats, for the per-seat rows. */
  seats: readonly string[];
}) {
  const [prefs, setPrefs] = useState<QuestionNotifyPrefs | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<SheetNote>(null);
  const load = useCallback(async () => {
    try {
      setPrefs((await apiGet<{ prefs: QuestionNotifyPrefs }>(cfg, path(cfg))).prefs ?? {});
    } catch {
      setPrefs(null);
    }
  }, [cfg]);
  useEffect(() => {
    void load();
  }, [load]);
  if (prefs === null) return null;

  const save = async (next: QuestionNotifyPrefs, what: string) => {
    setBusy(true);
    setNote(null);
    const before = prefs;
    setPrefs(next);
    try {
      setPrefs(await putPrefs(cfg, { channels: next.channels ?? {}, seats: next.seats ?? {} }));
      setNote({ tone: 'ok', text: `${what} saved` });
    } catch (e) {
      setPrefs(before);
      setNote({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="lc-set__group" aria-labelledby="lc-set-questions">
      <h3 id="lc-set-questions" className="lc-set__h">
        Questions from seats
      </h3>
      <p className="lc-set__hint">
        By default, only a question that blocks a seat&rsquo;s work buzzes; every other question arrives
        quietly, as a count. Nothing buzzes while you&rsquo;re on /live. Quiet hours are your working hours (under Presence,
        above), and a blocking question still gets through them.
      </p>
      {QUESTION_CHANNELS.map((ch) => (
        <Row
          key={ch}
          label={CHANNEL_NAME[ch]}
          hint={(prefs.channels?.[ch] ?? 'buzz') === 'quiet' ? 'Questions arrive here without a sound.' : undefined}
        >
          <Segmented
            label={`How loud questions are on ${CHANNEL_NAME[ch]}`}
            value={prefs.channels?.[ch] ?? 'buzz'}
            options={LEVELS}
            disabled={busy}
            onPick={(v) =>
              void save(withChange(prefs, { channel: ch, level: v as 'buzz' | 'quiet' }), CHANNEL_NAME[ch])
            }
          />
        </Row>
      ))}
      {seats.length > 0 && (
        <>
          <p className="lc-set__hint">
            Per seat: <b>Always buzz</b> rings for every question from that seat. <b>Never buzz</b> stays
            quiet even when it&rsquo;s blocked, but its card still lands in Waiting on you.
          </p>
          {seats.map((seat) => (
            <Row key={seat} label={seat}>
              <Segmented
                label={`Questions from ${seat}`}
                value={prefs.seats?.[seat] ?? ''}
                options={SEAT_LEVELS}
                disabled={busy}
                onPick={(v) => void save(withChange(prefs, { seat, level: v as '' | 'always' | 'never' }), seat)}
              />
            </Row>
          ))}
        </>
      )}
      <p
        className={`lc-set__note${note ? ` lc-set__note--${note.tone}` : ''}`}
        role="status"
        aria-live="polite"
      >
        {note?.text ?? ''}
      </p>
    </section>
  );
}

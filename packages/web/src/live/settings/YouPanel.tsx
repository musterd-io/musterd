import type { DoorbellPrefs, MemberSummary, WorkingHours } from '@musterd/protocol';
// The subpath, not the barrel: the barrel carries zod into /live's bundle.
import { lastAskLine } from '@musterd/protocol/channel-outcome';
import type { DoorbellSink } from '@musterd/protocol/wire';
import { useCallback, useEffect, useState } from 'react';
import {
  getMyDoorbell,
  putMyDoorbell,
  clearMyStatusLine,
  setMyAvailability,
  setMyStatusLine,
  type LiveConfig,
  type MyDoorbell,
} from '../client';
import { formatWorkingHours } from '../office-scene/workingHours';
import {
  confirmChannelPairing,
  fetchChannelSettings,
  rejectChannelPairing,
  saveChannelSettings,
  type ChannelPairing,
  type ChannelSettings,
} from '../pairingClient';
import { MyStylePart, StyleNote, useStyleEdit, type SheetNote } from '../StyleSheet';
import { statusLineDraft, visibleStatusLine } from '../statusLine';
import { Row, Segmented, Switch } from './controls';

/**
 * The You side of settings: everything here is the viewer's own, and the daemon answers each route
 * for the caller only (no member name in any URL). Pairings first — they are the one thing here that
 * can be waiting on you — then where you are rung, then how agents talk to you.
 */
export function YouPanel({
  cfg,
  me,
  pairings,
  onPairingsChanged,
}: {
  cfg: LiveConfig;
  /** The viewer's roster row — availability and effective working hours come from it. */
  me: MemberSummary | null;
  pairings: ChannelPairing[];
  onPairingsChanged: () => void;
}) {
  const style = useStyleEdit(cfg, false);
  return (
    <>
      {pairings.length > 0 && (
        <Pairings cfg={cfg} pairings={pairings} onChanged={onPairingsChanged} />
      )}
      <Presence cfg={cfg} me={me} />
      <Doorbell cfg={cfg} />
      <AwayChannels cfg={cfg} />
      {style.mine ? (
        <div className="lc-set__style">
          <MyStylePart
            mine={style.mine}
            busy={style.busy}
            onDial={style.onDial}
            onProse={style.onProse}
          />
          <StyleNote note={style.note} />
        </div>
      ) : (
        <StyleNote note={style.note} />
      )}
    </>
  );
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Note({ note }: { note: SheetNote }) {
  return (
    <p
      className={`lc-set__note${note ? ` lc-set__note--${note.tone}` : ''}`}
      role="status"
      aria-live="polite"
    >
      {note?.text ?? ''}
    </p>
  );
}

/**
 * ADR 618 §7: a staged pairing waits for this human's confirmation. The tenant and user are shown
 * exactly as the daemon holds them, and only this Confirm creates the binding. One compact row each —
 * it was a full-width card per pairing above the room, and that was the "huge and ugly" (nick,
 * 2026-10-19).
 */
function Pairings({
  cfg,
  pairings,
  onChanged,
}: {
  cfg: LiveConfig;
  pairings: ChannelPairing[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<SheetNote>(null);
  const act = async (id: string, action: 'confirm' | 'reject') => {
    setBusy(id);
    setNote(null);
    try {
      if (action === 'confirm') await confirmChannelPairing(cfg, id);
      else await rejectChannelPairing(cfg, id);
      setNote({ tone: 'ok', text: action === 'confirm' ? 'paired' : 'rejected' });
      onChanged();
    } catch (e) {
      setNote({ tone: 'err', text: message(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="lc-set__group lc-set__group--waiting" aria-labelledby="lc-set-pair">
      <h3 id="lc-set-pair" className="lc-set__h">
        Waiting for you
      </h3>
      <p className="lc-set__lede">
        Confirm only if you just paired this channel and the workspace and user are yours.
      </p>
      <ul className="lc-set__pairs">
        {pairings.map((p) => (
          <li key={p.id} className="lc-set__pair">
            <span className="lc-set__pairwho">
              <span className="lc-set__chan">{p.channel}</span>
              <span className="lc-set__ids" title="workspace · user, as the daemon holds them">
                {p.provider_tenant_id} · {p.provider_user_id}
              </span>
            </span>
            <span className="lc-set__check" title="Should match the code the channel showed you">
              check <b>{p.check_code}</b>
            </span>
            <span className="lc-set__pairact">
              <button
                type="button"
                className="lc-set__btn lc-set__btn--go"
                disabled={busy === p.id}
                onClick={() => void act(p.id, 'confirm')}
              >
                Confirm
              </button>
              <button
                type="button"
                className="lc-set__btn"
                disabled={busy === p.id}
                onClick={() => void act(p.id, 'reject')}
              >
                Reject
              </button>
            </span>
          </li>
        ))}
      </ul>
      <Note note={note} />
    </section>
  );
}

const AVAILABILITY = [
  { value: 'available', label: 'here' },
  { value: 'away', label: 'away' },
  { value: 'dnd', label: 'do not disturb' },
] as const;

/** Availability (SPEC A.6 Axis 2 — self-set, never inferred) and the hours you work by. */
function Presence({ cfg, me }: { cfg: LiveConfig; me: MemberSummary | null }) {
  const [status, setStatus] = useState<string>(me?.availability?.status ?? 'available');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<SheetNote>(null);
  useEffect(() => {
    if (me?.availability?.status) setStatus(me.availability.status);
  }, [me?.availability?.status]);
  const pick = async (next: string) => {
    setBusy(true);
    setNote(null);
    try {
      const { member } = await setMyAvailability(cfg, {
        status: next as 'available' | 'away' | 'dnd',
      });
      setStatus(member?.availability?.status ?? next);
      setNote({
        tone: 'ok',
        text: next === 'available' ? 'asks reach you again' : 'held asks wait for you',
      });
    } catch (e) {
      setNote({ tone: 'err', text: message(e) });
    } finally {
      setBusy(false);
    }
  };
  const hours = hoursLine(me?.working_hours ?? null);
  return (
    <section className="lc-set__group" aria-labelledby="lc-set-presence">
      <h3 id="lc-set-presence" className="lc-set__h">
        Where you are
      </h3>
      <Row label="Availability" hint="Away holds asks until you are back; do not disturb lets blocking ones through.">
        <Segmented
          label="Availability"
          // off_hours is the daemon's word for outside your hours — not something you pick.
          value={status === 'off_hours' ? 'available' : status}
          options={AVAILABILITY}
          disabled={busy}
          onPick={(v) => void pick(v)}
        />
      </Row>
      <StatusLineRow cfg={cfg} me={me} />
      <Row label="Your hours" hint="Yours where you set them, else the team's.">
        <span className="lc-set__read">{hours}</span>
      </Row>
      <Note note={note} />
    </section>
  );
}

/**
 * ADR 721: your own status line — a few words on your nameplate on /live and on the public stream, and
 * on the team panel, for an hour. Humans only: the daemon refuses anyone else, and this row is on the
 * You panel, which only a signed-in human sees.
 */
function StatusLineRow({ cfg, me }: { cfg: LiveConfig; me: MemberSummary | null }) {
  const shown = me ? visibleStatusLine(me, Date.now()) : null;
  const [text, setText] = useState(shown?.text ?? '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<SheetNote>(null);
  const draft = statusLineDraft(text);
  const run = async (clear: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      if (clear) {
        await clearMyStatusLine(cfg);
        setText('');
        setNote({ tone: 'ok', text: 'status line cleared' });
      } else {
        await setMyStatusLine(cfg, text);
        setNote({ tone: 'ok', text: 'on your nameplate for an hour' });
      }
    } catch (e) {
      setNote({ tone: 'err', text: message(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Row
        label="Status line"
        hint="A few words on your nameplate here and on the public stream. It clears itself after an hour."
      >
        <span className="lc-set__statusline">
          <input
            type="text"
            className="lc-set__text"
            aria-label="Status line"
            placeholder="assembling a new dresser"
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.ready) void run(false);
            }}
          />
          <span className={`lc-set__count${draft.over ? ' is-over' : ''}`}>{draft.count}/48</span>
          <button type="button" className="lc-set__act" disabled={busy || !draft.ready} onClick={() => void run(false)}>
            Set
          </button>
          {shown && (
            <button type="button" className="lc-set__act is-quiet" disabled={busy} onClick={() => void run(true)}>
              Clear
            </button>
          )}
        </span>
      </Row>
      <Note note={note} />
    </>
  );
}

/** `MON–FRI · 9am–5pm`, or a plain "any time" — the wall card's own words, on one line. */
export function hoursLine(hours: WorkingHours | null): string {
  const copy = formatWorkingHours(hours);
  return copy ? `${copy.days} · ${copy.hours}` : 'any time';
}

const SINK_WORDS: Record<DoorbellSink, { label: string; hint: string }> = {
  live: { label: 'This page', hint: 'Always on — the asks rail above the room.' },
  os: { label: 'Desktop notification', hint: 'A banner on the machine you are signed in on.' },
  slack: { label: 'Slack', hint: '' },
  webhook: { label: 'Webhook', hint: '' },
};

/**
 * ADR 443: where an ask rings you. Each switch writes your prefs whole and shows the route the daemon
 * answers. A personal Slack or webhook URL is set from the CLI (`musterd doorbell slack on --url …`):
 * a URL is a secret, and this page never shows or takes one.
 */
function Doorbell({ cfg }: { cfg: LiveConfig }) {
  const [bell, setBell] = useState<MyDoorbell | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<SheetNote>(null);
  useEffect(() => {
    let live = true;
    getMyDoorbell(cfg).then(
      (b) => live && setBell(b),
      (e: unknown) => live && setNote({ tone: 'err', text: message(e) }),
    );
    return () => {
      live = false;
    };
  }, [cfg]);
  if (!bell) return null;
  const isOn = (sink: DoorbellSink) => bell.route.includes(sink);
  const toggle = async (sink: DoorbellSink, on: boolean) => {
    const sinks = { ...bell.prefs.sinks };
    sinks[sink] = { ...sinks[sink], on };
    const prefs: DoorbellPrefs = { sinks };
    setBusy(true);
    setNote(null);
    try {
      setBell(await putMyDoorbell(cfg, prefs));
      setNote({ tone: 'ok', text: `${SINK_WORDS[sink].label}: ${on ? 'on' : 'off'}` });
    } catch (e) {
      setNote({ tone: 'err', text: message(e) });
    } finally {
      setBusy(false);
    }
  };
  const urlHint = (sink: 'slack' | 'webhook') => {
    if (bell.prefs.sinks[sink]?.url) return 'Your own URL.';
    if (bell.team_urls[sink]) return 'The team’s URL.';
    return `No URL yet — musterd doorbell ${sink} on --url …`;
  };
  return (
    <section className="lc-set__group" aria-labelledby="lc-set-bell">
      <h3 id="lc-set-bell" className="lc-set__h">
        Where asks ring you
      </h3>
      {bell.allow
        .filter((s): s is DoorbellSink => s !== 'live')
        .map((sink) => {
          const off = sink === 'slack' || sink === 'webhook';
          const noUrl = off && !bell.prefs.sinks[sink]?.url && !bell.team_urls[sink];
          return (
            <Row
              key={sink}
              label={SINK_WORDS[sink].label}
              hint={off ? urlHint(sink) : SINK_WORDS[sink].hint}
            >
              <Switch
                label={SINK_WORDS[sink].label}
                checked={isOn(sink)}
                disabled={busy || (noUrl && !isOn(sink))}
                onChange={(on) => void toggle(sink, on)}
              />
            </Row>
          );
        })}
      <Note note={note} />
    </section>
  );
}

const TIERS = [
  { value: '', label: 'any' },
  { value: 'advisory', label: 'advisory+' },
  { value: 'standard', label: 'standard+' },
  { value: 'blocking', label: 'blocking' },
] as const;

/** Away channels (ADR 618, away channels 6): per paired channel, what it may do. Nothing is on by default. */
function AwayChannels({ cfg }: { cfg: LiveConfig }) {
  const [rows, setRows] = useState<ChannelSettings[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<SheetNote>(null);
  const refresh = useCallback(async () => {
    try {
      setRows(await fetchChannelSettings(cfg));
    } catch {
      setRows([]);
    }
  }, [cfg]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (rows.length === 0) return null;
  const save = async (next: ChannelSettings) => {
    setBusy(next.channel);
    setNote(null);
    try {
      const saved = await saveChannelSettings(cfg, next);
      // The save answers the switches only; keep the row's last-ask line.
      setRows((rs) => rs.map((r) => (r.channel === saved.channel ? { ...r, ...saved } : r)));
      setNote({ tone: 'ok', text: `${saved.channel} saved` });
    } catch (e) {
      setNote({ tone: 'err', text: message(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="lc-set__group" aria-labelledby="lc-set-away">
      <h3 id="lc-set-away" className="lc-set__h">
        Away channels
      </h3>
      {rows.map((s) => {
        const b = busy === s.channel;
        return (
          <div key={s.channel} className="lc-set__chanblock">
            <span className="lc-set__chan lc-set__chan--head">{s.channel}</span>
            {lastAskLine(s.lastAsk, Date.now()) && (
              <p
                className={`lc-set__hint lc-set__lastask${s.lastAsk?.outcome === 'sent' ? '' : ' lc-set__lastask--miss'}`}
              >
                {lastAskLine(s.lastAsk, Date.now())}
              </p>
            )}
            <Row label="Send asks here">
              <Switch
                label={`Send asks to ${s.channel}`}
                checked={s.deliver}
                disabled={b}
                onChange={(on) => void save({ ...s, deliver: on })}
              />
            </Row>
            <Row
              label="Answer from here"
              hint={!s.deliver && s.answer ? 'Off while sending is off.' : undefined}
            >
              <Switch
                label={`Answer from ${s.channel}`}
                checked={s.answer}
                disabled={b}
                onChange={(on) => void save({ ...s, answer: on })}
              />
            </Row>
            <Row label="Only while I’m away">
              <Switch
                label={`${s.channel} only while away`}
                checked={s.presenceGating}
                disabled={b}
                onChange={(on) => void save({ ...s, presenceGating: on })}
              />
            </Row>
            <Row label="Lowest tier sent">
              <Segmented
                label={`Lowest tier sent to ${s.channel}`}
                value={s.tierFloor ?? ''}
                options={TIERS}
                disabled={b}
                onPick={(v) =>
                  void save({
                    ...s,
                    tierFloor: v === '' ? null : (v as ChannelSettings['tierFloor']),
                  })
                }
              />
            </Row>
          </div>
        );
      })}
      <Note note={note} />
    </section>
  );
}

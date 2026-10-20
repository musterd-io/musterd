import {
  STYLE_DIAL_KEYS,
  STYLE_DIAL_VALUES,
  STYLE_FLOOR_PHRASES,
  STYLE_PROSE_MAX_LINES,
  styleProseLineCount,
  styleProseProblem,
  type StyleDialKey,
  type StyleDialsWire,
  type StyleFloorWire,
} from '@musterd/protocol/wire';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getMyStyle,
  getTeamPolicy,
  putMyStyle,
  setTeamPolicy,
  type LiveConfig,
  type MyStyle,
  type TeamPolicyRead,
} from './client';
import { teamKnobSet, withDial, withProse, withTeamStyle, type TeamStylePatch } from './styleEdit';

/**
 * "How agents talk to me" (ADR 514 inc 5; spec §4.5) — a sheet that drops from the viewer's own
 * identity chip on /board. /board has no per-human row, so the chip IS the human's own row (nick,
 * 2026-10-07). Two sections: the viewer's dials and prose (self only — the route takes no name),
 * and for an admin the team floor and defaults. Every control renders from what the daemon answered;
 * every write is a whole-doc replace the daemon re-answers, and the sheet shows that answer.
 */

/** The picker's words for each value — the wire spellings, read aloud. */
const VALUE_WORDS: Record<string, string> = {
  'every-time': 'every time',
  'when-it-matters': 'when it matters',
  'only-on-risk': 'only on risk',
};
const word = (v: string) => VALUE_WORDS[v] ?? v;

export type SheetNote = { tone: 'ok' | 'err'; text: string } | null;

export interface StyleSheetViewProps {
  mine: MyStyle | null;
  /** Null for a non-admin, or before the admin read answers. */
  team: TeamPolicyRead | null;
  busy: boolean;
  note: SheetNote;
  onDial: (key: StyleDialKey, value: string | null) => void;
  onProse: (text: string) => void;
  onTeam: (patch: TeamStylePatch) => void;
}

/** The sheet's body — pure, so the first frame is testable without a daemon. */
export function StyleSheetView({ mine, team, busy, note, onDial, onProse, onTeam }: StyleSheetViewProps) {
  if (!mine) return <p className="lc-style__quiet">Reading how agents talk to you…</p>;
  return (
    <>
      <MyStylePart mine={mine} busy={busy} onDial={onDial} onProse={onProse} />
      {team && <TeamStylePart team={team} busy={busy} onTeam={onTeam} />}
      <StyleNote note={note} />
    </>
  );
}

/** The live line under a write — what the daemon answered, or why it refused. */
export function StyleNote({ note }: { note: SheetNote }) {
  return (
    <p
      className={`lc-style__note${note ? ` lc-style__note--${note.tone}` : ''}`}
      role="status"
      aria-live="polite"
    >
      {note?.text ?? ''}
    </p>
  );
}

/** "How agents talk to me": the viewer's own dials and prose, over the team floor they sit on. */
export function MyStylePart({
  mine,
  busy,
  onDial,
  onProse,
}: {
  mine: MyStyle;
  busy: boolean;
  onDial: (key: StyleDialKey, value: string | null) => void;
  onProse: (text: string) => void;
}) {
  const { prefs, resolved } = mine;
  const floorOff = STYLE_FLOOR_PHRASES.filter(([k]) => !resolved.floor[k]).length;
  return (
    <>
      <section className="lc-style__part" aria-labelledby="lc-style-mine">
        <h2 id="lc-style-mine" className="lc-style__title">
          How agents talk to me
        </h2>
        <p className="lc-style__lede">
          Every seat, on every harness — in chat, and in anything it sends you. A{' '}
          <span className="lc-style__teammark" aria-hidden="true" /> line marks the team’s choice.
        </p>
        {STYLE_DIAL_KEYS.map((key) => (
          <DialRow
            key={key}
            dial={key}
            value={resolved.dials[key]}
            teamValue={resolved.team_dials[key]}
            source={prefs[key] !== undefined ? 'yours' : 'team default'}
            disabled={busy}
            onPick={(v) => onDial(key, v)}
            onReset={prefs[key] !== undefined ? () => onDial(key, null) : undefined}
          />
        ))}
        <ProseField
          label="In your own words"
          placeholder="Lead with the answer. Skip the recap."
          saved={prefs.prose ?? ''}
          disabled={busy}
          onSave={onProse}
        />
        <div className="lc-style__floor">
          <h3 className="lc-style__sub">The team floor — no preference goes below it</h3>
          <ul className="lc-style__rules">
            {STYLE_FLOOR_PHRASES.filter(([k]) => resolved.floor[k]).map(([k, phrase]) => (
              <li key={k}>{phrase}</li>
            ))}
          </ul>
          {floorOff > 0 && (
            <p className="lc-style__quiet">
              {floorOff} of 4 turned off by an admin for this team.
            </p>
          )}
          {resolved.team_prose && (
            <p className="lc-style__teamprose">
              <span className="lc-style__quiet">The team adds:</span> {resolved.team_prose}
            </p>
          )}
        </div>
        <details className="lc-style__block">
          <summary>What a seat steered by you reads</summary>
          <pre>{mine.block}</pre>
        </details>
      </section>
    </>
  );
}

/** The team's floor, default dials and prose — admin only; the daemon decides who that is. */
export function TeamStylePart({
  team,
  busy,
  onTeam,
}: {
  team: TeamPolicyRead;
  busy: boolean;
  onTeam: (patch: TeamStylePatch) => void;
}) {
  const { floor, defaults, prose } = team.policy.style;
  const source = (set: boolean) => (set ? 'set for the team' : 'default');
  return (
    <section className="lc-style__part lc-style__part--team" aria-labelledby="lc-style-team">
      <h2 id="lc-style-team" className="lc-style__title">
        The team’s floor and defaults <span className="lc-style__tag">admin</span>
      </h2>
      <p className="lc-style__lede">
        What every seat follows, and how it talks to anyone who hasn’t chosen. Seats pick it up at
        their next inbox check.
      </p>
      <h3 className="lc-style__sub">Floor</h3>
      {STYLE_FLOOR_PHRASES.map(([key, phrase]) => (
        <label key={key} className="lc-style__toggle">
          <input
            type="checkbox"
            checked={floor[key]}
            disabled={busy}
            onChange={(e) =>
              onTeam({ floor: { [key]: e.target.checked } as Partial<StyleFloorWire> })
            }
          />
          <span className="lc-style__phrase">{phrase}</span>
          <span className="lc-style__source">{source(teamKnobSet(team.stored, 'floor', key))}</span>
        </label>
      ))}
      <h3 className="lc-style__sub">Defaults</h3>
      {STYLE_DIAL_KEYS.map((key) => (
        <DialRow
          key={key}
          dial={key}
          value={defaults[key]}
          source={source(teamKnobSet(team.stored, 'defaults', key))}
          disabled={busy}
          onPick={(v) => onTeam({ defaults: { [key]: v } as Partial<StyleDialsWire> })}
        />
      ))}
      <ProseField
        label="The team adds"
        placeholder="One line every seat reads, before anyone's own."
        saved={prose}
        source={source(teamKnobSet(team.stored, 'prose'))}
        disabled={busy}
        onSave={(text) => onTeam({ prose: text })}
      />
    </section>
  );
}

function DialRow({
  dial,
  value,
  teamValue,
  source,
  disabled,
  onPick,
  onReset,
}: {
  dial: StyleDialKey;
  value: string;
  /** Marks the option the team default would give — on the human's own rows only. */
  teamValue?: string;
  source: string;
  disabled: boolean;
  onPick: (value: string) => void;
  onReset?: (() => void) | undefined;
}) {
  return (
    <div className="lc-style__dial" role="radiogroup" aria-label={dial}>
      <span className="lc-style__dialname">{dial}</span>
      <span className="lc-style__options">
        {STYLE_DIAL_VALUES[dial].map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={v === value}
            className={`lc-style__opt${v === value ? ' lc-style__opt--on' : ''}${
              teamValue === v ? ' lc-style__opt--team' : ''
            }`}
            title={teamValue === v ? 'the team default' : undefined}
            disabled={disabled}
            onClick={() => v !== value && onPick(v)}
          >
            {word(v)}
          </button>
        ))}
      </span>
      <span className="lc-style__source">
        {onReset ? (
          <button type="button" className="lc-style__reset" disabled={disabled} onClick={onReset}>
            yours · use the team’s
          </button>
        ) : (
          source
        )}
      </span>
    </div>
  );
}

function ProseField({
  label,
  placeholder,
  saved,
  source,
  disabled,
  onSave,
}: {
  label: string;
  placeholder: string;
  saved: string;
  source?: string;
  disabled: boolean;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState(saved);
  // A save the daemon answered resets the draft to what it stored.
  useEffect(() => setDraft(saved), [saved]);
  const lines = styleProseLineCount(draft);
  const problem = styleProseProblem(draft);
  const dirty = draft !== saved;
  return (
    <label className="lc-style__prose">
      <span className="lc-style__prosehead">
        <span className="lc-style__dialname">{label}</span>
        <span className={`lc-style__count${problem ? ' lc-style__count--over' : ''}`}>
          {problem ?? `${lines} / ${STYLE_PROSE_MAX_LINES} lines`}
        </span>
        {source && <span className="lc-style__source">{source}</span>}
      </span>
      <textarea
        rows={3}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
      />
      {dirty && (
        <span className="lc-style__proseactions">
          <button
            type="button"
            className="lc-style__save"
            disabled={disabled || problem !== null}
            onClick={() => onSave(draft)}
          >
            Save
          </button>
          <button
            type="button"
            className="lc-style__reset"
            disabled={disabled}
            onClick={() => setDraft(saved)}
          >
            undo
          </button>
        </span>
      )}
    </label>
  );
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The chip-anchored sheet: reads on open, writes one change at a time, shows what the daemon
 * answered. `isAdmin` (the roster's `capabilities.is_admin`) only decides whether to ASK for the
 * team part; the daemon's `authAdmin` decides whether there is one, and a refusal just hides it.
 */
export function StyleSheet({
  cfg,
  isAdmin,
  onClose,
}: {
  cfg: LiveConfig;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const style = useStyleEdit(cfg, isAdmin);
  const panel = useRef<HTMLDivElement>(null);

  // Escape or a press outside closes; focus lands in the sheet so the keyboard can reach it.
  useEffect(() => {
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: PointerEvent) => {
      const el = panel.current;
      const target = e.target as Node | null;
      if (el && target && !el.contains(target) && !el.parentElement?.contains(target)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [onClose]);

  return (
    <div
      ref={panel}
      className="lc-style"
      role="dialog"
      aria-label="How agents talk to me"
      tabIndex={-1}
    >
      <StyleSheetView {...style} />
    </div>
  );
}

/**
 * The style sheet's state and writes, apart from where it renders: reads on mount, writes one change
 * at a time, keeps what the daemon answered. `isAdmin` only decides whether to ASK for the team part;
 * the daemon's `authAdmin` decides whether there is one, and a refusal just leaves `team` null.
 */
export function useStyleEdit(cfg: LiveConfig, isAdmin: boolean): StyleSheetViewProps {
  const [mine, setMine] = useState<MyStyle | null>(null);
  const [team, setTeam] = useState<TeamPolicyRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<SheetNote>(null);

  useEffect(() => {
    let live = true;
    getMyStyle(cfg).then(
      (s) => live && setMine(s),
      (e: unknown) => live && setNote({ tone: 'err', text: message(e) }),
    );
    if (isAdmin)
      getTeamPolicy(cfg).then(
        (p) => live && setTeam(p),
        () => undefined, // not an admin after all — the daemon's answer wins; no team part
      );
    return () => {
      live = false;
    };
  }, [cfg, isAdmin]);

  const run = useCallback(async (work: () => Promise<void>, done: string) => {
    setBusy(true);
    setNote(null);
    try {
      await work();
      setNote({ tone: 'ok', text: done });
    } catch (e) {
      setNote({ tone: 'err', text: message(e) });
    } finally {
      setBusy(false);
    }
  }, []);

  const onDial = (key: StyleDialKey, value: string | null) => {
    if (!mine) return;
    const prefs = withDial(mine.prefs, key, value as StyleDialsWire[typeof key] | null);
    void run(
      async () => setMine(await putMyStyle(cfg, prefs)),
      value === null ? `${key}: back to the team default` : `${key}: ${word(value)}`,
    );
  };
  const onProse = (text: string) => {
    if (!mine) return;
    void run(
      async () => setMine(await putMyStyle(cfg, withProse(mine.prefs, text))),
      text.trim() ? 'saved — seats read it at their next inbox check' : 'your words cleared',
    );
  };
  const onTeam = (patch: TeamStylePatch) => {
    if (!team) return;
    void run(async () => {
      setTeam(await setTeamPolicy(cfg, withTeamStyle(team.stored, patch)));
      // The team defaults sit under the viewer's own dials too — re-read so their section agrees.
      setMine(await getMyStyle(cfg));
    }, 'team style saved');
  };

  return { mine, team, busy, note, onDial, onProse, onTeam };
}

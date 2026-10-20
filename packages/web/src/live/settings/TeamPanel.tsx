import type { WorkingHours } from '@musterd/protocol';
import { useEffect, useState } from 'react';
import {
  getTeamPolicy,
  setTeamPolicy,
  type LiveConfig,
  type TeamPolicyRead,
} from '../client';
import { HoldsPause } from '../HoldsBanner';
import { StyleNote, TeamStylePart, type SheetNote } from '../StyleSheet';
import { withTeamStyle, type TeamStylePatch } from '../styleEdit';
import { NumberField, Row, Segmented, Switch } from './controls';
import {
  POLICY_GROUPS,
  fromInput,
  knobIsSet,
  knobValue,
  toInput,
  withKnob,
  type Knob,
} from './policyKnobs';
import { hoursLine } from './YouPanel';

/**
 * The Team side of settings — admins only. The route decides who sees this tab from the roster's
 * `capabilities.is_admin`; the daemon decides who may read or write it (`authAdmin`), and a refusal
 * just says so here.
 *
 * Every policy edit — a knob or the team's style — goes through ONE copy of the stored doc. `POST
 * /policy` replaces the whole doc (ADR 185), so two editors each holding their own copy would undo
 * each other's last change; that is why the team style lives here and not in its own hook.
 */
export function TeamPanel({
  cfg,
  hours,
  onHoldsChanged,
}: {
  cfg: LiveConfig;
  hours: WorkingHours | null;
  onHoldsChanged: () => void;
}) {
  const [read, setRead] = useState<TeamPolicyRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<SheetNote>(null);
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getTeamPolicy(cfg).then(
      (p) => live && setRead(p),
      (e: unknown) => live && setRefused(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [cfg]);

  const write = async (stored: TeamPolicyRead['stored'], done: string) => {
    setBusy(true);
    setNote(null);
    try {
      setRead(await setTeamPolicy(cfg, stored));
      setNote({ tone: 'ok', text: `${done} — seats pick it up at their next check` });
    } catch (e) {
      setNote({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const setKnob = (knob: Knob, value: unknown) => {
    if (!read) return;
    void write(withKnob(read.stored, knob.path, value), knob.label);
  };
  // The viewer's own style sits on these defaults; the You tab re-reads it when it next mounts.
  const onTeamStyle = (patch: TeamStylePatch) => {
    if (!read) return;
    void write(withTeamStyle(read.stored, patch), 'team style');
  };

  const tz = hours?.timezone;
  return (
    <>
      <section className="lc-set__group" aria-labelledby="lc-set-hours">
        <h3 id="lc-set-hours" className="lc-set__h">
          Working hours
        </h3>
        <Row label="The team works" hint={tz ? `In ${tz}. Changed from the team’s config for now.` : 'Changed from the team’s config for now.'}>
          <span className="lc-set__read">{hoursLine(hours)}</span>
        </Row>
      </section>

      <section className="lc-set__group" aria-labelledby="lc-set-pause">
        <h3 id="lc-set-pause" className="lc-set__h">
          Pause
        </h3>
        <Row label="Hold the team" hint="Pause the daemon's auto-refresh or merges for every seat, or pin a notice — for a set time.">
          <HoldsPause cfg={cfg} onChanged={onHoldsChanged} />
        </Row>
      </section>

      {refused && <p className="lc-set__note lc-set__note--err">{refused}</p>}
      {!read && !refused && <p className="lc-set__quiet">Reading the team’s policy…</p>}

      {read &&
        POLICY_GROUPS.map((group) => (
          <section
            key={group.id}
            className="lc-set__group"
            aria-labelledby={`lc-set-${group.id}`}
          >
            <h3 id={`lc-set-${group.id}`} className="lc-set__h">
              {group.title}
            </h3>
            <p className="lc-set__lede">{group.lede}</p>
            {group.knobs.map((knob) => (
              <KnobRow
                key={knob.path.join('.')}
                knob={knob}
                read={read}
                busy={busy}
                onSet={(v) => setKnob(knob, v)}
              />
            ))}
          </section>
        ))}

      {read && (
        <div className="lc-set__style">
          <TeamStylePart
            team={{ policy: read.policy, stored: read.stored }}
            busy={busy}
            onTeam={onTeamStyle}
          />
        </div>
      )}
      <StyleNote note={note} />
    </>
  );
}

function KnobRow({
  knob,
  read,
  busy,
  onSet,
}: {
  knob: Knob;
  read: TeamPolicyRead;
  busy: boolean;
  onSet: (value: unknown) => void;
}) {
  const set = knobIsSet(read, knob);
  const value = knobValue(read, knob);
  const tag = set ? 'set for the team' : knob.optional ? 'not set' : 'default';
  const reset =
    set && !busy ? (
      <button
        type="button"
        className="lc-set__reset"
        title={knob.optional ? 'Clear it' : 'Back to the default'}
        onClick={() => onSet(undefined)}
      >
        {knob.optional ? 'clear' : 'reset'}
      </button>
    ) : null;
  const { kind } = knob;
  let control;
  switch (kind.type) {
    case 'bool':
      control = (
        <Switch label={knob.label} checked={value === true} disabled={busy} onChange={onSet} />
      );
      break;
    case 'enum':
      control = (
        <Segmented
          label={knob.label}
          value={typeof value === 'string' ? value : ''}
          options={kind.options}
          disabled={busy}
          onPick={onSet}
        />
      );
      break;
    default: {
      const unit = kind.type === 'minutes' ? 'min' : kind.type === 'usd' ? 'USD' : undefined;
      control = (
        <NumberField
          label={knob.label}
          saved={toInput(kind, value)}
          unit={unit}
          placeholder={knob.optional ? 'none' : undefined}
          disabled={busy}
          check={(text) => {
            const r = fromInput(knob, text);
            return r.ok ? null : r.error;
          }}
          onSave={(text) => {
            const r = fromInput(knob, text);
            if (r.ok) onSet(r.value);
          }}
        />
      );
    }
  }
  return (
    <Row label={knob.label} hint={knob.hint} tag={tag}>
      {control}
      {reset}
    </Row>
  );
}

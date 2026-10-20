import { useEffect, useId, useState, type ReactNode } from 'react';

/**
 * The settings overlay's few controls. One row shape everywhere — what it is and a line on what it
 * does on the left, the control on the right — so a long policy group reads as a list, not a form.
 */

export function Row({
  label,
  hint,
  tag,
  children,
}: {
  label: string;
  hint?: string | undefined;
  /** "set for the team" / "default" — where the value came from. */
  tag?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="lc-set__row">
      <span className="lc-set__what">
        <span className="lc-set__label">
          {label}
          {tag && <span className="lc-set__tag">{tag}</span>}
        </span>
        {hint && <span className="lc-set__hint">{hint}</span>}
      </span>
      <span className="lc-set__control">{children}</span>
    </div>
  );
}

/** A real checkbox wearing a switch — the keyboard, the label and the screen reader all still work. */
export function Switch({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  /** The accessible name; the visible label is the row's. */
  label: string;
  disabled?: boolean | undefined;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="lc-set__switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        aria-label={label}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="lc-set__track" aria-hidden="true">
        <span className="lc-set__thumb" />
      </span>
    </label>
  );
}

/** Two to four choices, one on. A radiogroup of buttons, the way the style dials already read. */
export function Segmented({
  value,
  options,
  label,
  disabled,
  onPick,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  label: string;
  disabled?: boolean | undefined;
  onPick: (value: string) => void;
}) {
  return (
    <span className="lc-set__seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`lc-set__segopt${o.value === value ? ' is-on' : ''}`}
          disabled={disabled}
          onClick={() => o.value !== value && onPick(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

/**
 * A number that saves on Enter or blur, never per keystroke — each save is a whole-doc write the
 * daemon answers. `check` turns the text into a value or an error shown in place of the unit.
 */
export function NumberField({
  saved,
  unit,
  label,
  placeholder,
  disabled,
  check,
  onSave,
}: {
  saved: string;
  unit?: string | undefined;
  label: string;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  check: (text: string) => string | null;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState(saved);
  const id = useId();
  useEffect(() => setDraft(saved), [saved]);
  const problem = draft === saved ? null : check(draft);
  const commit = () => {
    if (draft !== saved && problem === null) onSave(draft);
  };
  return (
    <span className="lc-set__num">
      <input
        id={id}
        inputMode="decimal"
        aria-label={label}
        aria-invalid={problem !== null}
        aria-describedby={problem ? `${id}-err` : undefined}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape' && draft !== saved) {
            e.preventDefault(); // put the old value back; the overlay stays open
            setDraft(saved);
          }
        }}
      />
      {problem ? (
        <span id={`${id}-err`} className="lc-set__numerr">
          {problem}
        </span>
      ) : (
        unit && <span className="lc-set__unit">{unit}</span>
      )}
    </span>
  );
}

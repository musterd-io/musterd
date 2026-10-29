/**
 * IDs on the work board (lane 01M62KAMZ3, swetha 2026-10-28: "i need the IDs of goals and lanes
 * displayed on them so i can refer to them by just an ID"). Pure helpers — the chip is CopyId.tsx.
 */

/** How much of a lane's ULID the board shows. Ten characters is the timestamp half: unique in
 *  practice, and the form every tool and every PR title on this team already accepts. */
export const LANE_ID_SHOWN = 10;

/** The ID as a person would type it: a lane's short ULID, a goal's slug as it is. */
export function shownId(kind: 'lane' | 'goal', id: string): string {
  return kind === 'lane' ? id.slice(0, LANE_ID_SHOWN) : id;
}

/** What a copy puts on the clipboard: the bare ID, or the ID with its title — ready to paste into a chat. */
export function copyPayload(id: string, title: string, withTitle: boolean): string {
  return withTitle ? `${id} — ${title}` : id;
}

/**
 * Put `text` on the clipboard. The async API needs a secure context, and the daemon's /live is
 * often opened over plain http on a tailnet address — there `navigator.clipboard` is undefined, so
 * fall back to the old selection copy rather than fail silently.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the selection copy
  }
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  document.body.appendChild(ta);
  const prior = document.activeElement as HTMLElement | null;
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  prior?.focus?.({ preventScroll: true });
  return ok;
}

/** Is this key press the board's copy shortcut — a bare `c` (with shift: the ID and its title), never
 *  while typing and never with ⌘/Ctrl/Alt, so the system copy stays the system's. */
export function copyShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'target'>):
  | { withTitle: boolean }
  | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key !== 'c' && e.key !== 'C') return null;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName ?? ''))) return null;
  return { withTitle: e.shiftKey };
}

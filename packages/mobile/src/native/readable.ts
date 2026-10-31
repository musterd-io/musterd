/**
 * An ask's text, made easier to read on a phone (nick, 2026-10-30: "a tiny bit too much raw text
 * dump"). Agents write for a terminal: markdown marks, backticks, full 26-character ids, a
 * `[lane]` tag. The lock screen and the list show `summary` — one cleaned line, cut at a sentence.
 * The ask screen shows `blocks` — the whole text, its paragraphs and bullets kept, its marks
 * turned into styling. Nothing is reworded; only the marks go.
 *
 * The notification extension has a Swift copy of `plain` and `summary` (`Readable.swift`);
 * `logic-check.swift` and this file's test share the fixtures.
 */

/** A ULID: Crockford base32, 26 characters. Shown as its first 10, like the CLI. */
const ULID = /\b([0-9A-HJKMNP-TV-Z]{10})[0-9A-HJKMNP-TV-Z]{16}\b/g;

/** One line of the text with every mark taken out. */
export function plain(text: string): string {
  return text
    .replace(/^\s*\[[a-z-]+\]\s*/, '')
    .replace(/```/g, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '• ')
    .replace(ULID, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `plain`, cut to `max` characters: at the last sentence end if there is one, else a word. */
export function summary(text: string, max = 160): string {
  const line = plain(text);
  if (line.length <= max) return line;
  const head = line.slice(0, max);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
  if (sentence >= 40) return head.slice(0, sentence + 1);
  const space = head.lastIndexOf(' ', max - 1);
  return `${head.slice(0, space > 0 ? space : max - 1).replace(/[\s,;:·—-]+$/, '')}…`;
}

export type Span = { text: string; style?: 'bold' | 'code' };
export type Block = { kind: 'para' | 'bullet'; spans: Span[] };

/** The text as paragraphs and bullets, each a run of plain, bold and code spans. */
export function blocks(text: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: 'para', spans: spans(para.join(' ')) });
    para = [];
  };
  const body = text.replace(/^\s*\[[a-z-]+\]\s*/, '').replace(/```/g, '');
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (bullet) {
      flush();
      out.push({ kind: 'bullet', spans: spans(bullet[1]!) });
    } else para.push(line.replace(/^#{1,6}\s+/, ''));
  }
  flush();
  return out;
}

function spans(line: string): Span[] {
  const out: Span[] = [];
  const mark = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__/g;
  let at = 0;
  for (let m = mark.exec(line); m; m = mark.exec(line)) {
    if (m.index > at) out.push({ text: short(line.slice(at, m.index)) });
    out.push(
      m[1] !== undefined
        ? { text: short(m[1]), style: 'code' }
        : { text: short(m[2] ?? m[3]!), style: 'bold' },
    );
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push({ text: short(line.slice(at)) });
  return out;
}

function short(text: string): string {
  return text.replace(ULID, '$1');
}

/**
 * What a refusal says to the person (lane 01M6EPXA6Z). nick, 2026-11-02, after /live showed him
 * "authority refused (descriptor_mismatch): human answers to privileged asks require an A2 device
 * signature (ADR 662)": "we need much better/user friendly/helpful error messages".
 *
 * The daemon's refusal is a code and a sentence written for the record. The person needs three
 * things in one line: what happened, why in a clause, and the one thing to do next. The code, the
 * ADR and the daemon's own words stay — behind a disclosure, for seats and for debugging — and a
 * refusal this table has never seen falls through unchanged, so nothing is hidden, only translated.
 *
 * The table is the whole surface: every entry is a pattern over the daemon's message or code, and
 * `refusalCopy.test.ts` asserts no user-facing line carries an ADR number, a snake_case code or the
 * word "descriptor".
 */

export interface Refusal {
  /** The plain line: what happened and what to do. */
  line: string;
  /** The daemon's own words and code, for the disclosure. Null when the line already says it all. */
  detail: string | null;
}

interface Rule {
  /** Matches the daemon's message (and `code`, when the error carried one). */
  test: RegExp;
  /** The person's line; `$why` is the daemon's `— why` clause when the message carried one. */
  line: string | ((m: RegExpExecArray, why: string | null) => string);
}

const PASSKEY_AGAIN = 'Press Approve again and confirm with your passkey.';

const RULES: readonly Rule[] = [
  // ADR 662 — the A2 gate on a human's answer. The reason code is the daemon's; the person gets the move.
  { test: /authority refused \(no_signature\)/, line: `This needs your passkey. ${PASSKEY_AGAIN}` },
  {
    test: /authority refused \(descriptor_mismatch\)/,
    line: (_m, why) =>
      why?.includes('another member')
        ? 'Your passkey belongs to a different member than the one you are signed in as. Sign in as yourself and try again.'
        : why?.includes("not ") && why.includes("'s")
          ? 'The passkey used is not yours. Sign in as yourself and try again.'
          : why?.includes('another node')
            ? 'That confirmation was made on another machine. Press Approve again on this one.'
            : `Your passkey confirmed something other than this ask. ${PASSKEY_AGAIN}`,
  },
  { test: /authority refused \(expired\)/, line: `The passkey prompt took too long. ${PASSKEY_AGAIN}` },
  { test: /authority refused \(nonce_reused\)/, line: `That confirmation was already used. ${PASSKEY_AGAIN}` },
  {
    test: /authority refused \(key_revoked\)/,
    line: 'The passkey on this device was revoked. Enroll a new one under Settings → You, then try again.',
  },
  {
    test: /authority refused \(assurance_too_low\)/,
    line: 'This device’s key cannot confirm an approval. Use a passkey or your phone.',
  },
  {
    test: /authority refused \(agent_credential\)/,
    line: 'You are signed in as a seat, not as yourself. Sign in as yourself to answer.',
  },
  { test: /authority refused/, line: `This needs your passkey. ${PASSKEY_AGAIN}` },
  // The passkey ceremony itself (authorityProof.ts), already sentences; kept so the detail is dropped.
  { test: /passkey cancelled/, line: 'Passkey cancelled. Nothing was sent.' },
  { test: /passkey mismatch/, line: 'That passkey is not one of yours. Nothing was sent.' },
  {
    test: /open musterd.s localhost URL to use passkeys/,
    line: 'Passkeys only work on the localhost address. Open musterd there and try again. Nothing was sent.',
  },
  { test: /passkeys are unavailable in this browser/, line: 'This browser has no passkey support. Use your phone or another browser.' },
  // A question answered elsewhere first (ADR 773).
  {
    test: /answered by (\S+) on (\S+)/,
    line: (m) => `Already answered by ${m[1]} on ${m[2]}. Nothing more to do.`,
  },
  // Lanes, from the board and the rail.
  { test: /only a human may park/, line: 'Only a person can park a lane. Ask a human on the team to park it.' },
  { test: /observer seats are read-only/, line: 'You are watching as an observer. Sign in to take part.' },
  // The daemon's reach.
  { test: /\bhub_unreachable\b|hub (is )?unreachable|could not reach the hub/, line: 'The hub cannot be reached right now. Try again in a moment.' },
  { test: /\brate_limited\b|too many requests/i, line: 'Too many tries in a row. Wait a minute and try again.' },
  { test: /\bunauthorized\b|http_401/, line: 'Your sign-in has lapsed. Sign in again.' },
  { test: /\bnot_found\b|http_404/, line: 'That is no longer there — it may have been answered or withdrawn. Refresh.' },
  { test: /\bconflict\b|http_409/, line: 'Something changed under this before it was sent. Refresh and try again.' },
  { test: /\bforbidden\b|http_403/, line: 'You are not allowed to do that from this seat.' },
  { test: /\bserver_error\b|http_5\d\d/, line: 'musterd hit an error on its side. Try again; if it keeps happening, tell the team.' },
  { test: /failed to fetch|networkerror|load failed/i, line: 'musterd could not be reached. Check the connection and try again.' },
];

/** The `— why` clause #3724 appends to an authority refusal, if present. */
function whyOf(message: string): string | null {
  const m = /\(ADR \d+\) — (.+)$/.exec(message);
  return m ? m[1]!.trim() : null;
}

/**
 * The person's line for a daemon refusal, and the record behind it. `code` is the error's code when
 * the transport carried one (`LiveFetchError.code`); a bare `Error` has none.
 */
export function refusalCopy(message: string, code?: string | null): Refusal {
  const haystack = code ? `${message}\n${code}` : message;
  const why = whyOf(message);
  for (const rule of RULES) {
    const m = rule.test.exec(haystack);
    if (!m) continue;
    const line = typeof rule.line === 'string' ? rule.line : rule.line(m, why);
    const detail = code ? `${code}: ${message}` : message;
    return { line, detail: detail === line ? null : detail };
  }
  // Unknown: the daemon's words, unhidden. The table grows when one is seen.
  return { line: message, detail: code ? `${code}: ${message}` : null };
}

/** Every rule's line, for the test that reads them all. */
export function refusalLines(): string[] {
  const why = 'the signature covers a different act, target or payload (expected human_accept on x)';
  const probes = ['another member', "the signing key is not nick's", 'another node', why];
  return RULES.flatMap((r) =>
    typeof r.line === 'string'
      ? [r.line]
      : probes.map((p) => (r.line as Exclude<Rule['line'], string>)(['', 'x', 'y'] as unknown as RegExpExecArray, p)),
  );
}

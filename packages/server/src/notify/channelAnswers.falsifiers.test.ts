import { describe, it } from 'vitest';

/**
 * The away-channels falsifier suite (ADR 618, spec 2026-10-15-away-channels-design.md). Each entry names
 * an attack the design claims to refuse. They are pending on purpose: the code they exercise lands in the
 * later away-channels lanes, and a todo still pending when its lane lands fails review. Increment 1 fixes
 * the list so no lane can quietly narrow it.
 */

describe('a malicious relay (ADR 618 §9)', () => {
  it.todo(
    'forges a provider callback naming the bound user: advisory only, never an authorization',
  );
  it.todo('swaps one ask or action for another: the token binds ask id, revision and action');
  it.todo('replays an answer after the binding was revoked: refused on the binding generation');
  it.todo('races Approve and Reject on one ask: exactly one decision, never reopened');
  it.todo('pairs a different provider identity: refused without the original-surface confirmation');
  it.todo(
    'lies in the confirmation UI: the daemon-held tenant and user, not the relay, are what is shown',
  );
  it.todo(
    'answers after the daemon restarted: reconciled from daemon state, expired buttons refused',
  );
  it.todo('answers across teams or with a stale revision: refused');
});

describe('the action class (ADR 618 §3-§4)', () => {
  it.todo('a privileged request mislabeled as a consult is classed privileged and gets no buttons');
  it.todo('a lane whose risk tags are missing or were removed does not become an ordinary class');
  it.todo('an action that becomes privileged after delivery refuses the answer at redemption');
  it.todo('an unknown consequence is privileged (fail closed)');
});

describe('consumers enforce assurance (ADR 618 §5)', () => {
  it.todo('the gate release read refuses an A1 answer');
  it.todo('acceptance refuses an A1 answer');
  it.todo('request.decide refuses an A1 answer');
  it.todo('an A1 answer is never written as a plain human accept or decline');
  it.todo('an A1 answer to a consult sets no authorized_by');
});

describe('kill switch and audit (ADR 618 §7-§8)', () => {
  it.todo(
    'the kill switch revokes every binding generation and outstanding token without the relay',
  );
  it.todo('no audit row carries a raw nonce, button token, signature, cookie or body');
});

import { describe, expect, it } from 'vitest';
import { refusalCopy, refusalLines } from './refusalCopy';

describe('refusalCopy (lane 01M6EPXA6Z): the person gets a sentence, the record keeps the code', () => {
  it('no user-facing line carries an ADR number, a snake_case code, or the word "descriptor"', () => {
    const lines = refusalLines();
    expect(lines.length).toBeGreaterThan(15);
    for (const line of lines) {
      expect(line, line).not.toMatch(/ADR\s*\d+/);
      expect(line, line).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
      expect(line, line).not.toMatch(/descriptor/i);
      expect(line, line).toMatch(/[.!]$/);
    }
  });

  it("nick's morning refusal becomes what happened and what to do, with the daemon's words behind it", () => {
    const msg =
      'authority refused (descriptor_mismatch): human answers to privileged asks require an A2 device signature (ADR 662)';
    const r = refusalCopy(msg, 'forbidden');
    expect(r.line).toBe('Your passkey confirmed something other than this ask. Press Approve again and confirm with your passkey.');
    expect(r.detail).toBe(`forbidden: ${msg}`);
  });

  it("reads the why clause #3724 appends and picks the line for it", () => {
    const base = 'authority refused (descriptor_mismatch): human answers to privileged asks require an A2 device signature (ADR 662)';
    expect(refusalCopy(`${base} — the descriptor was minted for another member, not nick`).line).toMatch(/different member/);
    expect(refusalCopy(`${base} — the descriptor was minted on another node`).line).toMatch(/another machine/);
    expect(refusalCopy(`${base} — the signing key is not nick's`).line).toMatch(/not yours/);
  });

  it('a question answered elsewhere names who and where', () => {
    expect(refusalCopy('question_already_answered: answered by nick on app').line).toBe(
      'Already answered by nick on app. Nothing more to do.',
    );
  });

  it('a transport code with no known sentence falls back to the code family', () => {
    expect(refusalCopy('HTTP 401', 'http_401').line).toBe('Your sign-in has lapsed. Sign in again.');
    expect(refusalCopy('the hub could not be asked', 'hub_unreachable').line).toMatch(/hub cannot be reached/);
  });

  it('an unknown refusal passes through unhidden', () => {
    const r = refusalCopy('something nobody wrote a line for yet');
    expect(r.line).toBe('something nobody wrote a line for yet');
    expect(r.detail).toBeNull();
  });
});

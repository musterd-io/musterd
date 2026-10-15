import { describe, expect, it } from 'vitest';
import { HubUnreachableError } from './claim.js';

// ADR 598: the refusal names what happened, what waits and what still works.
describe('HubUnreachableError', () => {
  const hub = 'http://hub.test:4849';

  it('a refused connection says nothing was recorded, what waits and what works', () => {
    const msg = new HubUnreachableError(hub, 'TypeError: fetch failed').message;
    expect(msg).toContain(`${hub} could not be reached`);
    expect(msg).toContain('nothing was recorded here');
    expect(msg).toContain('claim, handoff, release, submit and close wait for the hub');
    expect(msg).toContain('Messages, inbox, opening and editing lanes, and memory keep working');
    expect(msg).not.toContain('may have received');
  });

  it('a timeout is named as one and warns the hub may have heard it', () => {
    const msg = new HubUnreachableError(
      hub,
      'TimeoutError: The operation was aborted due to timeout',
    ).message;
    expect(msg).toContain('did not answer in time');
    expect(msg).toContain('nothing was recorded here');
    expect(msg).toContain('read the board before retrying');
  });
});

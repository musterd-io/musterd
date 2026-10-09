import type { Request } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { AuditFetchError } from './client';
import { settleRequests } from './useSeatRequests';

describe('settleRequests', () => {
  it('passes a list through', () => {
    const list = [{ id: 'r1' }] as unknown as Request[];
    expect(settleRequests(list)).toEqual({ kind: 'ok', requests: list });
  });

  it('treats 401 and 403 as the ordinary "not an admin" answer', () => {
    expect(settleRequests(new AuditFetchError('no', 'forbidden', 403))).toEqual({ kind: 'forbidden' });
    expect(settleRequests(new AuditFetchError('no', 'unauthorized', 401))).toEqual({
      kind: 'forbidden',
    });
  });

  it('treats any other failure as retry-later, never as a request', () => {
    expect(settleRequests(new AuditFetchError('down', 'http_500', 500))).toEqual({ kind: 'failed' });
    expect(settleRequests(new Error('network'))).toEqual({ kind: 'failed' });
  });
});

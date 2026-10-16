import { describe, expect, it } from 'vitest';
import { ClientAddressSchema } from './client-address.js';

describe('ClientAddressSchema', () => {
  it('accepts IPv4 and IPv6 transport addresses', () => {
    for (const address of ['192.0.2.1', '2001:db8::1', '::ffff:192.0.2.1'])
      expect(ClientAddressSchema.safeParse(address).success).toBe(true);
  });
  it('rejects arbitrary keys, address chains, repeated values and scoped addresses', () => {
    for (const address of [
      'not-an-ip',
      '192.0.2.1, 192.0.2.2',
      ['192.0.2.1'],
      'fe80::1%eth0',
      undefined,
    ])
      expect(ClientAddressSchema.safeParse(address).success).toBe(false);
  });
});

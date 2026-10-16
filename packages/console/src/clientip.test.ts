import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { blockListOf, bucketOf, clientIp } from './clientip.js';

const req = (remote: string, headers: Record<string, string> = {}) =>
  ({ socket: { remoteAddress: remote }, headers }) as unknown as IncomingMessage;

describe('clientIp (ADR 620 decision 9)', () => {
  it('on Fly, believes cf-connecting-ip only when the peer Fly saw is Cloudflare', () => {
    const fly = { behindFlyProxy: true };
    expect(
      clientIp(
        req('172.16.0.2', { 'fly-client-ip': '162.158.10.1', 'cf-connecting-ip': '203.0.113.9' }),
        fly,
      ),
    ).toBe('203.0.113.9');
    expect(
      clientIp(
        req('172.16.0.2', { 'fly-client-ip': '2606:4700::1', 'cf-connecting-ip': '2001:db8::5' }),
        fly,
      ),
    ).toBe('2001:db8:0:0::/64');
  });

  it('a direct-to-origin sender is keyed by its own address, whatever it claims', () => {
    const fly = { behindFlyProxy: true };
    // Invented addresses cannot escape a limit, and a victim's address cannot be named.
    expect(
      clientIp(
        req('172.16.0.2', { 'fly-client-ip': '198.51.100.7', 'cf-connecting-ip': '203.0.113.9' }),
        fly,
      ),
    ).toBe('198.51.100.7');
    expect(
      clientIp(
        req('172.16.0.2', { 'fly-client-ip': '198.51.100.7', 'cf-connecting-ip': 'garbage' }),
        fly,
      ),
    ).toBe('198.51.100.7');
  });

  it('off Fly, neither header is believed from an untrusted peer', () => {
    const local = { behindFlyProxy: false };
    expect(
      clientIp(
        req('127.0.0.1', { 'fly-client-ip': '162.158.10.1', 'cf-connecting-ip': '203.0.113.9' }),
        local,
      ),
    ).toBe('127.0.0.1');
    expect(clientIp(req('::ffff:127.0.0.1'), local)).toBe('127.0.0.1');
  });

  it('a configured trusted proxy is believed (tests use the loopback)', () => {
    const o = { behindFlyProxy: false, trustedProxies: blockListOf(['127.0.0.1/32']) };
    expect(clientIp(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' }), o)).toBe(
      '203.0.113.9',
    );
  });

  it('counts an IPv6 sender by its /64, so rotating addresses inside it gains nothing', () => {
    expect(bucketOf('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(bucketOf('2001:db8:1:2::ffff')).toBe('2001:db8:1:2::/64');
    expect(bucketOf('2001:DB8:0001:0002:0:0:0:1')).toBe('2001:db8:1:2::/64');
    expect(bucketOf('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(bucketOf('203.0.113.9')).toBe('203.0.113.9');
    const fly = { behindFlyProxy: true };
    const a = clientIp(req('172.16.0.2', { 'fly-client-ip': '2001:db8:1:2::1' }), fly);
    const b = clientIp(req('172.16.0.2', { 'fly-client-ip': '2001:db8:1:2:dead:beef::9' }), fly);
    expect(a).toBe(b);
  });
});

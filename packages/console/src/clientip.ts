import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';

/**
 * The client a rate-limit bucket is keyed by (ADR 620 decision 9).
 *
 * A forwarded header is believed only from the hop that is supposed to set it. On Fly, every
 * request reaches the app through Fly's proxy, which sets `fly-client-ip` to the address it
 * accepted the connection from — the client cannot forge it. When THAT address is Cloudflare's
 * (its published ranges, pinned below), the request came through Cloudflare, which overwrites
 * `cf-connecting-ip` with the real visitor; only then is that header used. A request sent straight
 * to the Fly origin is keyed by its own address, whatever `cf-connecting-ip` it claims — so it can
 * neither escape its limit with invented addresses nor fill a victim's bucket by naming the
 * victim's address (security review of #2725, 2026-10-16; the first per-client version trusted the
 * header unconditionally and had both holes).
 *
 * Off Fly (tests, a laptop), `fly-client-ip` is not believed either: the socket's peer is the hop.
 */

/** https://www.cloudflare.com/ips-v4 and /ips-v6, fetched 2026-10-16. They change rarely;
 *  a stale list only makes Cloudflare traffic share Cloudflare-edge buckets, it never opens a hole. */
export const CLOUDFLARE_RANGES: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

export function blockListOf(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const c of cidrs) {
    const [net, bits] = c.split('/');
    const family = isIP(net!) === 6 ? 'ipv6' : 'ipv4';
    list.addSubnet(net!, Number(bits), family);
  }
  return list;
}

const CLOUDFLARE = blockListOf(CLOUDFLARE_RANGES);

export interface ClientIpOptions {
  /** True on Fly: believe `fly-client-ip` as the peer. */
  behindFlyProxy: boolean;
  /** The proxies whose `cf-connecting-ip` is believed. Default: Cloudflare's ranges. */
  trustedProxies?: BlockList;
}

function asIp(v: string | string[] | undefined): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^::ffff:/, '');
  return isIP(s) ? s : null;
}

function inList(list: BlockList, ip: string): boolean {
  return list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

export function clientIp(req: IncomingMessage, o: ClientIpOptions): string {
  const socketPeer = asIp(req.socket.remoteAddress) ?? 'unknown';
  const peer = (o.behindFlyProxy ? asIp(req.headers['fly-client-ip']) : null) ?? socketPeer;
  if (peer !== 'unknown' && inList(o.trustedProxies ?? CLOUDFLARE, peer)) {
    const visitor = asIp(req.headers['cf-connecting-ip']);
    if (visitor) return visitor;
  }
  return peer;
}

import type { IncomingMessage } from 'node:http';
import { isLocalPeer, type ResolvedConfig } from '../config.js';

/**
 * THE loopback-trust decision (spec §5.1). Every place the transports used to ask "is this caller
 * on this machine?" asks here instead, so cloud mode can answer once: no. Behind Cloudflare + Fly
 * every request arrives from the proxy, so a peer address proves nothing about who is calling, and
 * every privileged path must take an explicit credential. `loopbackAudit.test.ts` fails on any
 * other code that consults the peer address.
 */
export function trustsLocalPeer(
  ctx: { config: Pick<ResolvedConfig, 'mode' | 'trustProxy'> },
  req: Pick<IncomingMessage, 'socket'>,
): boolean {
  if (ctx.config.mode === 'cloud') return false;
  return isLocalPeer(req.socket.remoteAddress, ctx.config.trustProxy);
}

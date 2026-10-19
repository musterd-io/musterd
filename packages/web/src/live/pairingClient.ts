import { apiGet, LiveFetchError, type LiveConfig } from './client';

/**
 * The /live pairing client's wire half (ADR 618 §7). It lives beside the lazy PairingPanel —
 * not in `client.ts` — so the confirmation surface's bytes ride its own lazy chunk and /live's
 * eager graph pays nothing for a panel that renders only while a pairing is staged.
 */

/** A staged channel pairing as the daemon holds it — the /live confirmation view. */
export interface ChannelPairing {
  id: string;
  channel: string;
  check_code: string;
  state: string;
  provider_tenant_id: string | null;
  provider_user_id: string | null;
  expires_at: number;
  created_at: number;
}

async function channelPost<T>(cfg: LiveConfig, path: string): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.token}`, 'x-musterd-surface': 'web' },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new LiveFetchError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code ?? `http_${res.status}`,
      res.status,
    );
  }
  return json as T;
}

/** Pairings staged for this human's confirmation — tenant and user as the daemon holds them. */
export async function fetchChannelPairings(cfg: LiveConfig): Promise<ChannelPairing[]> {
  const out = await apiGet<{ pairings: ChannelPairing[] }>(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/channels/pairings`,
  );
  return out.pairings;
}

/** Confirm a staged pairing on /live (the original surface); creates the binding. */
export async function confirmChannelPairing(cfg: LiveConfig, pairingId: string): Promise<unknown> {
  return channelPost(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/channels/pairings/${encodeURIComponent(pairingId)}/confirm`,
  );
}

/** Reject a staged pairing on /live; binds nothing and spends the nonce. */
export async function rejectChannelPairing(cfg: LiveConfig, pairingId: string): Promise<unknown> {
  return channelPost(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/channels/pairings/${encodeURIComponent(pairingId)}/reject`,
  );
}

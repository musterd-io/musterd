import type { ApprovalProof, LastAskOutcome } from '@musterd/protocol';
import { apiGet, LiveFetchError, type LiveConfig } from './client';

/**
 * The /live pairing client's wire half (ADR 618 §7). It lives apart from `client.ts` so its bytes
 * ride a lazy chunk: the settings overlay imports it, and `usePendingPairings` imports it on first
 * use, so /live's eager graph pays nothing for a confirmation only a signed-in human ever sees.
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
  /** ADR 676 §5: an app pairing the phone has staged — its key, and what approving enrolls. */
  app?: {
    fingerprint: string;
    environment: string;
    device_name: string | null;
    enroll_payload: { action: 'enroll'; public_key: string; kind: 'phone' };
  } | null;
}

/** A started app pairing (ADR 676 §5): the QR payload, shown once, and the daemon's fingerprint. */
export interface AppPairingStart {
  pairing_id: string;
  qr: Record<string, unknown>;
  daemon_fingerprint: string;
  expires_at: number;
}

async function channelPost<T>(cfg: LiveConfig, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.token}`,
      'x-musterd-surface': 'web',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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

/**
 * Confirm a staged pairing on /live (the original surface); creates the binding. An app pairing
 * carries the passkey's `device_key_admin` proof over the phone key it enrolls (ADR 676 §5).
 */
export async function confirmChannelPairing(
  cfg: LiveConfig,
  pairingId: string,
  approval?: ApprovalProof,
): Promise<unknown> {
  return channelPost(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/channels/pairings/${encodeURIComponent(pairingId)}/confirm`,
    approval ? { approval } : undefined,
  );
}

/** Start an app pairing (ADR 676 §5): the same POST `musterd channels pair --channel app` makes. */
export async function startAppPairing(cfg: LiveConfig): Promise<AppPairingStart> {
  return channelPost(cfg, `/teams/${encodeURIComponent(cfg.team)}/channels/app/pairing`);
}

/** Per-human channel settings (away channels 6): nothing is on by default. */
export interface ChannelSettings {
  channel: string;
  deliver: boolean;
  answer: boolean;
  presenceGating: boolean;
  tierFloor: 'advisory' | 'standard' | 'blocking' | null;
  /** What became of the last ask routed here (lane 01M64DSKT3); absent from an older daemon. */
  lastAsk?: LastAskOutcome | null;
}

/** This human's channel settings, one row per channel with the defaults applied. */
export async function fetchChannelSettings(cfg: LiveConfig): Promise<ChannelSettings[]> {
  const out = await apiGet<{ settings: ChannelSettings[] }>(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/channels/settings`,
  );
  return out.settings;
}

/** Replace one channel's settings for this human. */
export async function saveChannelSettings(
  cfg: LiveConfig,
  settings: ChannelSettings,
): Promise<ChannelSettings> {
  const res = await fetch(
    `/teams/${encodeURIComponent(cfg.team)}/channels/settings/${encodeURIComponent(settings.channel)}`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'x-musterd-surface': 'web',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        deliver: settings.deliver,
        answer: settings.answer,
        presence_gating: settings.presenceGating,
        tier_floor: settings.tierFloor,
      }),
    },
  );
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
  return (json as { settings: ChannelSettings }).settings;
}

/** Reject a staged pairing on /live; binds nothing and spends the nonce. */
export async function rejectChannelPairing(cfg: LiveConfig, pairingId: string): Promise<unknown> {
  return channelPost(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/channels/pairings/${encodeURIComponent(pairingId)}/reject`,
  );
}

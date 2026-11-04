import { useEffect } from 'react';
import type { LiveConfig } from './client';
import { onPortrait } from './portraits';

/**
 * ADR 797: hand each member portrait this page paints to the daemon, so the phone's Seats screen can
 * show the same face. Once per member per picture per page; a refusal (an agent seat, a public
 * observer) or a failure is dropped silently — the phone keeps the member's letter.
 */
export function usePortraitUpload(cfg: LiveConfig | null): void {
  const team = cfg?.team;
  const token = cfg?.token;
  useEffect(() => {
    if (!team || !token) return;
    const sent = new Map<string, string>();
    return onPortrait((name, url) => {
      if (sent.get(name) === url) return;
      const comma = url.indexOf(',');
      if (!url.startsWith('data:image/png;base64,') || comma < 0) return;
      sent.set(name, url);
      const png = url
        .slice(comma + 1)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      void fetch(
        `/teams/${encodeURIComponent(team)}/members/${encodeURIComponent(name)}/portrait`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${token}`,
            'x-musterd-surface': 'web',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ png }),
        },
      ).catch(() => {});
    });
  }, [team, token]);
}

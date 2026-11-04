import { onPortrait } from './portraits';

/**
 * ADR 797: hand each member portrait this page paints to the daemon, so the phone's Seats screen can
 * show the same face. Once per member per picture per page; a refusal (an agent seat, a public
 * observer) or a failure is dropped silently — the phone keeps the member's letter. Loaded lazily by
 * /live, so it costs the first paint nothing. Answers the stop.
 */
export function startPortraitUpload(team: string, token: string): () => void {
  const sent = new Map<string, string>();
  return onPortrait((name, url) => {
    if (sent.get(name) === url) return;
    const prefix = 'data:image/png;base64,';
    if (!url.startsWith(prefix)) return;
    sent.set(name, url);
    const png = url
      .slice(prefix.length)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    void fetch(`/teams/${encodeURIComponent(team)}/members/${encodeURIComponent(name)}/portrait`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'x-musterd-surface': 'web',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ png }),
    }).catch(() => {});
  });
}

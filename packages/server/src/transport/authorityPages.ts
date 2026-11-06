/**
 * ADR 662 decision 5: the passkey surfaces live on the daemon's own origin — never the
 * relay (ADR 618 §2). Two small pages, no assets: enroll a passkey with a one-time code,
 * and approve one descriptor. Both render only what the server hands them; the human's
 * browser does the WebAuthn ceremony and the server verifies every byte of it.
 */

const shell = (title: string, body: string, script: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} — musterd</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 34rem; padding: 0 1rem; }
  label { display: block; margin: 0.75rem 0 0.25rem; font-weight: 600; }
  input { width: 100%; padding: 0.5rem; box-sizing: border-box; }
  button { margin-top: 1rem; padding: 0.6rem 1.2rem; min-height: 44px; }
  pre { background: #f4f1ea; padding: 1rem; white-space: pre-wrap; word-break: break-word; }
  .err { color: #b3261e; }
</style></head><body>
<h1>${title}</h1>
${body}
<p id="out" role="status"></p>
<script>
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const params = new URLSearchParams(location.search);
// WebAuthn exists only on a secure context (https, or localhost). On a plain-http hub address the
// old page died with "Cannot read properties of undefined (reading 'get')" (nick, 2026-11-05):
// say why, point at the hub's https origin from /health, and keep every button off. On an
// insecure origin out() shows the guidance and nothing else, so a later descriptor error or an
// empty passkey list cannot overwrite it whichever response lands first (big-body's read).
const insecure = !(window.isSecureContext && navigator.credentials && typeof navigator.credentials.get === 'function');
let secureOrigin = '';
const guidance = () => 'Passkeys only work on https or localhost, and this page is on ' + location.origin + '. ' +
  (secureOrigin ? 'Open the same link here instead: ' + secureOrigin + location.pathname + location.search + location.hash
                : "Open the same link on the hub's https address, or on http://localhost.");
const out = (msg, err) => {
  const el = document.getElementById('out');
  if (insecure) { msg = guidance(); err = true; }
  el.textContent = msg; el.className = err ? 'err' : '';
};
if (insecure) {
  out();
  for (const b of document.querySelectorAll('button')) b.disabled = true;
  (async () => {
    try {
      const j = await (await fetch('/health')).json();
      if (typeof j.browser_origin === 'string' && j.browser_origin.startsWith('https://')) secureOrigin = j.browser_origin;
    } catch {}
    out();
  })();
}
${script}
</script></body></html>`;

export const passkeyEnrollPage = shell(
  'Enroll a passkey',
  `<p>Bind a passkey to your human authority on this team. Open this page from
<code>musterd authority enroll</code> — its link carries the one-time ceremony
challenge (ten minutes). The ceremony asks your authenticator to verify it's you.</p>
<label for="team">Team</label><input id="team" autocomplete="off">
<label for="member">Your member name</label><input id="member" autocomplete="off">
<button id="go">Enroll this passkey</button>`,
  `
document.getElementById('team').value = params.get('team') || '';
document.getElementById('member').value = params.get('member') || '';
document.getElementById('go').addEventListener('click', async () => {
  if (insecure) return;
  const team = document.getElementById('team').value.trim();
  const member = document.getElementById('member').value.trim();
  const challenge = params.get('challenge') || '';
  const frag = new URLSearchParams(location.hash.slice(1));
  let approval;
  try { approval = frag.get('approval') ? JSON.parse(new TextDecoder().decode(unb64u(frag.get('approval')))) : undefined; } catch { approval = undefined; }
  let countersign;
  try { countersign = frag.get('countersign') ? JSON.parse(new TextDecoder().decode(unb64u(frag.get('countersign')))) : undefined; } catch { countersign = undefined; }
  try {
    out('Waiting for your passkey…');
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: unb64u(challenge),
      rp: { name: 'musterd' },
      user: { id: new TextEncoder().encode(member), name: member, displayName: member },
      pubKeyCredParams: [{ type: 'public-key', alg: -8 }, { type: 'public-key', alg: -7 }],
      authenticatorSelection: { userVerification: 'required' },
      timeout: 120000,
    }});
    const res = await fetch('/teams/' + encodeURIComponent(team) + '/authority/passkeys', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: member, challenge, ...(approval ? { approval } : {}), ...(countersign ? { countersign } : {}), registration: {
        attestation_object: b64u(cred.response.attestationObject),
        client_data_json: new TextDecoder().decode(cred.response.clientDataJSON),
      }}),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error((json && json.error && json.error.message) || ('HTTP ' + res.status));
    out('Enrolled. Key ' + json.key.id + ' — high-authority acts now ask this passkey.');
  } catch (e) { out(String(e && e.message || e), true); }
});
`,
);

export const passkeyApprovePage = shell(
  'Approve',
  `<p>This page shows exactly what the server built for your approval — nothing here was
worded by whoever asked. Approve only if it is the act you intend.</p>
<pre id="descriptor">Loading…</pre>
<button id="go" disabled>Approve with passkey</button>`,
  `
const team = params.get('team') || '';
const nonce = params.get('nonce') || '';
let descriptor = null; let passkeys = [];
(async () => {
  try {
    const res = await fetch('/teams/' + encodeURIComponent(team) + '/authority/descriptors/' + encodeURIComponent(nonce));
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error((json && json.error && json.error.message) || ('HTTP ' + res.status));
    descriptor = json.descriptor; passkeys = json.passkeys || [];
    document.getElementById('descriptor').textContent =
      'actor:  ' + descriptor.actor + '\\nact:    ' + descriptor.act + '\\ntarget: ' + descriptor.target +
      '\\nexpires: ' + new Date(descriptor.expiry).toISOString();
    document.getElementById('go').disabled = insecure || passkeys.length === 0;
    if (passkeys.length === 0) out('No passkey is enrolled for ' + descriptor.actor + ' on this team.', true);
  } catch (e) { out(String(e && e.message || e), true); }
})();
document.getElementById('go').addEventListener('click', async () => {
  if (insecure) return;
  try {
    out('Waiting for your passkey…');
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: unb64u(nonce),
      allowCredentials: passkeys.map((k) => ({ type: 'public-key', id: unb64u(k.credential_id) })),
      timeout: 120000,
    }});
    const credId = b64u(cred.rawId);
    const mine = passkeys.find((k) => k.credential_id === credId);
    if (!mine) throw new Error('that passkey is not enrolled for this act');
    const res = await fetch('/teams/' + encodeURIComponent(team) + '/authority/approvals', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key_id: mine.key_id, nonce, signature: b64u(cred.response.signature),
        authenticator_data: b64u(cred.response.authenticatorData),
        client_data_json: new TextDecoder().decode(cred.response.clientDataJSON) }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error((json && json.error && json.error.message) || ('HTTP ' + res.status));
    out('Approved. You can return to the terminal.');
  } catch (e) { out(String(e && e.message || e), true); }
});
`,
);

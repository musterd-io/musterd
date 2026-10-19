import { ACCOUNTS } from './catalog.js';
import { escapeHtml, fillPercent, isLow, readAtSentence, windowSentence } from './format.js';
import type { Board, ProviderCard, Window } from './types.js';

function meter(window: Window, now: number, timeZone: string, lead: boolean): string {
  const percent = fillPercent(window.used, window.limit);
  const low = isLow(window.used, window.limit);
  const sentence = windowSentence(
    window.used,
    window.limit,
    window.unit,
    window.resetsAt,
    now,
    timeZone,
    window.label,
  );
  const flag = window.used > window.limit ? 'Over the window' : low ? 'Running low' : '';
  const text = `${sentence.replace(/\.$/, '')}. ${window.used} of ${window.limit} ${window.unit} used.`;
  const klass = lead ? 'lead' : 'more';
  const flagHtml = flag === '' ? '' : `<p class="flag">${flag}</p>`;
  return `<p class="${klass}">${escapeHtml(sentence)}</p>${flagHtml}<div class="meter${low ? ' low' : ''}" role="meter" aria-valuemin="0" aria-valuemax="${window.limit}" aria-valuenow="${window.used}" aria-valuetext="${escapeHtml(text)}"><span class="meter-fill p${percent}"></span></div>`;
}

function card(provider: ProviderCard, now: number, timeZone: string): string {
  if (provider.state !== 'live') {
    return `<article class="card"><h2>${escapeHtml(provider.name)}</h2><p class="lead">${escapeHtml(provider.reason)}</p></article>`;
  }
  const detail =
    provider.detail === null ? '' : `<p class="detail">${escapeHtml(provider.detail)}</p>`;
  const windows = provider.windows
    .map((window, index) => meter(window, now, timeZone, index === 0))
    .join('');
  return `<article class="card"><h2>${escapeHtml(provider.name)}</h2>${detail}${windows}</article>`;
}

function chooser(chosen: readonly string[]): string {
  const on = new Set(chosen);
  const boxes = ACCOUNTS.map((account) => {
    const checked = on.has(account.id) ? ' checked' : '';
    return `<label class="account"><input type="checkbox" name="account" value="${escapeHtml(account.id)}"${checked}>${escapeHtml(account.name)}</label>`;
  }).join('');
  return `<form method="post" action="/accounts"><fieldset class="accounts"><legend>Accounts on this page</legend>${boxes}<button class="save" type="submit">Save</button></fieldset></form>`;
}

/** The page. Every string from a provider is escaped. Nothing on the board is a key. */
export function renderPage(board: Board): string {
  const cards =
    board.providers.length === 0
      ? '<p class="empty">Nothing on this page yet.</p>'
      : board.providers.map((provider) => card(provider, board.readAt, board.timeZone)).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>what's left</title>
<link rel="stylesheet" href="/allowance.css">
</head>
<body>
<main class="page">
<p class="mark">musterd</p>
<h1>what's left</h1>
<p class="lede">On this machine. A sign-in never leaves it.</p>
${cards}
${chooser(board.chosen)}
<footer class="foot">
<p class="when">${escapeHtml(readAtSentence(board.readAt, board.timeZone))}</p>
<a class="refresh" href="/">Refresh</a>
</footer>
</main>
</body>
</html>
`;
}

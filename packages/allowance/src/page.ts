import { ACCOUNTS } from './catalog.js';
import { escapeHtml, fillPercent, isLow, readAtSentence, windowSentence } from './format.js';
import type { Board, HeldProvider, LiveProvider, QuietProvider, Window } from './types.js';

function meter(window: Window, now: number, timeZone: string): string {
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
  const flagHtml = flag === '' ? '' : `<p class="flag">${flag}</p>`;
  return `<div class="win"><p class="line">${escapeHtml(sentence)}</p><div class="meter${low ? ' low' : ''}" role="meter" aria-valuemin="0" aria-valuemax="${window.limit}" aria-valuenow="${window.used}" aria-valuetext="${escapeHtml(text)}"><span class="meter-fill p${percent}"></span></div>${flagHtml}</div>`;
}

function card(provider: LiveProvider, now: number, timeZone: string): string {
  const detail =
    provider.detail === null ? '' : `<p class="detail">${escapeHtml(provider.detail)}</p>`;
  const windows = provider.windows.map((window) => meter(window, now, timeZone)).join('');
  return `<article class="card"><div class="card-head"><h2>${escapeHtml(provider.name)}</h2>${detail}</div>${windows}</article>`;
}

function quietRow(provider: HeldProvider | QuietProvider): string {
  return `<li><span class="name">${escapeHtml(provider.name)}</span><span class="reason">${escapeHtml(provider.reason)}</span></li>`;
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
  const live = board.providers.filter((provider) => provider.state === 'live');
  const quiet = board.providers.filter((provider) => provider.state !== 'live');
  const boardHtml =
    live.length === 0
      ? ''
      : `<div class="board">${live.map((provider) => card(provider, board.readAt, board.timeZone)).join('')}</div>`;
  const quietHtml =
    quiet.length === 0
      ? ''
      : `<ul class="quiet">${quiet.map((provider) => quietRow(provider)).join('')}</ul>`;
  const empty =
    board.providers.length === 0 ? '<p class="empty">Nothing on this page yet.</p>' : '';
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
<header class="top">
<p class="mark">musterd</p>
<h1>what's left</h1>
<p class="lede">On this machine. A sign-in never leaves it.</p>
<p class="when">${escapeHtml(readAtSentence(board.readAt, board.timeZone))}</p>
<a class="refresh" href="/">Refresh</a>
</header>
${empty}${boardHtml}${quietHtml}
${chooser(board.chosen)}
</main>
</body>
</html>
`;
}

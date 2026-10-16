#!/usr/bin/env node
/**
 * The /live lane picker, driven by the keyboard alone (lane 01M5162T6H, musterd pick spec §7: "an
 * overlay test inside the a11y sweep — keyboard-only pick, focus trap, esc").
 *
 *     node scripts/a11y/pick-keyboard.mjs '<base>/live?team=<slug>&pick=<seat>&still'
 *
 * Run by `contrast-gate.mjs`'s connected phase, on the same fixture team and the same signed-in
 * fixture identity (`A11Y_CONNECTED_MEMBER_IDENTITY_FILE`), as its LAST pass: the final step really
 * picks a lane, which changes the fixture's board. Real key events through CDP
 * (`Input.dispatchKeyEvent`), never synthetic DOM events, so it exercises what a keyboard does.
 *
 * Checks, in order:
 *   1. focus opens in the filter;
 *   2. Tab and Shift+Tab keep focus inside the dialog, all the way round (the focus trap);
 *   3. ↓ moves the highlight (the filter's aria-activedescendant changes);
 *   4. Esc closes the picker and drops `?pick` from the address;
 *   5. reopened, ⏎ picks the highlighted lane and the picker says so.
 *
 * Exit 0: all held. Exit 1: a check failed (named on stderr). Exit 2: the harness failed and nothing
 * was concluded (chrome.mjs's convention).
 */
import { readFileSync } from 'node:fs';
import { openChromePage } from './chrome.mjs';

const url = process.argv[2];
if (!url) {
  console.error('pick-keyboard — usage: pick-keyboard.mjs <url with ?team=…&pick=…>');
  process.exit(2);
}

const { send, exit } = await openChromePage({ tool: 'pick-keyboard', verdictNoun: 'keyboard' });

const identityFile = process.env['A11Y_CONNECTED_MEMBER_IDENTITY_FILE'];
if (identityFile) {
  const team = new URL(url).searchParams.get('team');
  const identity = JSON.parse(readFileSync(identityFile, 'utf8'));
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source:
      'try { localStorage.setItem(' +
      JSON.stringify(`musterd.member.v1.${team}`) +
      ', ' +
      JSON.stringify(JSON.stringify({ as: identity.as, token: identity.token })) +
      '); } catch {}',
  });
}
await send('Runtime.enable').catch(() => {});

const evalIn = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'evaluate failed');
  return result.value;
};

const KEYS = {
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
};
const press = async (key, shift = false) => {
  const k = KEYS[key];
  const base = { key, ...k, modifiers: shift ? 8 : 0 };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await new Promise((r) => setTimeout(r, 60));
};

/** Wait for an in-page condition, or fail the harness: a picker that never opened proves nothing. */
const waitFor = async (expression, what, ms = 20_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await evalIn(expression)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.error(`pick-keyboard — ${what} never happened on ${url}; nothing was concluded.`);
  await exit(2);
};

const failures = [];
const check = (ok, what) => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failures.push(what);
};

await send('Page.navigate', { url });
await waitFor(`!!document.querySelector('.pick__row')`, 'the picker listing lanes');

// 1. focus opens in the filter
check(
  await evalIn(`document.activeElement?.classList.contains('pick__filter') ?? false`),
  'focus opens in the filter',
);

// 2. the focus trap, both directions, all the way round
const focusables = await evalIn(
  `document.querySelectorAll('.pick__panel button:not([disabled]), .pick__panel input').length`,
);
let escaped = false;
for (let i = 0; i < focusables + 2; i++) {
  await press('Tab');
  if (!(await evalIn(`!!document.activeElement?.closest('.pick__panel')`))) escaped = true;
}
for (let i = 0; i < focusables + 2; i++) {
  await press('Tab', true);
  if (!(await evalIn(`!!document.activeElement?.closest('.pick__panel')`))) escaped = true;
}
check(!escaped, `Tab and Shift+Tab stay inside the dialog (${focusables} stops, round twice)`);

// 3. ↓ moves the highlight
await evalIn(`document.querySelector('.pick__filter').focus(), true`);
const before = await evalIn(
  `document.querySelector('.pick__filter').getAttribute('aria-activedescendant')`,
);
await press('ArrowDown');
const after = await evalIn(
  `document.querySelector('.pick__filter').getAttribute('aria-activedescendant')`,
);
const rows = await evalIn(`document.querySelectorAll('.pick__row').length`);
check(rows < 2 || (before !== after && after !== null), '↓ moves the highlighted option');

// 4. Esc closes and drops ?pick
await press('Escape');
await new Promise((r) => setTimeout(r, 300));
check(
  await evalIn(
    `!document.querySelector('.pick') && !new URL(location.href).searchParams.has('pick')`,
  ),
  'Esc closes the picker and drops ?pick',
);

// 5. a keyboard-only pick
await send('Page.navigate', { url });
await waitFor(`!!document.querySelector('.pick__row')`, 'the picker reopening');
await press('Enter');
await waitFor(
  `!!document.querySelector('.pick__done') || !!document.querySelector('.pick__note')`,
  'the pick being answered',
);
check(await evalIn(`!!document.querySelector('.pick__done')`), '⏎ picks the highlighted lane');

if (failures.length) {
  console.error(
    `pick-keyboard — ${failures.length} check(s) failed on ${url}: ${failures.join('; ')}`,
  );
  await exit(1);
}
console.log('pick-keyboard — keyboard-only pick, focus trap and Esc all hold');
await exit(0);

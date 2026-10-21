import { describe, expect, it } from 'vitest';
import { openBrowser, startupText } from './launch.js';

describe('startup', () => {
  it('says the page is open and that the window has to stay open', () => {
    const url = 'http://127.0.0.1:4877';
    expect(startupText(url, true)).toBe(
      "what's left is open at http://127.0.0.1:4877\nLeave this window open. Ctrl-C stops it.\n",
    );
    expect(startupText(url, false)).toBe(
      "what's left is at http://127.0.0.1:4877\nOpen that address in a browser on this computer.\nLeave this window open. Ctrl-C stops it.\n",
    );
  });

  it('does not open a browser when stdout is not a terminal', async () => {
    expect(await openBrowser('http://127.0.0.1:9', false)).toBe(false);
  });
});

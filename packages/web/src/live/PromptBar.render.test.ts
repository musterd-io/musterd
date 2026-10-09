import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PromptBar } from './PromptBar';

const html = renderToStaticMarkup(
  createElement(PromptBar, {
    cfg: { team: 'revive', as: 'nick', token: 'mscr_x' },
    onSent: () => {},
  }),
);

describe('PromptBar', () => {
  it('speaks the copy verbatim and nothing about huddles or acts', () => {
    expect(html).toContain('placeholder="Ask the team something real"');
    expect(html).toContain('Send to the team');
    expect(html).toContain('Who hears it');
    expect(html).not.toMatch(/huddle|envelope|\bact\b/i);
  });

  it('starts with all four of the cast on, and Send disabled until there is text', () => {
    for (const name of ['dolly', 'big-body', 'ghost', 'wanderer'])
      expect(html).toContain(`aria-pressed="true">${name}<`);
    expect(html).toMatch(/<button[^>]*class="pbar__send"[^>]*disabled=""/);
  });
});

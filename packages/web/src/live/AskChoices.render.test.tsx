import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AskChoices } from './AskChoices';

const choices = {
  options: [
    { key: 'A', text: 'Keep this as is and state it.' },
    { key: 'B', text: 'Block unpriced harnesses whenever a cap is set.' },
    { key: 'C', text: 'Add a separate key, unpriced_wake_cap, a count over 7 days on the same deny path.' },
  ],
  recommended: 'C',
};

describe('AskChoices — a choice is answered by picking an option (lane 01M511XNQC)', () => {
  const html = renderToStaticMarkup(
    <AskChoices choices={choices} asker="mason" busy={false} onPick={() => {}} onNone={() => {}} />,
  );

  it('shows every option in full, each as its own button', () => {
    for (const o of choices.options) expect(html).toContain(o.text);
    expect(html.match(/class="lc-choice[ "]/g)).toHaveLength(3);
  });

  it('tags the asker’s recommendation without picking it', () => {
    expect(html).toContain('mason recommends');
    expect(html).not.toContain('aria-pressed="true"');
  });

  it('offers "None of these" and never a bare Approve', () => {
    expect(html).toContain('None of these');
    expect(html).not.toContain('Approve');
  });

  it('is a labelled group a keyboard and a screen reader can find', () => {
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="mason’s options"');
  });
});

import { laneChain } from '@musterd/protocol/wire';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LaneChainList } from './Board';

describe('LaneChainList', () => {
  it('renders the five links with the same words as the CLI', () => {
    const links = laneChain(
      {
        owner_seat: 'TJ',
        requested: { by: 'big-body', basis: 'stated' },
        merged: { authorized_by: 'nick' },
      },
      [{ action: 'lane.closed', actor: 'schmidt', verified: true, model: 'grok-4', model_source: 'observed' }],
    );
    const html = renderToStaticMarkup(createElement(LaneChainList, { links }));
    expect(html).toContain('asked');
    expect(html).toContain('big-body');
    expect(html).toContain('stated');
    expect(html).toContain('claimed');
    expect(html).toContain('TJ');
    expect(html).toContain('verified');
    expect(html).toContain('grok-4');
    expect(html).toContain('schmidt');
    expect(html).toContain('nick');
    expect(html).not.toContain('undefined');
  });
});

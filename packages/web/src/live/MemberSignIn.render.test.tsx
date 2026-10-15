import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MemberSignInToggle } from './MemberSignIn';

const open = { open: true, as: '', token: '' };
const closed = { open: false, as: '', token: '' };
const noop = () => {};

/**
 * Since ADR 580 a signed-out page cannot mint a watching seat. With none saved, "Just watch instead"
 * closed the sign-in fields onto a "Watch live" button that only reopened them — a loop with no exit
 * (fifty's acceptance note on lane 01M4YDJK1N). The way back to watching is offered only when there
 * is a seat to watch with.
 */
describe('MemberSignInToggle', () => {
  it('offers the way back to watching when this browser has a seat to watch with', () => {
    const html = renderToStaticMarkup(
      <MemberSignInToggle advanced={open} onAdvanced={noop} closeLabel="Just watch instead" />,
    );
    expect(html).toContain('Just watch instead');
  });

  it('offers nothing while signing in is the only way in', () => {
    const html = renderToStaticMarkup(
      <MemberSignInToggle
        advanced={open}
        onAdvanced={noop}
        closeLabel="Just watch instead"
        canWatch={false}
      />,
    );
    expect(html).toBe('');
  });

  it('still offers signing in when the fields are closed', () => {
    const html = renderToStaticMarkup(
      <MemberSignInToggle
        advanced={closed}
        onAdvanced={noop}
        openLabel="Sign in as yourself"
        canWatch={false}
      />,
    );
    expect(html).toContain('Sign in as yourself');
  });
});

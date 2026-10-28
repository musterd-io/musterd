import { describe, expect, it } from 'vitest';
import { PolicyOverrideSchema, PolicySchema } from './credentials.js';
import { WIKI_DEFAULT_PATH, WikiSourceSchema, wikiPathProblem, wikiRepoProblem } from './wiki.js';

describe('wiki source (ADR 747)', () => {
  it('accepts https, ssh and scp-form git URLs', () => {
    for (const url of [
      'https://github.com/musterd-io/musterd',
      'https://gitlab.example.com:8443/acme/app.git',
      'ssh://git@github.com/acme/app.git',
      'git@github.com:acme/app.git',
    ]) {
      expect(wikiRepoProblem(url), url).toBeNull();
    }
  });

  it('refuses URLs that reach the daemon disk, run a command or read as an option', () => {
    for (const url of [
      'file:///etc',
      '/Users/me/repo',
      '../repo',
      'ext::sh -c touch% /tmp/x',
      '--upload-pack=touch /tmp/x',
      'http://github.com/acme/app',
      'https://github.com',
      'git@github.com://acme',
      '',
    ]) {
      expect(wikiRepoProblem(url), url).not.toBeNull();
    }
  });

  it('keeps the folder inside the repo', () => {
    expect(wikiPathProblem('docs/wiki')).toBeNull();
    expect(wikiPathProblem('')).toBeNull();
    expect(wikiPathProblem('/etc')).not.toBeNull();
    expect(wikiPathProblem('docs/../../x')).not.toBeNull();
  });

  it('defaults the folder to docs/wiki and tidies a trailing slash', () => {
    expect(WikiSourceSchema.parse({ repo: 'https://github.com/a/b' }).path).toBe(WIKI_DEFAULT_PATH);
    expect(WikiSourceSchema.parse({ repo: 'https://github.com/a/b', path: './kb/' }).path).toBe(
      'kb',
    );
  });

  it('is absent from a policy that never set it, and parses on the stored doc', () => {
    expect(PolicySchema.parse({}).wiki).toBeUndefined();
    expect(PolicyOverrideSchema.parse({ wiki: { repo: 'https://github.com/a/b' } }).wiki).toEqual({
      repo: 'https://github.com/a/b',
      path: 'docs/wiki',
    });
    expect(() => PolicyOverrideSchema.parse({ wiki: { repo: 'file:///etc' } })).toThrow(
      /wiki repo/,
    );
  });
});

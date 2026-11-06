import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Build 58 (2026-11-06) opened on "Unmatched Route": the Now screen had moved to
 * app/(tabs)/now.tsx, and a route group — a folder in parentheses — leaves the URL alone, so that
 * file served /now and nothing served "/", the URL the app opens at. CI never opens the app, so
 * nothing caught it. This reads the routes the way expo-router does: strip groups, drop
 * `_layout` and `+` files, and turn `index` into its folder's path.
 */
const appDir = fileURLToPath(new URL('../app', import.meta.url));

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? routeFiles(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

function urlOf(file: string): string | null {
  const parts = relative(appDir, file)
    .replace(/\.tsx?$/, '')
    .split(sep)
    .filter((p) => !/^\(.*\)$/.test(p));
  const last = parts[parts.length - 1] ?? '';
  if (last === '_layout' || last.startsWith('+') || last.endsWith('.test')) return null;
  if (last === 'index') parts.pop();
  return `/${parts.join('/')}`;
}

describe('the app’s routes', () => {
  const urls = routeFiles(appDir)
    .map(urlOf)
    .filter((u): u is string => u !== null);

  it('serves "/", the URL the app opens at', () => {
    expect(urls).toContain('/');
  });

  it('keeps the routes a notification and pairing push to', () => {
    expect(urls).toEqual(expect.arrayContaining(['/ask/[ref]', '/pair', '/poll']));
  });

  it('has no two files serving one URL', () => {
    expect(urls.length).toBe(new Set(urls).size);
  });
});

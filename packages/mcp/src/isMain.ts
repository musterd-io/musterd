import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Was this module the one Node was launched with, as opposed to being imported?
 *
 * Both sides are resolved to their real paths before comparing. Node resolves a module's own path
 * for `import.meta.url`, but `process.argv[1]` keeps the path the process was started with, and
 * that is a symlink whenever the adapter runs through a package-manager bin (`npm i -g`'s
 * `bin/musterd-mcp`, `npx`'s `.bin/musterd-mcp`). Comparing the raw strings made the adapter exit 0
 * without starting in exactly those installs (lane 01M5BA7C3H).
 */
export function isMainModule(
  metaUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

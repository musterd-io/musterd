import { spawn } from 'node:child_process';

export function startupText(url: string, opened: boolean): string {
  const stay = 'Leave this window open. Ctrl-C stops it.\n';
  if (opened) return `what's left is open at ${url}\n${stay}`;
  return `what's left is at ${url}\nOpen that address in a browser on this computer.\n${stay}`;
}

/** Open the page when stdout is a terminal. A pipe, a test, or a failure leaves it to the reader. */
export function openBrowser(url: string, tty = Boolean(process.stdout.isTTY)): Promise<boolean> {
  if (!tty) return Promise.resolve(false);
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  // cmd's start treats the first quoted argument as a window title.
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.unref();
    const timer = setTimeout(() => resolve(false), 1500);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

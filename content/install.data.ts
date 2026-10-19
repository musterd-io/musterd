/**
 * How a stranger installs musterd — the single source every surface renders from (ADR 669 §3.3,
 * spec docs/superpowers/specs/2026-10-19-publish-launch-train-design.md). Before it, four surfaces
 * gave four commands: the README led with `brew tap … && brew install`, then `pnpm add -g`, then
 * `npx @musterd/cli init`; the site led with `npm install -g`; and the README's by-hand block still
 * showed a flow 0.5.0 refuses. A stranger reading two of them met a contradiction in the first
 * minute.
 *
 * Commands are engineering's (each must run on a clean machine — car 0 of the release train); every
 * string is sloane's (product-communications, lane 01M5AXB5NZ). Two routes only, as ADR 568 gives
 * them: npm, and the Homebrew tap's npm-wrapper formula. No `npx`: it leaves no `musterd` on PATH,
 * so step 3's `musterd tour` would fail. The site names no harness (nick, #2405).
 *
 * Import-free on purpose: the web build copies it verbatim at build-prep
 * (packages/web/scripts/gen-site-content.ts), and `pnpm install:gen` renders the README block from
 * it. `install.data.test.ts` fails when any surface carries a different command.
 */
export interface InstallStep {
  title: string;
  body: string | null;
  commands: readonly string[];
}

export interface InstallAlternative {
  lead: string;
  command: string;
}

export const INSTALL_PRIMARY = 'npm install -g @musterd/cli';

export const INSTALL = {
  requires: 'You need Node 22 or later, and an agent tool you already use.',
  primary: INSTALL_PRIMARY,
  alternatives: [
    { lead: 'Or with Homebrew:', command: 'brew install SandRiseStudio/musterd/musterd' },
  ] as readonly InstallAlternative[],
  steps: [
    { title: 'Install the command line tool.', body: null, commands: [INSTALL_PRIMARY] },
    {
      title: 'Run it in your project’s folder.',
      body: 'It starts musterd on your machine, creates your team, finds the agent tools you already use, and asks before it connects them.',
      commands: ['cd your-project', 'musterd init'],
    },
    {
      title: 'Start a chat with your agent there, then take the tour.',
      body: 'Your agent joins the team and shows up online. The tour gives it a small piece of work; you judge what comes back and read the record it leaves.',
      commands: ['musterd tour'],
    },
  ] as readonly InstallStep[],
} as const;

/**
 * Commands that must never appear on a public surface again — each one a route ADR 568 retired or
 * a flow the shipped CLI refuses. The agreement test greps every surface for them.
 */
export const RETIRED_INSTALL_COMMANDS = [
  'npx @musterd/cli',
  'brew tap SandRiseStudio/musterd',
  'pnpm add -g @musterd/cli',
] as const;

/** The install as one shell block, for markdown surfaces (README, the launch post). */
export function installShellBlock(): string {
  const lines: string[] = [];
  INSTALL.steps.forEach((step, i) => {
    if (i > 0) lines.push('');
    lines.push(...step.commands);
    if (i === 0) {
      for (const alt of INSTALL.alternatives) lines.push(`# ${alt.lead} ${alt.command}`);
    }
  });
  return ['```bash', ...lines, '```'].join('\n');
}

/** The README's install section body: the requirement, then the block. */
export function installMarkdown(): string {
  return `${INSTALL.requires}\n\n${installShellBlock()}`;
}

/**
 * The built-in toolkit library — a *seed of examples, not a catalog* (ADR 028,
 * provisioning-recipe.md §3; "role templates" pre-ADR-272-rename). musterd ships a small set of
 * archetypes to teach the toolkit shape and give a one-command start; users author their own in
 * `.musterd/toolkits/*.json` (legacy `.musterd/profiles/` and `.musterd/roles/` files still load).
 *
 * These are expressed in-source as raw data (validated through the same schema as user files by
 * {@link import('../toolkit.js').parseToolkit}) rather than shipped as JSON assets: the package
 * builds with plain `tsc`, which does not copy non-TS files into `dist/`, so file-based built-ins
 * would need a bundler/copy step — a new build dependency we decline (ADR 029). User-authored
 * toolkits remain JSON. `musterd toolkit create` round-tripping a built-in into an editable
 * `.musterd/toolkits/<name>.json` is the bridge (recipe "Settled vs open").
 *
 * Charters stay lens-not-résumé and minimal. MCP entries are *referenced, not owned* — musterd
 * points at ecosystem servers (npx-launched) and never hosts or version-manages them. Secrets are
 * `${ENV}` references, never inline. `generalist` gets nothing extra.
 *
 * Exported as raw `unknown` (not yet parsed) so this module has no import cycle with `toolkit.ts`,
 * which validates these into the typed `BUILTIN_TOOLKITS` map at its own module-eval time.
 */
export const BUILTIN_TOOLKIT_TEMPLATES: Record<string, unknown> = {
  generalist: {
    toolkit: 'generalist',
    charter:
      'General contributor. Pick up work across the codebase; coordinate through the team acts.',
    // Nothing extra — only the musterd server + this bare charter (ADR 028).
  },

  reviewer: {
    toolkit: 'reviewer',
    charter: [
      'Review teammates’ changes for correctness and clarity. Read widely; edit narrowly.',
      'Claim the review as a lane; resolve the thread once the change lands.',
    ],
    tools: {
      resource_scopes: ['**'],
      // ADR 261: canonical Claude Code rule syntax — the historical lowercase forms ('read',
      // 'bash(git diff*)') matched nothing, so this role's quasi-ceiling was inert until now.
      permissions: {
        allow: ['Read', 'Bash(git diff *)', 'Bash(git log *)'],
        ask: ['Edit', 'Bash'],
      },
    },
  },

  backend: {
    toolkit: 'backend',
    capacity: 2,
    charter: [
      'Own the server + data layer. Small, tested changes.',
      'Work in a claimed lane; request_help when blocked; resolve threads you finish.',
    ],
    tools: {
      resource_scopes: ['packages/server/**', 'packages/protocol/**'],
      mcp_servers: [
        {
          name: 'supabase',
          command: 'npx',
          args: ['-y', '@supabase/mcp-server-supabase@latest'],
          env: { SUPABASE_ACCESS_TOKEN: '${SUPABASE_ACCESS_TOKEN}' },
        },
      ],
      permissions: { allow: ['Edit', 'Read', 'Bash(pnpm test*)'], ask: ['Bash'] }, // ADR 261 canonical syntax
    },
  },

  frontend: {
    toolkit: 'frontend',
    capacity: 2,
    charter: [
      'Own the UI layer. Keep components small and accessible; match the existing design system.',
      'Work in a claimed lane; hand off cleanly; resolve threads you finish.',
    ],
    tools: {
      resource_scopes: ['packages/web/**', 'packages/ui/**'],
      mcp_servers: [
        {
          name: 'figma',
          command: 'npx',
          args: ['-y', 'figma-developer-mcp', '--stdio'],
          env: { FIGMA_API_KEY: '${FIGMA_API_KEY}' },
        },
      ],
      permissions: { allow: ['Edit', 'Read', 'Bash(pnpm test*)'], ask: ['Bash'] }, // ADR 261 canonical syntax
    },
  },

  // ADR 261: the ceiling archetype. Real because of `deny` — Claude Code's deny outranks allow and
  // cannot be overridden interactively, which is what makes read-only a ceiling rather than a
  // suggestion. No `ask` entries: in a non-interactive session `ask` is just a slower fail-closed.
  // Bash stays allowed but only through read-shaped prefixes; the deny on the edit tools is the
  // profile. (Observer members, ADR 063, are the coordination-layer precedent.)
  'read-only': {
    toolkit: 'read-only',
    charter: [
      'Read, review, and report — never write. Surface findings through the team acts.',
      'Work in a claimed lane; request_help instead of working around a limit.',
    ],
    tools: {
      resource_scopes: ['**'],
      permissions: {
        allow: [
          'Read',
          'Glob',
          'Grep',
          'Bash(git diff *)',
          'Bash(git log *)',
          'Bash(git show *)',
          'Bash(ls *)',
          'Bash(rg *)',
          'Bash(cat *)',
        ],
        deny: ['Edit', 'Write', 'NotebookEdit'],
      },
    },
  },

  // ADR 708: the iOS engineer's equipment, named by the ios-engineer role (`toolkit = "ios"`).
  // Servers are referenced, never hosted: Expo's is remote (the seat authenticates with its
  // own Expo account on first use — no secret lives here), XcodeBuildMCP and the Apple-docs
  // server are npx-launched stdio. EAS/TestFlight credentials stay with the account holder.
  ios: {
    toolkit: 'ios',
    capacity: 1,
    charter: [
      'Build the iOS app: the Expo / React Native surface, and the Swift native bridge where the platform is the point.',
      'Verify on a running app, never by reading code alone; hardware-gated behaviour is device-verified or named unverified.',
    ],
    tools: {
      resource_scopes: ['packages/mobile/**'],
      mcp_servers: [
        { name: 'expo', url: 'https://mcp.expo.dev/mcp' },
        {
          name: 'xcodebuild',
          command: 'npx',
          args: ['-y', 'xcodebuildmcp@latest', 'mcp'],
        },
        {
          name: 'apple-docs',
          command: 'npx',
          args: ['-y', '@kimsungwhee/apple-docs-mcp@latest'],
        },
      ],
      permissions: { allow: ['Edit', 'Read', 'Bash(pnpm test*)'], ask: ['Bash'] }, // ADR 261 canonical syntax
    },
  },

  docs: {
    toolkit: 'docs',
    charter: [
      'Own the docs. Keep them accurate and in sync with the code; one fact, one home.',
      'Work in a claimed lane; resolve threads you finish.',
    ],
    tools: {
      resource_scopes: ['docs/**', '**/*.md'],
      permissions: { allow: ['Edit', 'Read'], ask: ['Bash'] }, // ADR 261 canonical syntax
    },
  },
};

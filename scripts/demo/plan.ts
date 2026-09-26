/*
 * Pure half of the demo stage setup (lane 01M3FCFQ8K, docs/demo.md §7 step 1). Everything here is
 * a function of its inputs — names, URLs, file bodies, request bodies, parsed CLI output — so it is
 * tested without touching GitHub, Cloudflare or a daemon. `setup.ts` is the side-effecting half.
 */

export interface StageOptions {
  /** Team slug. The public tunnel's ingress hard-codes `demo` (docs/operations/public-demo-tunnel.md). */
  team: string;
  /** GitHub owner (user or org) for the new public repo. */
  owner: string;
  /** Repo name; defaults to `musterd-demo-<yyyy-mm-dd>`. */
  repo: string;
  /** The presenter's human member name — becomes the team's first admin. */
  presenter: string;
  /** The planner agent's member name. */
  planner: string;
  /** The daemon the presenter laptop runs (the tunnel's origin): host, /live and /board talk to it directly. */
  server: string;
  /** The public tunnel origin phones reach, e.g. https://demo.example.com. Only the join URL uses it. */
  publicOrigin: string;
  /** Harness the planner runs under on the presenter host. */
  harness: string;
  invite: { expires: string; memberUntil: string };
  apply: boolean;
}

export const SKILL_NAME = 'planner';

export function defaultRepoName(now: Date): string {
  return `musterd-demo-${now.toISOString().slice(0, 10)}`;
}

/** Cloudflare Pages project names are lowercase, ≤58 chars, [a-z0-9-], no leading/trailing dash. */
export function pagesProjectName(repo: string): string {
  const name = repo
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 58)
    .replace(/-$/, '');
  if (!name) throw new Error(`cannot derive a Pages project name from "${repo}"`);
  return name;
}

export function pagesUrl(project: string): string {
  return `https://${project}.pages.dev`;
}

/**
 * The Pages project, connected to the GitHub repo: production deploys `main`, every branch/PR gets a
 * preview URL. No build step — the seed is plain static files; the planner keeps the product to what
 * Pages can host (docs/demo.md §7 step 7), and a lane that adds a build sets it in the dashboard.
 */
export function pagesProjectBody(project: string, owner: string, repo: string): unknown {
  return {
    name: project,
    production_branch: 'main',
    build_config: { build_command: '', destination_dir: '', root_dir: '' },
    source: {
      type: 'github',
      config: {
        owner,
        repo_name: repo,
        production_branch: 'main',
        pr_comments_enabled: true,
        deployments_enabled: true,
        production_deployments_enabled: true,
        preview_deployment_setting: 'all',
      },
    },
  };
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** ADR 450: the invite secret rides the fragment, never sent to a server. Mirrors web joinLink.ts. */
export function joinUrl(publicOrigin: string, team: string, linkSecret: string): string {
  return `${stripTrailingSlash(publicOrigin)}/join/${encodeURIComponent(team)}#i=${linkSecret}`;
}

export function surfaceUrls(server: string, team: string): { live: string; board: string } {
  const base = stripTrailingSlash(server);
  const q = `?team=${encodeURIComponent(team)}`;
  return { live: `${base}/live${q}`, board: `${base}/board${q}` };
}

export interface InviteOut {
  id: string;
  roomCode: string;
  linkSecret: string;
}

/** `musterd team invite create --json` → the three values the stage needs. */
export function parseInvite(json: string): InviteOut {
  const d = JSON.parse(json) as {
    invite?: { id?: unknown };
    link_secret?: unknown;
    room_code?: unknown;
  };
  const id = d.invite?.id;
  if (
    typeof id !== 'string' ||
    typeof d.link_secret !== 'string' ||
    typeof d.room_code !== 'string'
  )
    throw new Error(
      'unexpected `team invite create --json` output: missing invite.id, link_secret or room_code',
    );
  return { id, roomCode: d.room_code, linkSecret: d.link_secret };
}

/** `musterd agent … --json` → the planner's worktree. */
export function parseAgentDir(json: string): string {
  const d = JSON.parse(json) as { dir?: unknown };
  if (typeof d.dir !== 'string')
    throw new Error('unexpected `musterd agent --json` output: no dir');
  return d.dir;
}

/** Read `name` and `description` from a SKILL.md frontmatter block. */
export function skillFrontmatter(skillMd: string): { name: string; description: string } {
  const m = /^---\n([\s\S]*?)\n---/.exec(skillMd);
  if (!m) throw new Error('SKILL.md has no frontmatter');
  const field = (k: string): string => {
    const line = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(m[1]!);
    if (!line) throw new Error(`SKILL.md frontmatter has no ${k}`);
    return line[1]!.trim();
  };
  return { name: field('name'), description: field('description') };
}

/**
 * The files the demo repo is seeded with, path → body. The skill body is copied verbatim to its
 * canonical home; each harness gets a committed pointer bridge (a committed bridge must be a
 * pointer — nothing regenerates it; .agents/skills/skill-home-and-provenance). Codex reads AGENTS.md.
 */
export function seedFiles(opts: {
  repo: string;
  team: string;
  skillMd: string;
}): Record<string, string> {
  const { name, description } = skillFrontmatter(opts.skillMd);
  const canonical = `.agents/skills/${name}/SKILL.md`;
  const pointer = `This is a bridge. The skill lives in \`${canonical}\` — read that file and follow it.\n`;
  const yamlDesc = JSON.stringify(description);
  return {
    [canonical]: opts.skillMd,
    [`.claude/skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: ${yamlDesc}\n---\n\n${pointer}`,
    [`.cursor/rules/${name}.mdc`]: `---\ndescription: ${yamlDesc}\nalwaysApply: false\n---\n\n${pointer}`,
    [`.grok/skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: ${yamlDesc}\n---\n\n${pointer}`,
    'AGENTS.md':
      `# ${opts.repo}\n\n` +
      `Built live by the musterd team \`${opts.team}\`. Every merge to \`main\` deploys to Cloudflare Pages; ` +
      `every pull request gets a preview URL.\n\n` +
      `Keep the product to what Cloudflare Pages can host: a static site, or a front end with mock data.\n\n` +
      `## Skills\n\n- **${name}** — \`${canonical}\`. ${description}\n`,
    'README.md':
      `# ${opts.repo}\n\n` +
      `An app a room of people pitched and a musterd team of humans and agents built in front of them.\n`,
    'index.html':
      `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
      `<title>${opts.repo}</title>\n</head>\n<body>\n` +
      `<main><h1>Nothing here yet.</h1><p>The room is deciding what to build.</p></main>\n` +
      `</body>\n</html>\n`,
    '.gitignore': '.musterd/\nnode_modules/\n.DS_Store\n',
  };
}

export interface Step {
  id: string;
  what: string;
}

/** The ordered steps, for the plan printout and so `setup.ts` cannot silently skip one. */
export function steps(o: StageOptions): Step[] {
  const project = pagesProjectName(o.repo);
  return [
    { id: 'repo', what: `create public GitHub repo ${o.owner}/${o.repo} and clone it` },
    {
      id: 'seed',
      what: `seed it (index.html, AGENTS.md, ${SKILL_NAME} skill + bridges) and push main`,
    },
    {
      id: 'pages',
      what: `create Cloudflare Pages project "${project}" on ${o.owner}/${o.repo} (production=main, previews=all)`,
    },
    { id: 'team', what: `create team "${o.team}" on ${o.server} with ${o.presenter} as admin` },
    { id: 'policy', what: `set agent_connect=any_member on "${o.team}" (ADR 456)` },
    {
      id: 'invite',
      what: `mint the room invite (--expires ${o.invite.expires} --member-until ${o.invite.memberUntil})`,
    },
    {
      id: 'planner',
      what: `add agent ${o.planner} (role label planner, ${o.harness}) in a worktree of the repo`,
    },
    { id: 'residency', what: `enroll ${o.planner} on this machine's residency host` },
  ];
}

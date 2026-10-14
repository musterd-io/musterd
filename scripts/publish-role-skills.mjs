// Publish the built-in role skills to a checkout of musterd-io/skills (ADR 586 §4, second channel).
//
//   node scripts/publish-role-skills.mjs <path to a musterd-io/skills checkout>
//
// Writes `roles/<skill>/` for every built-in role skill, plus the method skill they point at, with
// each role's `references/team.md` blank — the same files `@musterd/cli` bundles, from the same
// compiled code (`packages/cli/dist/roster-roles/skills.js`; build the CLI first). `roles/` is
// replaced whole: nobody edits the published copy, so a skill that stopped shipping leaves with it.
// `roles/README.md` records the commit of this repo it came from, so the tree must be clean and HEAD
// on origin/main.
//
// It commits and pushes nothing. Review the diff in the checkout and push it yourself. Per ADR 586,
// the README carries no install line until one has been run on each harness it names.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/publish-role-skills.mjs <musterd-io/skills checkout>');
  process.exit(2);
}
const dest = resolve(target);
if (!existsSync(join(dest, 'skills')) || !existsSync(join(dest, 'README.md'))) {
  console.error(
    `${dest} does not look like a musterd-io/skills checkout (no skills/ and README.md)`,
  );
  process.exit(2);
}
const compiled = resolve('packages/cli/dist/roster-roles/skills.js');
if (!existsSync(compiled)) {
  console.error('build the CLI first: pnpm --filter @musterd/cli build');
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('status', '--porcelain', '--', '.agents/skills') !== '') {
  console.error('.agents/skills has uncommitted changes — publish from a recorded commit');
  process.exit(1);
}
const sha = git('rev-parse', 'HEAD');
try {
  git('merge-base', '--is-ancestor', sha, 'origin/main');
} catch {
  console.error(
    `HEAD ${sha.slice(0, 9)} is not on origin/main — publish from main, so the recorded link resolves`,
  );
  process.exit(1);
}

const { BUILTIN_ROLE_SKILLS, METHOD_SKILL, bundleRoleSkills } = await import(compiled);
const roles = join(dest, 'roles');
rmSync(roles, { recursive: true, force: true });
const names = bundleRoleSkills(resolve('.agents/skills'), roles);

writeFileSync(
  join(roles, 'README.md'),
  [
    '# Role skills',
    '',
    'What the member holding a role knows how to do, one skill per built-in musterd role. Each was',
    `built by the \`${METHOD_SKILL}\` method and ships with a recorded eval run in which answers with`,
    'the skill beat answers without it, graded blind.',
    '',
    ...BUILTIN_ROLE_SKILLS.map((s) => `- [${s}](${s}/)`),
    `- [${METHOD_SKILL}](${METHOD_SKILL}/) — the method, and the skeleton for a role of your own`,
    '',
    "Each role skill's `references/team.md` is blank: it is where your team's own systems and rules",
    'go. The rest of the skill is written for any team.',
    '',
    `Published from [musterd-io/musterd@${sha.slice(0, 9)}](https://github.com/musterd-io/musterd/tree/${sha}/.agents/skills)`,
    'by `scripts/publish-role-skills.mjs`. Do not edit these files here; change them there.',
    '',
  ].join('\n'),
);
console.log(`wrote ${names.length} skills to ${roles} from ${sha.slice(0, 9)}`);
console.log(
  `review and push it yourself: git -C ${dest} add roles && git -C ${dest} diff --cached --stat`,
);

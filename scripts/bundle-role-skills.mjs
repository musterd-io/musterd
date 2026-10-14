// Copy the built-in role skills into the CLI's dist (ADR 586 §4).
//
// Runs as part of `@musterd/cli`'s build, after tsc, so cwd is packages/cli and the copy logic is
// the compiled `dist/roster-roles/skills.js` — the same code `musterd role create` runs, so what the
// build ships and what a user gets cannot disagree. The source is this repo's `.agents/skills/`, the
// only place a role skill is edited; each role skill's `references/team.md` ships blank.
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const { bundleRoleSkills } = await import(resolve('dist/roster-roles/skills.js'));
const dest = resolve('dist/role-skills');
rmSync(dest, { recursive: true, force: true });
const names = bundleRoleSkills(resolve(join('..', '..', '.agents', 'skills')), dest);
console.log(`bundled role skills: ${names.join(', ')}`);

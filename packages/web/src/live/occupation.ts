/**
 * A member's job, in one plain word, for the face of their nameplate (lane 01M5FXZF49). The stream's
 * first real viewer question, 2026-10-20: "can you show their occupations". A stranger watching the
 * room needs a word they already know, never the role library's id — `product-communications`,
 * `courier` or `probe` mean nothing on a Twitch frame.
 *
 * Declared roles only (ADR 227): the word is the first of the seat's roles that has one in this map —
 * the first role alone left nick's plate blank, since `admin` leads his and has no word. A role missing
 * from the map shows nothing rather than its raw id, so a new role stays off the plate until it gets
 * a word. Deriving a job from the areas of a member's lanes was tried and rejected the same day: 14
 * days of board data put "docs" first for nearly everyone, and the rest flattened to server/cli —
 * eight plates saying "backend". A member with no role shows no job until one is assigned
 * (lane 01M5FY2XFX).
 *
 * The words are copy: sloane and alfie (product-communications) set them on 2026-10-21. `admin` has
 * none on purpose. It is a permission, and this map ships to every team, so "founder" would be false on
 * any admin who is not one; the `founder` role carries that word instead, true wherever it is held.
 */
const JOB_WORDS: Readonly<Record<string, string>> = {
  courier: 'courier',
  designer: 'designer',
  founder: 'founder',
  planner: 'planner',
  platform: 'ops',
  'product-communications': 'writer',
  security: 'security',
  steward: 'auditor',
};

export function occupation(roles: readonly (string | null | undefined)[]): string | null {
  for (const role of roles) {
    const id = role?.trim().toLowerCase() ?? '';
    if (Object.hasOwn(JOB_WORDS, id)) return JOB_WORDS[id]!;
  }
  return null;
}

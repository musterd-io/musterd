/**
 * A member's job, in one plain word, for the face of their nameplate (lane 01M5FXZF49). The stream's
 * first real viewer question, 2026-10-20: "can you show their occupations". A stranger watching the
 * room needs a word they already know, never the role library's id — `product-communications`,
 * `courier` or `probe` mean nothing on a Twitch frame.
 *
 * Declared roles only (ADR 227): the word is the seat's first role, through this map. A role missing
 * from the map shows nothing rather than its raw id, so a new role stays off the plate until it gets
 * a word. Deriving a job from the areas of a member's lanes was tried and rejected the same day: 14
 * days of board data put "docs" first for nearly everyone, and the rest flattened to server/cli —
 * eight plates saying "backend". A member with no role shows no job until one is assigned
 * (lane 01M5FY2XFX).
 *
 * The words are copy, so product-communications owns them (designer charter; asked 2026-10-21).
 */
const JOB_WORDS: Readonly<Record<string, string>> = {
  admin: 'lead',
  courier: 'courier',
  designer: 'designer',
  platform: 'ops',
  'product-communications': 'writer',
  security: 'security',
  steward: 'editor',
};

export function occupation(role: string | null | undefined): string | null {
  const id = role?.trim().toLowerCase() ?? '';
  return Object.hasOwn(JOB_WORDS, id) ? JOB_WORDS[id]! : null;
}

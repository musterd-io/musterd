/**
 * Where a viewer of /live or /broadcast can find the team: a fact asserted on a public surface, so it is
 * written per team and never derived (`<slug>@musterd.io` would claim a mailbox for every team that ever
 * streams). A team without a mailbox shows no address, only the mark.
 */
export function teamContact(team: string | null): string | undefined {
  return team === 'revive' ? 'revive@musterd.io' : undefined;
}

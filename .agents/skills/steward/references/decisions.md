# Decision records

Open when the drift involves a decision record's status.

## 1. Statuses

proposed → accepted → (deprecated | superseded by N). Some teams also use rejected. (MADR, MIT
or CC0; Michael Nygard's original format, cited.)

- **Numbers are never reused**, and a superseded record stays, with a link to the one that replaced it.
- **Superseding** means a new record that reverses or replaces the old one, plus a back-link.
- **Amending** a record differs by team: some forbid it, some allow dated additions. Follow the
  team's rule (`references/team.md`).

## 2. What the steward does with a status

- **Report, then propose only what the team's rules let anyone do.** A status line that says
  "proposed" while the code and later records treat the decision as in force is a finding for the
  record's author; propose the status change only where the team allows it, citing the merge
  that put it in force.
- **The status line alone is weak evidence.** A test or a check that proves the decision is in
  force (MADR's "Confirmation" section, a fitness function) is strong evidence.
- **Never touch a decision's content.** Wording, reasoning and the decision itself belong to its
  author. A correction to a frozen section is out of bounds even when it is right.
- **A status parser can be wrong.** Records written in slightly different formats may be misread
  by a script; read the record itself before reporting.

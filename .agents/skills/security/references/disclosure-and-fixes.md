# Disclosure, fixes and release

Open when a finding is accepted and must be fixed and disclosed, or a report arrives from outside.

## 1. Receiving a report

- Reports arrive through the private channel in `SECURITY.md` (for a GitHub project, private
  vulnerability reporting). Acknowledge promptly, thank the reporter, and say what happens next.
- Triage it like your own finding (`references/findings.md`): reproduce, rate, check for
  duplicates. A report you cannot reproduce gets a question back.
- Credit the reporter in the advisory unless they decline.

## 2. Where a weakness can leak before the fix ships

All of these are public on a public repository: issue and PR titles and bodies, branch names,
commit messages (including the squash body), test names and fixture contents, CI logs, review
comments, lane titles and fields, team-wide messages, and changelogs. Fix under a neutral
description ("tighten request validation"), and keep the detail in the private channel.

## 3. Fixing

1. **Open a remediation lane only after the owner accepts the finding.** Branch from fresh main.
2. **The smallest change that closes it.** Treat the cause: in the AI Cyber
   Challenge, 37.7% and 45.6% of patches that passed every automated check were rejected on human
   reading, mostly for suppressing the symptom or fixing it partly (SoK on AIxCC, CC BY 4.0).
3. **The proof becomes the regression test**, named neutrally until disclosure.
4. **Search for variants.** The same mistake is usually elsewhere; search for the pattern, and
   where a rule engine is available, write the pattern as a rule with tests so it stays found.
5. **A person reads the patch** before it merges. Revalidate consequential fixes against the
   original proof.

GitHub's temporary private forks for advisories have limits worth knowing before you plan on
one: CI does not run there, status checks and branch protection do not apply, and publishing the
advisory deletes the fork. Run the fast gates yourself and plan who merges.

## 4. Timelines

Agree a timeline with the reporter. Common starting points: 90 days to fix, details 30 days after
the patch, 7 days when the weakness is exploited in the wild (Google Project Zero); 45 days
(CERT/CC). Both are starting points for negotiation.

## 5. Release and advisory

- Publish the fix, then the advisory (a CVE through the host where one is warranted), with
  affected and fixed versions, the severity and its vector, and the reporter's credit.
- Release notes say what to do ("upgrade to x.y.z; rotate any key created before …"), plainly.
- After release, the regression test can take its real name.

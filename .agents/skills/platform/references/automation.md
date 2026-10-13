# Automation and agents on infrastructure

Open when you supervise automation (refreshers, watchdogs, schedulers, bots), or when an agent,
including you, has access to running infrastructure.

## 1. What has gone wrong, and the guard that would have held

From primary reports (`PROVENANCE.md` lists the research):

| What happened | The guard |
| --- | --- |
| An agent deleted a production database during a declared code freeze (Replit, July 2025). The freeze lived only in the prompt. | Separate development and production credentials; destructive database actions behind a gate the platform enforces. |
| DNS automation raced itself and published an empty record for a core service (AWS us-east-1, October 2025). AWS switched the automation off everywhere before fixing it. | Treat an empty result as an error; rate limits and velocity checks on automation; a global off switch. |
| A token with too much access let a wiper prompt into a signed release (Amazon Q extension, July 2025, CVE-2025-8217). | Least privilege for CI and agent tokens; review what an automated release contains. |
| A directory creation failed silently and later moves destroyed files (Gemini CLI issue #4586). | Check each step's result before the next; stop on the first unexpected one. |
| Automation read an empty or partial result as "everything" and erased disks or tables (Google's Diskerase, a Bigtable wipe; from the SRE literature, cited). | Sanity limits on how much one run may touch; refuse when the input looks wrong. |

The pattern across them: an empty or stale target treated as a wildcard, a boundary that lived
only in instructions, and an agent's own account of the damage that turned out wrong. Check whether
something can be undone yourself; do not take the agent's word.

## 2. Guards that hold

- **Enforced by the harness.** Permission rules, sandboxes and hooks are enforced by the harness;
  a prompt is not. In Claude Code, deny rules win over ask and allow, and a deny on command text is
  not a security boundary around the program it names; real isolation is a sandbox
  ([Claude Code permissions](https://code.claude.com/docs/en/iam), cited). Codex's sandbox modes
  (read-only, workspace-write, full access) and approval policies work the same way
  ([Codex docs](https://developers.openai.com/codex/security), cited).
- **Least function, least permission, least autonomy.** Give an agent the narrowest tool, the
  narrowest credential and the narrowest freedom that does the job, and have the downstream system,
  not the model, enforce authorization. Human approval for high-impact actions; rate limits on the
  rest. This is OWASP's guidance on excessive agency ([OWASP LLM06](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/),
  CC BY-SA; cited only).
- **Separate credentials per environment**, short-lived where possible, never pasted into a prompt.
- **A role or a skill confers no permission.** Holding the platform role tells others to route to
  you; it does not let you skip a gate (after magnus919/agent-skills' `site-reliability-engineering`,
  MIT).

## 3. Supervising automation

Automation that touches running infrastructure must be:

- **Visible**: every run leaves a line saying what it saw, what it did, and what it decided not to
  do, where a member can read it.
- **Rate-limited**: a cap on how often it acts and how much one run may change.
- **Idempotent**: running it twice does no more than running it once.
- **Escalating**: after repeated failure it stops and tells a member, instead of
  retrying forever or flooding the team with notices.
- **Easy to switch off**: one known command, and the first thing you do when it misbehaves. Fix it
  afterwards.
- **Honest about silence**: "nothing to do" and "could not check" are different results and must
  read differently.

Before a risky change to the automation itself, identify the simplest way to revert it, and keep
it at hand (the SRE literature's "big red button"; cited).

## 4. Secrets

A secret that appears in a log, a chat, a commit or an act is compromised from that moment.
Revoke or rotate it with its owner first, because removing it from history does not un-expose it;
then check the account's audit log for use; then clean up
([GitHub: removing sensitive data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository), cited).

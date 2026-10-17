# Dependencies, CI, release and public posture

Open when reviewing a dependency, build workflow, release path or public security statement.

## 1. Dependencies

Before approving an addition or upgrade, record:

- **Need and alternative**: what capability is missing, and whether the language runtime or an
  existing dependency already provides it.
- **Source and maintenance**: the official package identity, maintainers, release history, support
  policy and how the package is published.
- **Install and build behavior**: lifecycle scripts, native build steps, generated code and any
  network access during installation.
- **Dependency reachability**: the resolved transitive tree, licences, known advisories and whether
  affected code is present in production paths.
- **Change review**: the exact lockfile and manifest diff; use the project's frozen or reproducible
  install command to confirm it.

Use scanners to identify leads, then check the package manager, ecosystem and lockfile directly.
Do not infer that a release-age delay, signature check or provenance feature is enabled; inspect
the project's actual configuration and the tool version.

## 2. CI and build workflows

1. Trace who can trigger each workflow and what credentials or permissions it receives.
2. Treat pull request titles, branch names, comments, labels and checked-out contributions as
   attacker-controlled when an outside contributor can supply them.
3. Do not interpolate untrusted text into a shell command. Pass it as data and validate it at the
   receiving boundary.
4. Keep write permissions job-specific and minimal. Pin third-party actions or plugins to full
   immutable commit SHAs supported by the platform; verify each pin against the publisher's
   official repository before approval.
5. Check whether a privileged event can check out or execute untrusted code before it receives a
   write token or secret.
6. For build agents, apply the same input rule: repository text can carry instructions, so enforce
   token and network limits outside the agent.

Report the complete trigger-to-impact path and whether a contributor without write access can reach
it. A risky pattern with no reachable input is a hardening note, not a demonstrated vulnerability.

## 3. Release and updates

- Prefer short-lived or workload-identity publishing over long-lived release tokens where the
  ecosystem supports it.
- Restrict signing, publishing and update credentials to the job and package that need them.
- Check whether build provenance is generated and verifiable, and review the source and workflow
  that produced it; provenance alone does not prove the source is safe.
- Treat lockfiles, release manifests, install hooks, update clients and signing keys as security
  boundaries.
- Record the published and fixed versions, the update path and any rotation a user needs to do.

## 4. Public posture

- Do not claim a product is "secure", "unhackable" or free of vulnerabilities.
- State dated, checkable facts: the version, source, tool, scope and result.
- Say what has not been tested or shipped as plainly as what has.
- Route public wording through the person who owns the project's voice. Provide the facts, dates,
  impact and limits for them to use.

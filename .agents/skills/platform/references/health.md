# Health, signals and measuring a fix

Open when designing or reading a health check, choosing what to watch, verifying a fix, or chasing
a performance regression.

## 1. Health checks

Three different questions, three different checks (after Kubernetes' probe documentation,
[CC BY 4.0](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/)):

| Check | Asks | On failure | Rule |
| --- | --- | --- | --- |
| Liveness | Is the process able to make progress at all? | Restart it | Cheap; never checks dependencies, or one slow database restarts everything |
| Readiness | Should it receive work right now? | Stop sending it work, no restart | May check dependencies |
| Deep health | What is the state of everything it depends on? | Nothing automatic | A separate endpoint, local or authenticated, because it tells an attacker a lot |

**Stamp the build.** Every running process should report which build it is (a short commit SHA),
in its health response and in its telemetry (OpenTelemetry's `service.version`). Without it, "did
my fix deploy?" has no answer.

## 2. What to watch

- **Per service, RED**: rate of requests, errors, and duration.
- **Per resource, USE**: utilization, saturation, errors (`references/diagnosis.md`).
- **Latency as percentiles** (p50, p95, p99) from histograms, never averages; keep failed requests'
  latency apart from successful ones, or fast errors make a slow service look quick.
- **Few objectives.** If the team sets service-level objectives, five or fewer, each "good events
  over valid events" over a rolling window. With little traffic, burn-rate alerts are noisy; prefer
  synthetic checks or a looser objective (Google SRE Workbook, cited, CC BY-NC-ND).

## 3. Logs and traces

Structured logs with a stable set of fields matter more than the format. Put the trace and span ids
on log lines so a log and a trace can be joined
([OpenTelemetry logs](https://opentelemetry.io/docs/specs/otel/logs/), CC BY 4.0). Do not sample
until volume forces it. Never log secrets, tokens or personal data, and remember instrumentation
libraries can emit them on their own: strip with an allow-list in code. Hashing a small or
predictable id does not anonymize it.

## 4. Verifying a fix

1. **Reproduce it first.** A fix for a failure you never saw is unverifiable.
2. **Write the falsifier down before you look**: the result that would show the fix did not work.
3. **Confirm the running build** is the one with the fix.
4. **Measure before and after on the same machine, interleaved**, with repeats, and report the
   spread. Run-to-run noise is often larger than the change; MongoDB found paired runs narrowed
   the confidence interval in 98% of their comparisons (cited in `PROVENANCE.md`'s research).
5. **Check at the user-facing boundary**, then watch for a stated window.

## 5. Performance regressions

- **One run per side flags noise as a regression.** Use repeats and a comparison that accounts for
  spread (confidence intervals, or a rank test such as Mann-Whitney).
- **A matched repeat first**: same machine size, same load, same build on the "before" side. A
  difference between two runs that changed several things at once is not a regression yet.
- **Bisect when it repeats.** `git bisect run <script>` treats exit 0 as good, 1–127 (except 125)
  as bad, 125 as skip; `--term-old fast --term-new slow` makes the output readable for speed. Keep
  the judging script outside the repository so checking out old commits does not change it
  ([git bisect](https://git-scm.com/docs/git-bisect), cited).

# Findings: scan, validate, rate, write up

Open when running or reading a scanner, or deciding whether a finding is real and how bad.

## 1. Scanning

- **Threat-model before you scan**, so you know what a hit would mean.
- **Record the baseline** before the first run: commit, the tools and their versions, the model,
  the scope included and excluded.
- **Use a tool that covers the class and ecosystem**: static analysis for code patterns; secret
  scanning for credentials; the ecosystem's dependency audit for known vulnerabilities; a
  model-assisted review for logic. Check each tool's documented coverage and version.
- **Scanner output is a list of leads.** A severity label does not prove an attacker reaches the
  affected code. Trace the production path, distinguish build and test tooling from runtime, and
  check whether the tool supports reachability analysis for that ecosystem. Never run an automatic
  force-fix without reviewing its changes; it can introduce incompatible versions or downgrades.
- **Zero findings describes the tools and the scope.** Write "tools X at commit Y over
  scope Z found nothing; classes not covered: …".

## 2. Validation

1. **Find, then try to disprove.** For each candidate, a separate pass argues it is a false
   positive: is the input really attacker-controlled, is there a check upstream, does the path
   run in production? Drop what does not survive. (Adapted from Anthropic's
   `claude-code-security-review`, MIT: candidates scored below 8 of 10 are dropped.)
2. **Confirm with something other than a model** where you can: a test that fails, a request
   that returns what it should not, a headless browser that sees the script run.
3. **Reproduce more than once.** Some bugs only show on a later run; AI Cyber Challenge teams lost
   real bugs by checking once (SoK on AIxCC, CC BY 4.0).
4. **Least evidence, nothing destructive.** Against a disposable local instance with synthetic
   data. The proof that confirms the finding becomes its regression test.
5. **Too many unvalidated findings is a failure in itself.** It burdens maintainers and makes valid
   reports harder to recognize.

## 3. Rating

- **Impact × likelihood**, each low / medium / high with a one-line reason, adjusted for the
  controls that exist. Overall: critical, high, medium or low.
  - High: authentication bypass, reading another member's or tenant's data, credential theft,
    code execution, integrity of the build or of shared state.
  - Medium: needs specific conditions but the impact is significant; targeted denial of service
    of a critical component.
  - Low: low-value information, easily mitigated denial of service, unlikely preconditions.
- **Confidence separately**: confirmed (reproduced), likely (path traced, one link unproven),
  possible (pattern only; not reported as a finding).
- **Do not discount for human approval.** People approve what they are shown; a step that needs a
  click is not a control (Meta's Agents Rule of Two and others, cited).
- **When a score will be published**, use CVSS 4.0 and publish the vector with it; the base
  score measures severity alone; risk adds your context (FIRST, cited).

## 4. The write-up

The private copy, for the owner and the fixer:

```
Title:        <class> in <surface>
Affected:     <component, file:line, versions or commits>
Severity:     <rating> (impact: …; likelihood: …)   Confidence: <…>
Attacker:     <who, with what access; what they cannot do>
Path:         <entry point → what they send → how it executes → what they gain>
Evidence:     <the reproduction, how many runs, the non-model check>
Fix:          <the smallest change that closes it, and its regression test>
Variants:     <where else the same pattern was searched>
```

The summary that may go to a wider audience carries only the surface, the severity, the
confidence, the impact and the containment needed. Never the path.

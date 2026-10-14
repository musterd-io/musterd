# Threat modeling and security review

Open when modeling a system or a design, or reviewing a change for security.

## 1. Four questions

Every threat model answers four questions (Shostack; the Threat Modeling Manifesto, CC BY 4.0):

1. What are we working on?
2. What can go wrong?
3. What are we going to do about it?
4. Did we do a good enough job?

## 2. The smallest useful model

Keep it in the repository beside the code, and review it when the design changes.

1. **The system, from evidence.** Components, data stores, entry points (endpoints, parsers,
   uploads, job triggers, admin tools, log sinks) and how it runs. Every claim points to a file;
   runtime is kept apart from CI, build and test code. Do not claim a component, flow or control
   you cannot point to. (Adapted from OpenAI's `security-threat-model` skill, Apache-2.0.)
2. **Trust boundaries as edges.** Each edge between two components: protocol, authentication,
   encryption, validation, rate limiting.
3. **Assets and the attacker.** What drives risk (credentials, other people's data, integrity of
   state, the build) and what a realistic attacker can do given the exposure, **and what they
   cannot**, so severity does not inflate.
4. **Threats per element.** Walk STRIDE (spoofing, tampering, repudiation, information disclosure,
   denial of service, elevation of privilege) over each element and edge. For any edge that
   carries text a model will read, ask one more question: can content crossing here carry
   instructions? (`references/agents-and-secrets.md`)
5. **A response per threat**, with an owner and a reason: mitigate, remove the feature, transfer,
   or accept. An accepted risk names the human who accepted it.
6. **A test per mitigation**, so the control is proven and stays proven.
7. **"Good enough?"** One line on what was not covered and why.

Attack trees earn their cost for one high-value goal (for example, "read another member's
credential"); the method itself is the walk above.

## 3. Reviewing a change

1. Learn the repository's own patterns first: how it parses input, checks authorization, stores
   secrets. A change that departs from an established safe pattern is the first place to look.
2. Trace data from each new input to each sensitive operation. Note every boundary it crosses.
3. Report only what you can build an attack for: entry point, what the attacker sends, how it
   executes, what they gain. If a link is missing, it is "needs verification".
   (Adapted from Sentry's `gha-security-review`, Apache-2.0.)
4. Then try to disprove each candidate separately before keeping it (`references/findings.md` §2).
5. Report zero findings when there are none. Do not invent issues to fill a report.

## 4. Classes to check in a networked tool

- **Input**: every external input parsed by a schema at the boundary; size limits on bodies and
  frames; path traversal in file serving.
- **Authentication and authorization**: checked on the server for every state change; a header
  that names an identity is never proof of it; possession of a session or state handle is not
  authentication.
- **A server on localhost** is reachable from any web page the person opens: allowlist the `Host`
  header (DNS rebinding), check `Origin` on every WebSocket handshake and state-changing request,
  carry tokens in a header or first message (never a cookie alone or a query string), make GET
  change nothing. (OWASP WebSocket guidance, cited; the MCP security best practices, CC BY 4.0.)
- **Web surfaces**: a content security policy, `frame-ancestors 'none'` for anything that holds a
  credential, no raw HTML sinks fed by other people's text.
- **Secrets at rest**: random, prefixed so scanners match them, hashed on the server, files
  created owner-only (`references/agents-and-secrets.md` §3).
- **Comparisons**: constant-time comparison for secrets and anything derived from them.

# 675 — Cloud 6 observability: OpenTelemetry exporter + error tracking, disclosed in PRIVACY.md

- Status: accepted
- Date: 2026-10-20
- Lane: `01M3Z436EAAVEM19MS7V95ZQSX`

## Context

Spec §7 observability + §10: the OTel exporter is a new runtime dependency (hard rule 6). Cloud mode only; self-hosted never phones home. Done when: a Cloud request's trace and a thrown error are visible at the vendor, and PRIVACY.md says so.

## Problem

The server already emits OTel spans and metrics via `@opentelemetry/api` (`packages/server/src/telemetry.ts`, ADR 015), but the SDK only starts when a standard OTLP endpoint env var is set, and self-hosted (no endpoint) never phones home. Cloud needs a vendor configured out of the box, disclosed in PRIVACY.md, with an ADR for the new dependency.

## Decision

1. **New runtime dependency: `@opentelemetry/exporter-trace-otlp-http` (and the metrics exporter) via `@musterd/telemetry`.** ADR 486 already admits `pg`; this ADR adds the OTel OTLP exporter. Weighed against `@opentelemetry/sdk-node` (bundles exporters we don't need, heavier) and vendor-specific SDKs (lock-in); the OTLP/HTTP exporter keeps the app vendor-neutral.
2. **Cloud mode reads `MUSTERD_OTLP_ENDPOINT` (and `MUSTERD_OTLP_HEADERS` for auth) from config.** When set, the server starts the SDK with that endpoint; when unset (self-hosted), the SDK stays off. `MUSTERD_MODE=cloud` does not itself enable telemetry — the operator sets the endpoint via Fly secrets.
3. **Error tracking** uses the same OTLP trace exporter: unhandled errors and 5xxs are recorded as span events with `exception.*` attributes; a separate error-tracking vendor is deferred to a follow-up.
4. **PRIVACY.md** gains a hosted-only section: a Cloud team server exports traces and errors to a vendor (named in the section) over OTLP; self-hosted never phones home; message bodies, Act text, secrets and seat names are never exported (ADR 015 posture).

## Consequences

- Self-hosted daemons are unaffected: no endpoint, no telemetry, no new dependency loaded (the exporter is only imported when the endpoint is configured).
- Cloud deploys set `MUSTERD_OTLP_ENDPOINT` (and headers) as Fly secrets; rotating the vendor endpoint requires a redeploy.
- PRIVACY.md's top line ("musterd does not phone home") is qualified by the hosted section, per spec §10.

## Observability & Evaluation

- **Traces:** a Cloud request's trace (with `team_id` and `member` attributes, never bodies) and a thrown error's span are visible at the configured vendor.
- **Eval:** `packages/server/src/telemetry.test.ts` and a new `packages/server/src/otel/*.test.ts` verify the SDK starts only when `MUSTERD_OTLP_ENDPOINT` is set, exports to that endpoint, and records 5xx errors as span events.
- **Experiment:** Falsify: a self-hosted daemon with no OTLP env var makes zero outbound connections; a Cloud daemon with the env var set exports a trace for a request within one minute.
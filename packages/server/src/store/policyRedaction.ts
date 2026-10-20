const REDACTION_MARKER = Object.freeze({ $redacted: 'policy-secret' } as const);

const POLICY_SECRET_FIELDS = [
  'ask_slack_webhook',
  'seeds_relay_token',
  'seeds_relay_url',
  'away_relay_token',
  'away_relay_url',
  'slack_bot_token',
] as const;

const DOORBELL_SECRET_FIELDS = ['slack_url', 'webhook_url'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRedactionMarker(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    value['$redacted'] === REDACTION_MARKER.$redacted
  );
}

function marker(): typeof REDACTION_MARKER {
  return { ...REDACTION_MARKER };
}

/** Replace only the configured policy credentials; the hub's stored policy is never mutated. */
export function redactPolicySecrets(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('policy.change detail must be an object');
  const result = { ...value };
  for (const field of POLICY_SECRET_FIELDS)
    if (Object.hasOwn(result, field)) result[field] = marker();

  const doorbell = result['doorbell'];
  if (isRecord(doorbell)) {
    const redactedDoorbell = { ...doorbell };
    for (const field of DOORBELL_SECRET_FIELDS)
      if (Object.hasOwn(redactedDoorbell, field)) redactedDoorbell[field] = marker();
    result['doorbell'] = redactedDoorbell;
  }
  return result;
}

const DROP = Symbol('drop redaction marker');

function stripMarker(value: unknown): unknown | typeof DROP {
  if (isRedactionMarker(value)) return DROP;
  if (Array.isArray(value))
    return value.flatMap((item) => {
      const stripped = stripMarker(item);
      return stripped === DROP ? [] : [stripped];
    });
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const stripped = stripMarker(item);
      if (stripped !== DROP) result[key] = stripped;
    }
    return result;
  }
  return value;
}

/** Remove marker objects before a replica stores a policy projection. */
export function stripPolicyRedactionMarkers(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const stripped = stripMarker(value);
  return isRecord(stripped) ? stripped : {};
}

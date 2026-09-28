import type { MemberSummary } from '@musterd/protocol';
import { modelProvider, type ModelProvider } from './modelProvider';
import { shortModel } from './presenceLabel';

/**
 * The model badge the team column and the plates show (ADR 464, spec §4). The one rule it exists to
 * keep: never claim more than we know. `observed` is the server watching the model on the wire
 * (ADR 301); `environment` / `binding` is something the seat said about itself ("declared"); and a
 * model with NO tier is "unverified" — a pre-migration row or an older client, which is a different
 * fact from a declaration (`member.ts`, ADR 236) and is never read as one.
 */
export type BadgeSource = 'observed' | 'declared' | 'unverified' | 'unknown' | 'human' | 'service';

export interface ModelBadge {
  provider: ModelProvider;
  label: string;
  /** The raw model id, for the tooltip — null when there is none. */
  full: string | null;
  source: BadgeSource;
}

/** The attachment the room is looking at: the live one, else the most recent (`OfficeScene` pick). */
export function livePresence(m: MemberSummary) {
  return m.presences?.find((p) => p.status === 'online' || p.status === 'away') ?? m.presences?.[0];
}

const UPPER = new Set(['gpt', 'glm']);

/** `shortModel`'s lower-case "opus 5.5" / "gpt 6", cased for a projector: "Opus 5.5" / "GPT 6". */
export function displayModel(model: string | null | undefined): string {
  const short = shortModel(model);
  if (!short) return '';
  return short
    .split(' ')
    .map((w) => (UPPER.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export function modelBadge(m: MemberSummary): ModelBadge {
  const p = livePresence(m);
  const model = p?.model?.trim() || null;
  const provider = modelProvider(model);
  if (m.kind === 'human') {
    return { provider: modelProvider(null), label: 'human', full: null, source: 'human' };
  }
  if (m.kind === 'service') {
    return { provider: modelProvider(null), label: 'service', full: null, source: 'service' };
  }
  if (!model) return { provider, label: 'model unknown', full: null, source: 'unknown' };
  return {
    provider,
    label: displayModel(model) || model,
    full: model,
    source:
      p?.model_source === 'observed'
        ? 'observed'
        : p?.model_source === 'environment' || p?.model_source === 'binding'
          ? 'declared'
          : 'unverified',
  };
}

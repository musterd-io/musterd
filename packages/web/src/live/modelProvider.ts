export type ModelProviderId =
  | 'claude'
  | 'openai'
  | 'gemini'
  | 'xai'
  | 'meta'
  | 'mistral'
  | 'qwen'
  | 'deepseek'
  | 'kimi'
  | 'minimax'
  | 'glm'
  | 'stepfun'
  | 'longcat'
  | 'ant'
  | 'nova'
  | 'catjam'
  | 'unknown';

export type ModelProvider = {
  id: ModelProviderId;
  border: string;
  fill: string;
  ink: string;
};

/** Chip tokens from lab AI training deck Model landscape (`.b-*`). */
const CHIPS: Record<ModelProviderId, Omit<ModelProvider, 'id'>> = {
  claude: { border: '#D97757', fill: '#FCEEE8', ink: '#5C2E1F' },
  openai: { border: '#10A37F', fill: '#E8F7F2', ink: '#0B5C47' },
  gemini: { border: '#8E75B2', fill: '#F0EBF8', ink: '#4A3A6E' },
  xai: { border: '#333', fill: '#F2F2F2', ink: '#111' },
  meta: { border: '#0668E1', fill: '#E7F0FD', ink: '#044A9E' },
  mistral: { border: '#F54E00', fill: '#FFF0E8', ink: '#8A2C00' },
  qwen: { border: '#FF6A00', fill: '#FFF1E6', ink: '#9A4000' },
  deepseek: { border: '#4D6BFE', fill: '#EBF0FF', ink: '#2A3FBF' },
  kimi: { border: '#6366F1', fill: '#EEF0FF', ink: '#3730A3' },
  minimax: { border: '#E11D48', fill: '#FDE8EF', ink: '#9F1239' },
  glm: { border: '#1F1F1F', fill: '#F2F2F2', ink: '#111' },
  stepfun: { border: '#0160FF', fill: '#E8F0FF', ink: '#0B3FA8' },
  longcat: { border: '#1FB846', fill: '#E9FBEE', ink: '#0B5C24' },
  ant: { border: '#1677FF', fill: '#E8F1FF', ink: '#0B4FB3' },
  nova: { border: '#FF9900', fill: '#FFF4E5', ink: '#9A5C00' },
  catjam: { border: '#7C3AED', fill: '#F3E8FF', ink: '#5B21B6' },
  // No logo yet — a quiet stone pin that wears the model's initial (`modelProviderIcon.ts`), never a
  // "?": an unrecognised lab is not a broken attestation.
  unknown: { border: '#A8A29E', fill: '#F5F5F4', ink: '#44403C' },
};

function chip(id: ModelProviderId): ModelProvider {
  return { id, ...CHIPS[id] };
}

/**
 * Map an attested model id to a provider chip. Order matters: match specific families before
 * broad vendor prefixes. Exhaustive via Record — adding a provider requires a CHIPS entry.
 */
export function modelProvider(model: string | null | undefined): ModelProvider {
  if (!model) return chip('unknown');
  const lower = model.trim().toLowerCase();
  if (!lower || lower === 'unknown') return chip('unknown');

  if (/\b(opus|sonnet|haiku|fable)\b/.test(lower) || lower.includes('claude')) return chip('claude');
  if (/\bgpt\b/.test(lower) || /\bo[1-9]\b/.test(lower)) return chip('openai');
  if (lower.includes('gemini')) return chip('gemini');
  if (lower.includes('grok')) return chip('xai');
  if (lower.includes('llama')) return chip('meta');
  // muse-spark is Meta's family on opencode (e.g. muse-spark-1.3-contributor-free) — without this
  // it falls to unknown and the plate renders the "?" mark. Match the full token, not bare "muse".
  if (lower.includes('muse-spark') || lower.includes('muse spark')) return chip('meta');
  if (lower.includes('mistral')) return chip('mistral');
  if (lower.includes('qwen')) return chip('qwen');
  if (lower.includes('deepseek')) return chip('deepseek');
  if (lower.includes('kimi') || lower.includes('moonshot')) return chip('kimi');
  if (lower.includes('minimax')) return chip('minimax');
  if (/\bglm\b/.test(lower) || lower.includes('zai')) return chip('glm');
  // StepFun's Step family (step-5-preview-free), Meituan's LongCat, Ant Group's Ling — all seen on
  // opencode seats. `step` and `ling` are ordinary words, so match them only as the leading token.
  if (/^(?:[\w.-]+\/)?step[- ]?\d/.test(lower) || lower.includes('stepfun')) return chip('stepfun');
  if (lower.includes('longcat')) return chip('longcat');
  if (/^(?:[\w.-]+\/)?ling[- ]?\d/.test(lower) || lower.includes('inclusionai')) return chip('ant');
  if (lower.includes('nova')) return chip('nova');
  // CatJam models run on opencode (e.g. cat-jam-free) and their own seat attests them —
  // match before the fallback so the plate gets a mark instead of "?".
  if (lower.includes('cat-jam') || lower.includes('catjam') || lower.includes('litterbox')) return chip('catjam');
  return chip('unknown');
}

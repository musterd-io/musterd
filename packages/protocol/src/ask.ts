import { z } from 'zod';
import { ASK_OUTCOMES, ASK_SPECIES, ASK_TIERS, ASK_WITHHOLD_MAX_GLOBS } from './ask.wire.js';

/** The zod face of the ask vocabulary; the tuples, contract table and helpers are `ask.wire.js`. */
export {
  ASK_ACTION_CLASSES,
  ASK_ACTION_CLASS_BY_SPECIES,
  ASK_NO_ANSWER,
  ASK_OUTCOMES,
  ASK_SPECIES,
  ASK_TIERS,
  ASK_TIER_DEFAULTS,
  ASK_TOP_TIER,
  ASK_WITHHOLD_MAX_GLOBS,
  ASK_WITHHOLD_MAX_MS,
  ACCEPTANCE_REVIEW_WINDOW_MS,
  acceptanceAskContract,
  answerAuthority,
  askContract,
  askContractText,
  askProseChoiceNotice,
  askTierHolds,
  askWithholds,
  askWithholdText,
  classifyAskAction,
  reviewWaitMinutes,
  type AnswerAuthority,
  type AskActionClass,
  type AskContract,
  type AskNoAnswer,
  type AskOutcome,
  type AskSpecies,
  type AskTier,
  type AskWithhold,
} from './ask.wire.js';

export const AskSpeciesSchema = z.enum(ASK_SPECIES);
export const AskTierSchema = z.enum(ASK_TIERS);
export const AskOutcomeSchema = z.enum(ASK_OUTCOMES);

/** ADR 801 §1: the `meta.withhold` of a blocking `approve` ask — the action it holds, as ADR 150 class
 *  globs. At least one glob; each list capped at {@link ASK_WITHHOLD_MAX_GLOBS}. */
const WithholdGlobs = z.array(z.string().trim().min(1).max(200)).max(ASK_WITHHOLD_MAX_GLOBS);
export const AskWithholdSchema = z
  .object({ commands: WithholdGlobs.optional(), paths: WithholdGlobs.optional() })
  .strict()
  .refine((w) => (w.commands?.length ?? 0) + (w.paths?.length ?? 0) > 0, {
    message: 'meta.withhold names at least one command or path glob',
  });

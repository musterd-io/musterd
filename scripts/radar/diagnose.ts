/** Read-only provider probe (ADR 596). Only bounded metadata reaches stdout. */
import { fetchArticleText } from './content.ts';
import { loadSeen, partitionRadarCandidates } from './dedup.ts';
import { readCandidateFullText, type CandidateReadResult } from './fullText.ts';
import { completeAnthropic, extractJson } from './llm.ts';
import { runTriage, type CompleteFn } from './triage.ts';

const records: object[] = [];
const observedComplete: CompleteFn = async (args) => {
  try {
    const result = await completeAnthropic(args);
    let validJson = false;
    try {
      extractJson(result.text);
      validJson = true;
    } catch {
      /* metadata only */
    }
    records.push({
      tier: args.model === 'claude-sonnet-5' ? 2 : 1,
      maxTokens: args.maxTokens ?? 4096,
      inputTokens: result.inputTokens ?? null,
      outputTokens: result.outputTokens ?? null,
      textCharacters: Array.from(result.text).length,
      validJson,
    });
    return result;
  } catch (error) {
    // The existing client includes a provider body in its error. Extract only its numeric status.
    const status =
      error instanceof Error ? /^Anthropic ([1-5]\d\d):/.exec(error.message)?.[1] : undefined;
    records.push({
      tier: args.model === 'claude-sonnet-5' ? 2 : 1,
      status: status === undefined ? null : Number(status),
      failed: true,
    });
    throw error;
  }
};

async function main(): Promise<void> {
  for (const key of ['EXA_API_KEY', 'ANTHROPIC_API_KEY', 'EXPLORING_API_KEY', 'RADAR_SEEN_PATH']) {
    if (!process.env[key]?.trim()) throw new Error('diagnostic configuration missing');
  }
  const sample = await fetchArticleText(
    'https://arxiv.org/pdf/2609.37226v1',
    process.env.EXA_API_KEY!,
  );
  console.log(
    JSON.stringify({
      sample: '2609.37226v1',
      characters: Array.from(sample.text).length,
      introduction: /\bintroduction\b/i.test(sample.text),
      relatedWork: /related\s+work/i.test(sample.text),
      references: /\breferences\b/i.test(sample.text),
      appendix: /\bappendix\b/i.test(sample.text),
      finalPage: /writing an Entity Page in the Rendering stage/i.test(sample.text),
      finalSentence: /then appended to the generated page/i.test(sample.text),
      corpusMap: /corpus\s*map/i.test(sample.text),
    }),
  );
  const candidates = partitionRadarCandidates([], loadSeen(process.env.RADAR_SEEN_PATH!), 10).ready;
  const reads: CandidateReadResult[] = [];
  // Bound concurrency to the same three readers as the normal sweep.
  for (let index = 0; index < candidates.length; index += 3) {
    reads.push(
      ...(await Promise.all(
        candidates.slice(index, index + 3).map((candidate) =>
          readCandidateFullText(candidate, {
            exaApiKey: process.env.EXA_API_KEY!,
            completeFn: observedComplete,
          }),
        ),
      )),
    );
  }
  const report = await runTriage({
    candidates,
    readResults: reads,
    apiKey: process.env.ANTHROPIC_API_KEY!,
    completeFn: observedComplete,
  });
  console.log(
    JSON.stringify({
      candidates: candidates.length,
      reads: reads.map((read) => ({
        candidateId: read.candidateId,
        status: read.status,
        ...(read.status === 'failed' ? { failure: read.failure } : {}),
        manifest: read.manifest,
      })),
      tier2Results: report.tier2.length,
      warnings: report.warnings,
      requests: records,
    }),
  );
}

main().catch(() => {
  console.log(JSON.stringify({ diagnostic: 'failed', requests: records }));
  process.exitCode = 1;
});

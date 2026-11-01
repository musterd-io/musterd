import { describe, expect, it } from 'vitest';
import { inferQuestion } from './question.infer.js';
import { QuestionSchema } from './question.js';

describe('inferQuestion (ADR 781)', () => {
  it('catches a turn that ends on a yes/no offer, with Yes and No', () => {
    const q = inferQuestion(
      'Done: #3685 is merged.\n\n- the relay is deployed\n- cider is told\n\nWant me to start on 3a?',
    );
    expect(q).toEqual({
      text: 'Want me to start on 3a?',
      options: [{ label: 'Yes' }, { label: 'No' }],
    });
  });

  it('takes only the last sentence of the last paragraph, without markdown emphasis', () => {
    expect(
      inferQuestion('The fix is in. I checked the logs. **Shall I deploy it now?**')?.text,
    ).toBe('Shall I deploy it now?');
  });

  it('turns the list just before a choice into options, with consequences', () => {
    const q = inferQuestion(
      'Two ways to do it:\n\n1. **Ride the trace hook** — no reinstall\n2. A new Stop hook: its own marker\n\nWhich do you prefer?',
    );
    expect(q).toEqual({
      text: 'Which do you prefer?',
      options: [
        { label: 'Ride the trace hook', consequence: 'no reinstall' },
        { label: 'A new Stop hook', consequence: 'its own marker' },
      ],
    });
  });

  it('a plain question gets no options', () => {
    expect(inferQuestion('Where did you see the seeds error?')).toEqual({
      text: 'Where did you see the seeds error?',
    });
  });

  it('misses a question mid-message, and one that ends a code block or a quote', () => {
    expect(inferQuestion('Should I deploy? I went ahead and deployed it.')).toBeNull();
    expect(inferQuestion('Ran it:\n\n```\nproceed?\n```')).toBeNull();
    expect(inferQuestion('cider asked:\n\n> is that acceptable?')).toBeNull();
    expect(inferQuestion('')).toBeNull();
    expect(inferQuestion('   ?')).toBeNull();
  });

  it('a summary list before a yes/no offer is not a set of options', () => {
    const q = inferQuestion('Shipped:\n- #3685\n- #3686\n\nOK to close the lane?');
    expect(q?.options).toEqual([{ label: 'Yes' }, { label: 'No' }]);
  });

  it('always fits the question schema', () => {
    const long = `${'word '.repeat(80)}ok?`;
    const many = Array.from({ length: 12 }, (_, i) => `- option ${i} ${'x'.repeat(100)}`).join(
      '\n',
    );
    for (const msg of [long, `${many}\n\nWhich one?`]) {
      const q = inferQuestion(msg);
      expect(q).not.toBeNull();
      expect(QuestionSchema.safeParse({ ...q, inferred: true }).success).toBe(true);
    }
  });
});

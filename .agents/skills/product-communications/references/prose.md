# Prose: the tells sweep

Open for any public prose. This is sweep 6 in SKILL.md, in detail.

## Why this sweep exists

The hype ban is not enough any more. In 2024 at least 13.5% of PubMed abstracts
were processed by an LLM, and the excess words were almost all style words,
mostly verbs ([Kobak et al., Science Advances 2025](https://arxiv.org/html/2406.07016v5)).
So the tell is in how a thing is said.

Our readers catch it. A majority vote of five people who use LLMs often
misjudged 1 article in 300 ([Russell, Karpinska and Iyyer, ACL 2025](https://aclanthology.org/2025.acl-long.267)).
Developers are that audience. Machine-sounding copy costs us the reader before
the claim is read.

The patterns move with each model generation. The catalog below is dated; check
it against [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)
when a new model family ships, and update the date.

## The catalog (checked 2026-10-13)

Each pattern has a rewrite target. Fix the sentence; don't swap one tell for
another.

| Pattern | Looks like | Rewrite |
| --- | --- | --- |
| Copula avoidance | "serves as", "stands as", "functions as", "acts as" | "is". "The inbox serves as the hub" → "The inbox is the hub". |
| Trailing "-ing" analysis | "…, making it easier to review." "…, highlighting the need for…" | Delete it, or make it its own sentence with its own evidence. |
| Padded triad | "fast, reliable, and secure"; three clauses where one carries the weight | Keep the one item that matters. Use three only when there are three. |
| Inflated significance | "a pivotal moment", "plays a crucial role", "underscores", "a testament to" | Say what happened and let the reader weigh it. |
| Vague attribution | "experts say", "many teams find", "it is widely known" | Name the source and link it, or cut the sentence. |
| Tidy ending | "In short, …", "Ultimately, …", a closing line that restates the paragraph | End on the last concrete fact or the command to run. |
| Mirror contrast | "not just X but Y", "not only … but also", "X rather than Y" | State Y. (brand.md §4 bans the whole family.) |
| Elegant variation | "the platform", "the tool", "the system" for one thing | Repeat the glossary term. Repetition is clarity here. |
| Em-dash habit | Two or three dashes a paragraph | About one per paragraph at most; use a period. |
| Mechanical bold | Bold label, colon, sentence, on every bullet | Bold only what a skimming reader must not miss. |
| Chat residue | "Great question", "I hope this helps", "Let's dive in", "Here's the thing" | Delete. |
| Uniform rhythm | Every sentence 12–18 words | Vary length on purpose: a short sentence after a long one. |

## Dated word list (mid-2026)

The words below now read as machine-written because a plain voice drifts into
them once the hype words are gone. Treat them as tripwires: each hit needs a
reason to stay.

`challenge` (as a noun for a problem), `clearer`, `dependable`, `echoed`,
`foster`, `leverage`, `matters` (as in "this matters"), `multifaceted`,
`practical`, `prioritize`, `quietly`, `steady`, `universally`, plus `delves`
and `delve`, the word with the largest excess in Kobak et al.'s study.

Source: the mid-2026 tier in [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing);
`delve` from Kobak et al. The hype list in SKILL.md stays banned on top of these.

## Writing the fix

- **Concrete nouns and real verbs.** Name the command, the file, the member, the
  number. "Claims lane 01M4ECTZ84" beats "takes ownership of work".
- **Give the reason with the rule when you instruct a model.** Anthropic's
  guidance: say what to do, give the why, and anchor tone
  with 3–5 varied examples in `<example>` tags; the prompt's own style leaks into
  the output ([Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)).
  `examples.md` holds our examples.
- **Orwell's four questions** for each sentence: what am I trying to say, what
  words express it, what image or idiom makes it clearer, is it fresh enough to
  have an effect ([Politics and the English Language, 1946](https://www.orwellfoundation.com/the-orwell-foundation/orwell/essays-and-other-works/politics-and-the-english-language/)).
- **The representative reader.** Before the last pass, name one real reader (a
  developer who runs two agents on one repo and has never heard of musterd) and
  read the piece as them. Cut what they would skip.
- **Read it aloud once.** Rhythm problems and missing words show up spoken.

## When this sweep does not apply

- Code, commands, file paths, quoted output and other people's words. Leave them
  exactly as they are.
- A term of art that happens to be on the list ("landscape" as the name of
  `docs/design/landscape.md`). Mention it plainly.
- Words the glossary requires. The glossary wins over the list.

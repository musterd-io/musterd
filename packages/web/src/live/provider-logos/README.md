# Provider logos

Copied from the SandRise AI training deck Model landscape slide
(`~/lab/ai-training/sessions/the-meats/assets/logos/`). Brand chip colors live in
`modelProvider.ts`. Runtime markup is inlined in `modelProviderIcon.ts` so vitest/node
does not need Vite `?raw` — when a logo changes upstream, update both the file here and
the inline string.

`stepfun.svg`, `longcat.svg`, `antgroup.svg` (Ling) and `zai.svg` (GLM) were added 2026-10-19 from
`@lobehub/icons-static-svg@1.70.0`, flattened to one brand fill (no gradient ids — the inline
strings land in many plates at once). A lab with no logo anywhere (opencode's stealth models: beam,
fledge-alpha, space-bunny) gets no file: `providerIconHtml` gives it the model's initial in a stone
pin, and a seat with no model at all an empty ring — never a "?".

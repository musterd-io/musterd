/** Canonical brand mark SVG (ADR 702, superseding ADR 497 and ADR 154). Mirrors `docs/design/assets/chip.svg` — brand.test.ts pins the equality. */
export const CHIP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="musterd">
  <rect width="1024" height="1024" rx="307" fill="#F9DDA0"/>
  <rect x="8" y="8" width="1008" height="1008" rx="301" fill="none" stroke="#785A0A" stroke-opacity=".28" stroke-width="14"/>
  <rect x="95" y="95" width="834" height="834" rx="230" fill="none" stroke="#fff" stroke-width="72"/>
  <path d="M345 621V433M345 433L385 393Q395 385 411 385H446Q462 385 472 393L512 433M512 433L552 393Q562 385 578 385H613Q629 385 639 393L679 433M512 621V521M679 621V521" fill="none" stroke="#2E3647" stroke-width="72" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="345" cy="621" r="66" fill="#2E3647"/>
  <circle cx="512" cy="621" r="66" fill="#2E3647"/>
  <circle cx="679" cy="621" r="66" fill="#2E3647"/>
</svg>`;

/** Data URI for MCP `serverInfo.icons` (ADR 497). */
export function chipIconDataUri(): string {
  return `data:image/svg+xml;base64,${Buffer.from(CHIP_SVG).toString('base64')}`;
}

/** MCP protocol icon descriptors for the musterd adapter. */
export const MCP_ICONS = [
  {
    src: chipIconDataUri(),
    mimeType: 'image/svg+xml',
    sizes: ['any'] as string[],
  },
] as const;

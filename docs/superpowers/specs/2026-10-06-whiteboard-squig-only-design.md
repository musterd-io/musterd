# Whiteboard, Squig only — design

- Date: 2026-10-06
- Author: stanley (lane `01M49DRSSQXBH58SEWEMK2QP5M`), from the design conversation with nick on
  2026-10-06
- Goal: `launch` (unblocks lane `01M2PAMFW1`, the whiteboard leaving the monorepo)
- Status: design approved by nick 2026-10-06; the decision is recorded as one ADR in increment 1
  (number from `pnpm adr:next`)
- Builds on: ADR 330 (the whiteboard is its own package, behind a provider port, extractable at any
  time), ADR 524 (Squig adapter, Squig default, tldraw fallback), ADR 527 (one whiteboard MCP;
  Squig's tools on any board)

## 1. Outcome

`npx @musterd/whiteboard` gives a stranger a working shared board, with agents drawing on it, from
one command. They need no tldraw license, no Squig clone, and no build step. The published package
contains no tldraw code.

## 2. Why

nick parked lane `01M2PAMFW1` on 2026-10-02. The reason was that an npm publish would redistribute
tldraw, which `dist-web` bundles, and the only tldraw license available is a trial. ADR 524 made
Squig the default, but it kept tldraw as the fallback. The fallback is what a stranger gets: Squig
runs only from a local checkout that someone has built (`~/.squig/src` plus `pnpm build:local`),
and a stranger has neither. So the switch to Squig alone does not make the package publishable.
The package must contain Squig and must not contain tldraw.

## 3. Boundaries

**In:**

- An ADR that drops tldraw and bundles Squig.
- A vendor script that builds Squig at a pinned commit and writes the output into the package.
- The committed vendored output.
- Changes to the Squig adapter so that it runs the vendored companion.
- Removal of every tldraw part of `packages/whiteboard`.
- A one-time conversion of nick's one real tldraw board.
- Doc updates (SKILL.md, `content/roadmap.data.ts`).

**Out:**

- **The extraction and the publish.** Lane `01M2PAMFW1` keeps these, and it depends on this work.
- **A converter in the package.** No external user has a tldraw board. The one board worth keeping
  is converted once, by hand (§7).
- **Upstream changes to Squig.** We vendor Squig as it is. If Pablo publishes Squig to npm later,
  it can replace the vendored copy. Reopen trigger: a published `squig` package with the local
  companion in it.
- **Tracking Squig upstream automatically.** A new Squig version is a deliberate re-vendor PR.

## 4. What the vendored Squig must carry

We traced the companion's import graph from `scripts/squig.ts` at upstream commit `85f92ab`. The
adapter starts the companion as `squig.ts mcp <file> --port N` (ADR 524 §3).

- **52 source files** from `scripts/` and `lib/`.
- **npm packages:**
  - Pure JavaScript, all MIT: `@modelcontextprotocol/sdk`, `zod`, `nanoid`, `fontkit`, `roughjs`.
  - Native: `@resvg/resvg-js` (MPL-2.0) and `sharp` (Apache-2.0). `lib/agent/render.ts` loads both
    with dynamic imports. Both are needed for `render_document`, which ADR 527 exposes as
    `whiteboard_render`.
- **The local editor build, `out/` (7.1 MB).** The companion serves it to the browser. The file
  `out/.squig-local-editor.json` marks it as a local build.
- **Fonts, `lib/agent/fonts/` (1.0 MB).** These are Geist, Patrick Hand and Source Serif 4, all
  under the OFL. Their license files are in the same folder.

**Path constraint.** Squig finds the editor and the fonts relative to the module's own location,
not relative to the working directory:

- `lib/agent/local-server.ts`: `repo = <module dir>/../..`, then `out/` under that.
- `lib/agent/text-metrics.ts`: `<module dir>/fonts/`.

So the bundled companion must sit at `vendor/squig/lib/agent/companion.mjs`. Then `../..` resolves
to `vendor/squig/`, and `./fonts` resolves to `vendor/squig/lib/agent/fonts/`. With this layout no
Squig source is patched.

## 5. Design

### 5.1 The vendor script: `scripts/vendor-squig.mjs`

The script takes a pinned upstream commit and does these steps:

1. Make a shallow clone of `github.com/pablostanley/squig` at that commit into a temporary
   directory.
2. Run `pnpm install --frozen-lockfile`, then `pnpm build:local`. This produces `out/`.
3. Bundle `scripts/squig.ts` into one ESM file:
   - The `@/` alias and extensionless imports resolve the same way as in Squig's
     `loader-hooks.mjs`.
   - The pure-JavaScript packages are compiled into the file.
   - `@resvg/resvg-js` and `sharp` stay external.
   - The bundler is Rolldown, through the Vite 8 that the package already uses. So the script adds
     no new dev dependency.
4. Write the output to `packages/whiteboard/vendor/squig/`:
   - `lib/agent/companion.mjs`;
   - `lib/agent/fonts/` with its OFL files;
   - `out/`;
   - `LICENSE` (Squig's MIT notice);
   - `VENDORED.json`, holding the upstream commit, the date, and the versions of the externals.
5. Run a smoke test: start the companion on a temporary board, call `get_document` and
   `render_document`, and confirm that both answer.

The output is committed. CI never builds Squig. A Squig upgrade is a PR that runs the script again
with a new commit; the diff is the review.

### 5.2 The adapter runs the vendored companion

`src/squig/checkout.ts` gets a first candidate: the vendored companion inside the package. It
resolves this path from its own module location.

- The vendored companion is plain JavaScript. So it needs no `--experimental-strip-types` and no
  loader, and the Node floor is the package's own (`>=22`).
- `SQUIG_CHECKOUT` stays as an override, for testing against a newer upstream. The default no
  longer looks at `~/.squig/src`.
- `SquigCheckout` gains a `kind: 'vendored' | 'checkout'` field, so that the spawn arguments differ
  only where they must.

### 5.3 Package contents and dependencies

- `files` adds `vendor`. `dist-web` goes.
- `dependencies` add `@resvg/resvg-js` and `sharp`. They lose `@tldraw/store`, `@tldraw/sync`,
  `@tldraw/sync-core` and `@tldraw/utils`.
- `devDependencies` lose `tldraw`, `react`, `react-dom`, their types, and `@vitejs/plugin-react`.
  Vite stays only if the vendor script uses it.
- The ADR records the two native packages under hard rule 6. Alternative considered: making
  `whiteboard_render` optional and the native packages optional dependencies. We rejected it,
  because a render that silently disappears on some platforms is worse than a heavier install.
  Both packages ship prebuilt binaries for macOS, Linux and Windows.

### 5.4 tldraw is removed

These go:

- `src/tldraw/`, `src/sync/` (the tldraw sync room manager), `web/`, `vite.config.*` and
  `dist-web/`.
- The `/ws/:name` route, the static page, and `serveStatic()` in `src/service.ts`.
- `ProviderName`, the provider choice with its fallback reason, and `WHITEBOARD_PROVIDER`.
- The `TldrawProvider` and `RoomManager` exports in `src/index.ts`.

If Squig cannot start, the service now fails with the reason. Before, it fell back to tldraw. The
reason is the one that `probeSquigCheckout` already writes.

The `WhiteboardProvider` port stays. ADR 330's point was that a canvas swap is a new adapter, and
it is cheap to keep a port that has one implementation.

### 5.5 Docs

- The new ADR. It supersedes ADR 524 decision 2 (the fallback) and leaves the rest of ADR 524
  standing. It adds dated notes to the Consequences of ADR 524 and ADR 330.
- `packages/whiteboard/SKILL.md` loses its tldraw lines.
- The whiteboard entry in `content/roadmap.data.ts`, followed by `pnpm roadmap:gen`.

## 6. Error handling

- **The vendored companion is missing or cannot start** (for example, the native binary for this
  platform did not install). `whiteboard_open` returns the error with its cause. The service keeps
  running, so `whiteboard_list` still works.
- **`render_document` fails to load `sharp` or `resvg`.** The error passes through as Squig reports
  it. The other tools are unaffected, because Squig loads those packages only when it renders.
- **A file lock is held by a live owner.** This is unchanged: ADR 524 §3 respects it.

## 7. The existing tldraw boards

Three boards exist on nick's laptop, in `~/.whiteboard/boards/`. A copy of all three is saved to
`~/.whiteboard/boards-tldraw-archive-2026-10-06/` before anything changes.

| Board                     | Contents                                      | Action  |
| ------------------------- | --------------------------------------------- | ------- |
| `demo`                    | 3 notes, 3 arrows, 1 frame (1 Sep)            | Archive |
| `miley-accept-1144-probe` | 5 notes, 2 frames (1 Sep)                     | Archive |
| `musterd-user-agent-flow` | 191 notes, 78 arrows, 23 frames, 1 text (1 Sep) | Convert |

The conversion is a one-time script in the scratchpad, not in the repo. It reads the board with
`TldrawProvider.read()` and writes it with `SquigProvider.add()`, using the port both adapters
already implement. It makes one `add` call per original author, so each item keeps its
attribution. This keeps notes, clusters, membership, links and their labels. The one free
`text` item becomes a note. The script must run before increment 3 merges, because increment 3
deletes the tldraw adapter it reads with. Verification: the Squig board's `read()` has the same
counts of notes, clusters and links as the source.

## 8. Testing

- **Unit tests.**
  - `checkout.test`: the vendored path is resolved first, and `SQUIG_CHECKOUT` overrides it.
  - `service.test`: no fallback, and the failure reason surfaces.
- **Integration test.** `squig.integration.test.ts` runs today only when a checkout exists. With a
  vendored companion it always runs: it opens a board, adds a note, draws, renders, and confirms
  that the editor URL serves HTML.
- **The no-checkout proof.** The integration test runs with `HOME` pointed at an empty temporary
  directory. This proves that nothing reads `~/.squig/src`.
- **Pack check.** `npm pack --dry-run` lists no path containing `tldraw`. A test asserts that the
  package's dependency tree resolves no `tldraw` or `@tldraw/*` package.

## 9. Increments

| # | Lane | What lands | Done means |
| - | ---- | ---------- | ---------- |
| 1 | `01M49DRSSQXBH58SEWEMK2QP5M` | This spec; the ADR; `scripts/vendor-squig.mjs`; the committed `vendor/squig/`; the adapter prefers the vendored companion; native deps added | With `HOME` empty, the integration test opens, draws on and renders a Squig board. tldraw is still present. |
| 2 | `01M49DW741NDGNR1NCNYBWZJ5C` | `musterd-user-agent-flow` is converted, and all three boards are archived (local only, no PR) | The Squig board's `read()` counts match the source. |
| 3 | `01M49DWAA4DB6FJBPB1G98V0SP` | tldraw removed (§5.4); SKILL.md and roadmap updated | The pack check shows no tldraw anywhere; the gates pass. |
| — | `01M2PAMFW1` | Extraction to its own repo, and the npm publish | Its own lane; its dependency moves to increment 3. |

## 10. Risks

- **Package size.** The package gains about 7 MB for the editor, 1 MB for the fonts and about 1 MB
  for the companion. The native packages add their own install size: `sharp` with its libvips
  binary is about 18 MB on macOS arm64 (measured in Squig's install on 2026-10-06). This is acceptable for a tool installed once. Falsifier: if the first external
  installs complain about install time, revisit making `sharp` optional (it only normalizes WebP).
- **Squig changes upstream.** Our copy is pinned, so upstream changes reach us only through a
  re-vendor. A re-vendor that breaks the port is caught by the integration test.
- **Credit.** Squig is Pablo Stanley's. The vendored `LICENSE` keeps his notice. The package README
  in lane `01M2PAMFW1` names Squig and links to it.

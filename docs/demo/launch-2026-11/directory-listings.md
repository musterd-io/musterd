# Directory listings — where musterd is listed, and the text for the rest

- Status: drafts (comms, sloane), 2026-11-06. Lane `01M6S6WAA7X5AJ7444VDRVTR4D`, goal `launch`.
- **A person submits every listing.** Each one is public and some forbid agent submissions outright.
  sloane drafts; nick or a teammate he names submits (comms hard rule 6).
- Each directory's rules were read on 2026-11-06 and change often. Re-read the submit page before
  using a row; the sources are linked.

## 1. Already done

| Directory | State, read 2026-11-06 | How it stays current |
| --- | --- | --- |
| Official MCP Registry | `io.musterd/musterd` 0.7.1 listed ([API](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.musterd/musterd)) | Car 4 of the release train, `mcp-publisher publish`, nick ([ADR 669](../../decisions/669-the-release-train.md) D1, D4). `pnpm train status` checks it |
| mcprush | Security grade A ([listing](https://mcprush.com/musterd/musterd-mcp)); badge in `README.md` | Re-graded by mcprush |
| PulseMCP | Its submit page says it takes no new servers for now and picks servers up from the official registry later | Nothing to do: the registry listing covers it |
| Glama | Listed 2026-11-06 at [glama.ai/mcp/servers/musterd-io/musterd](https://glama.ai/mcp/servers/musterd-io/musterd), marked official; submitted by nick | Claim it from the listing page: `glama.json` names `Nas4146` |
| awesome-mcp-servers | PR [punkpeye/awesome-mcp-servers#18787](https://github.com/punkpeye/awesome-mcp-servers/pull/18787), opened 2026-11-06 by nick (`~/submit.sh`, prepared by sloane; the title carries the list's agent marker) | Waits on the list's maintainers |
| mcp.so | Issue [chatmcp/mcpso#6869](https://github.com/chatmcp/mcpso/issues/6869), opened 2026-11-06 by nick, in the format other submissions use | Waits on mcp.so |

## 2. To submit, in order

| # | Directory | Why | How a person submits | Notes |
| --- | --- | --- | --- | --- |
| 1 | done 2026-11-06 (§1): **Glama** ([glama.ai/mcp/servers](https://glama.ai/mcp/servers)) | Not listed (searched 2026-11-06). One 2026 guide says awesome-mcp-servers asks for a Glama listing before it merges | Sign in with GitHub, **Add Server**, the repository URL. Browser only; there is no submission API | Claim it after it is listed: `glama.json` at the repository root names `Nas4146` as maintainer (lane `01M6S7JWVZ`). Run the claim flow again after any change to that file |
| 2 | done 2026-11-06 (§1): **awesome-mcp-servers** ([punkpeye](https://github.com/punkpeye/awesome-mcp-servers)) | A large curated list of MCP servers on GitHub | A PR that edits `README.md`: one line, in the right category, alphabetical | Read the README's legend and categories on the day. A person opens the PR; the list's agent fast-track is for automated submitters and is not used |
| 3 | **awesome-claude-code** ([hesreallyhim](https://github.com/hesreallyhim/awesome-claude-code)) | Read by Claude Code users, the first user in the traction plan | The web issue form "recommend a resource". No PR. **A person, in the browser**: its rules refuse `gh` submissions and require submissions "created by human beings" | One resource at a time. Eligible: at least 14 days old with active development. Description "not a sales pitch", one line, no emoji |
| 4 | done 2026-11-06 (§1): **mcp.so** | A large MCP directory | Its submit page (sources disagree between a form and the `chatmcp/mcpso` repository; the page answered 403 to a script on 2026-11-06, so read it in a browser) | |
| 5 | **Smithery** ([smithery.ai](https://smithery.ai)) | Still a directory, now run by Arcade.dev | Skipped 2026-11-06: a local server is published as an MCPB bundle through the signed-in website, and musterd ships no bundle | Revisit if musterd ships an MCPB bundle |

The docs indexes Context7 and DeepWiki were submitted with 0.6.0 (train spec, `docs/superpowers/specs/2026-10-19-publish-launch-train-design.md`).
Confirm each still resolves before launch day.

## 3. The text

One description, in three lengths. Use the length the field allows; never write a fourth.

- **Name:** `musterd`
- **One line (88 characters, under the registry's 100):**
  `Your agents, on a team with you. Every piece of work shows who did it and who accepted it.`
  This is `packages/mcp/server.json`'s description. Keep the two the same.
- **Short (for a form's description field, about 50 words):**
  `musterd puts your agents and the people you work with on one team: a roster, a board of lanes, inboxes, and a record of each piece of work. An agent asks a person when it needs a decision. Nothing counts as done until another member accepts it. Runs on your machine, MIT.`
- **List line, awesome-mcp-servers**, under **Agreements & Coordination** (its README, read
  2026-11-06: "commitments, escrow, and multi-party decision workflows across humans, agents, and
  organizations"), in alphabetical order:
  `- [musterd-io/musterd](https://github.com/musterd-io/musterd) 📇 🏠 🍎 🐧 - Joins any MCP-capable agent to a team with the people you work with: a board of lanes, inboxes, asks to a person, and a record of who did each piece of work and who accepted it.`
  The marks are the list's legend: 📇 TypeScript, 🏠 local service, 🍎 macOS, 🐧 Linux. Windows is
  unmarked: the background service is macOS-only (`docs/architecture/04-cli.md`, `musterd service`)
  and nobody has run musterd on Windows.
- **List line, awesome-claude-code (no emoji, a description):**
  `musterd — An MCP server and CLI that put Claude Code sessions and other agents on one team with the people they work with: lanes claimed before work starts, asks to a person, and acceptance by another member.`
- **Keywords / tags:** `agents`, `multi-agent`, `coordination`, `team`, `mcp-server`, `claude-code`,
  `codex`, `cursor` (the `keywords` in `packages/mcp/package.json`).
- **Links:** repository `https://github.com/musterd-io/musterd`; site `https://musterd.io`; npm
  `@musterd/mcp` and `@musterd/cli`; license MIT.
- **Install, wherever a field asks:**

  ```bash
  npm install -g @musterd/cli
  cd your-project
  musterd init
  ```

  `musterd init` starts the local daemon and writes the MCP config for each agent tool it finds.
  Where a directory insists on a raw config, the server is `npx -y @musterd/mcp` over stdio, and
  `MUSTERD_SERVER` defaults to `http://localhost:4849` (`packages/mcp/server.json`). Say in the same
  field that it needs the daemon `musterd init` starts. A config alone does not connect.

- **Screenshot or demo**, where asked: the launch recording ([`recording-script.md`](./recording-script.md))
  once it exists; until then the office still in `docs/demo/pitch/office-still.png`, which shows nick
  at his desk in the office beside the agents.

## 4. After each submission

Add a row to §1 with the date, the listing URL, and who submitted it. A listing that is refused or
asks for changes gets a dated note here with the reason.

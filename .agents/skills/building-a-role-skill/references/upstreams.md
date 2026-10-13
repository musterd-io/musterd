# Upstreams: what to adapt, under which licence, with what credit

Open for step 3 of the method.

## Where to look

- Published agent skills: GitHub searches such as `SKILL.md <craft>`, `<craft> claude skill`,
  `<craft> agent skill`; curated lists of agent skills; the skills directories of the agent
  vendors.
- Rule sets that encode a craft: Vale style packages, company style guides published as
  repositories, linters for the craft.
- Standards and guides with open licences (for example, the Google developer documentation style
  guide is CC BY 4.0).

## Record each candidate

For every repository you might adapt from, before reading it closely:

```sh
gh api repos/<owner>/<repo> -q '.license.spdx_id, .stargazers_count, .pushed_at'
git clone --depth 50 https://github.com/<owner>/<repo> && git -C <repo> rev-parse HEAD
```

Keep: owner/repo, licence (SPDX id), last push, the HEAD commit you read, the files that matter,
and a one-line verdict on quality. Stars are a weak signal; read the files.

## Licence check

Adapt only from licences your team accepts. musterd's list (ADR 579):

| Class | Licences | Use |
| --- | --- | --- |
| Accepted | MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, CC0-1.0, CC-BY-4.0 | Adapt, pin the commit, keep the licence text |
| Reference only | CC BY-SA, GPL, AGPL, LGPL, MPL, non-commercial (CC BY-NC*), no licence, custom terms | Read and cite with a link; adapt nothing |

Extra duties: keep an Apache-2.0 `NOTICE` file; never use BSD-3 authors' names to promote your
product; for CC BY, credit the work, link the licence and say what you changed.

## Lineage check

When an accepted-licence upstream credits a source under a reference-only licence (a skill built on
a CC BY-SA wiki page, say), check that it did not copy that source's text. Compare runs of eight
words:

```python
import re, sys
def toks(path):
    return re.findall(r"[a-z0-9']+", open(path).read().lower())
a, b = toks(sys.argv[1]), toks(sys.argv[2])   # upstream file, the credited source
grams = {tuple(b[i:i + 8]) for i in range(len(b) - 8)}
hit = {j for i in range(len(a) - 8) if tuple(a[i:i + 8]) in grams for j in range(i, i + 8)}
print(f"{len(hit)} of {len(a)} words in shared 8-word runs ({100 * len(hit) / len(a):.1f}%)")
```

Read every shared run. Shared runs inside quoted examples are expected; shared runs in the rules
mean the text came across. Record the method, the percentage and your verdict in `PROVENANCE.md`.

## Adapting

- Rewrite in your team's voice from the upstream's ideas and structure. Never copy a file whole.
- Write your own examples. An upstream's examples carry its domain and sometimes its sources' text.
- Drop what conflicts with your team's rules. Copywriting formulas, for instance, often break a
  team's voice rules.
- Copy the upstream's licence to `LICENSES/<repo>.LICENSE` and add a row to `PROVENANCE.md`:

```
| [owner/repo](https://github.com/owner/repo) | `<commit>` | <SPDX> | <which files> → <which of your references> |
```

When an upstream moves, re-read what changed before re-pinning, and say in `PROVENANCE.md` what you
took from the new commit.

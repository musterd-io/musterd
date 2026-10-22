#!/usr/bin/env python3
"""Cut the three Recursive faces the web type tokens used (ADR 477).

ADR 706 (2026-10-21) replaced these outputs. The web, the console and allowance
no longer ship them. A rerun writes recursive-*.woff2 back into
packages/web/src/styles/fonts/, and those names fail the font allowlist.
The three cuts dated decks still load live in docs/demo/fonts/.

Recursive is one variable family with MONO and CASL axes. CSS cannot pin those
axes per family name in every browser, and canvas cannot set them at all, so we
instance the upstream latin variable font into three families that each keep
only a 400-800 weight axis:

  recursive-casual.woff2  CASL=1 MONO=0  display: headings, member names
  recursive-linear.woff2  CASL=0 MONO=0  body text
  recursive-mono.woff2    CASL=0 MONO=1  data: timestamps, ids, the CLI mirror

Usage: python3 scripts/fonts/instance-recursive.py <recursive-latin-full-normal.woff2>
Get the input with `npm pack @fontsource-variable/recursive@5.3.0` (OFL-1.1).
Needs fonttools with brotli. The outputs are committed; rerun only to re-cut.
"""
import os
import sys

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'packages', 'web', 'src', 'styles', 'fonts')
FACES = {
    'casual': {'CASL': 1, 'MONO': 0},
    'linear': {'CASL': 0, 'MONO': 0},
    'mono': {'CASL': 0, 'MONO': 1},
}

src = sys.argv[1]
for name, axes in FACES.items():
    font = instancer.instantiateVariableFont(
        TTFont(src), dict(axes, slnt=0, CRSV=0.5, wght=(400, 800))
    )
    font.flavor = 'woff2'
    out = os.path.join(OUT, f'recursive-{name}.woff2')
    font.save(out)
    print(out, os.path.getsize(out))

# Charts: form, honesty, contrast, render and look

Open for any chart, graph, number tile, diagram or figure that carries a number.

## 1. Form: pick the chart from the question

Name the relationship first, then the chart. The FT Visual Vocabulary groups
charts into nine families: deviation, correlation, ranking, distribution, change
over time, magnitude, part-to-whole, spatial, flow
([FT chart-doctor](https://github.com/Financial-Times/chart-doctor/tree/main/visual-vocabulary)).

Within a family, use the encoding people read most accurately. Position on a
common scale beats length, which beats angle and area, with color last
([Cleveland and McGill 1984](https://doi.org/10.1080/01621459.1984.10478080);
replicated by [Heer and Bostock 2010](https://homes.cs.washington.edu/~jheer/files/2010-MTurk-CHI.pdf)).

- One or two numbers: a number tile with its label and source. No chart.
- A before and after: two bars on a zero baseline, or the two numbers side by
  side.
- Performance and latency: show the distribution (dots, a box or percentiles).
  Mean bars hide the spread ([Weissgerber et al., PLOS Biology](http://journals.plos.org/plosbiology/article?id=10.1371/journal.pbio.1002128)).
- Seven series at most; fewer is better.

## 2. Honesty gate

- Bars and areas start at zero. A line chart may start above zero only when the
  effect justifies it, and the axis says so. Truncation inflates the perceived
  effect even when it is visibly marked
  ([Correll, Bertini and Franconeri, CHI 2020](https://www.tableau.com/research/publications/truncating-y-axis-threat-or-menace)).
- One y-axis. No dual axes.
- Every headline number carries its denominator, its window and n.
- A source line under every chart: the command, query or SHA, and the date read.
  The same number has a ledger row (hard rule 4).
- The title states the takeaway, and the takeaway is what the data shows.
- Label lines and bars directly; use a legend only when direct labels cannot fit.

The Urban Institute's style guide codifies most of these and is Apache-2.0
([Urban Institute](https://urbaninstitute.github.io/graphics-styleguide/)).

## 3. Brand tokens that pass contrast

One accent: color the one series the title is about, grey the rest. The catch: a
brand accent is often too light to use as a mark. WCAG 2.2 requires 3:1 for chart
marks against their background
(SC 1.4.11, [W3C](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)),
and a yellow or a pastel can fall well short on white. Compute each brand color's
ratio against both theme backgrounds with the WCAG formula, pick the shades that
pass for marks and for text in each theme, and keep the table in `team.md`. Never
use rainbow or jet scales, and never carry meaning by hue alone.

SC 1.4.11 does not apply when every value is also shown as a label or in a table,
so direct labels serve honesty and accessibility at once. Make them the default.

## 4. Render and look

LLM-generated charts fail in known ways: fields mapped to the wrong axis,
overlapping labels, poor scales, missing legends ([VisEval, IEEE VIS 2024](https://arxiv.org/pdf/2407.00981)).
Vision models also misjudge whether a chart misleads
([arXiv 2502.20503](https://arxiv.org/pdf/2502.20503v2)). So:

1. Compute every coordinate in code from the source data. Never type a data point
   by hand.
2. Assert n, min, max and sum in that code against the source.
3. Render to an image in the light theme, the dark theme and at phone width.
4. Look at each image yourself.
5. Reconcile every number in the title, labels, alt text and surrounding copy
   with the data.

When the session cannot run code or render, still deliver the chart: work the
coordinates out from the data step by step and show the arithmetic, check n, min,
max and sum by hand, and hand back the SVG marked "not rendered", with steps 3 and
4 left as the requester's to do before it ships. A plan instead of a chart helps
nobody. When `team.md` has no palette yet, use a neutral grey for marks and dark
text for labels, and say the brand shade is still to choose.

## 5. Accessibility deliverables

Each chart ships with a short alt text (what it shows and the takeaway, about one
sentence) and either a long description or the data as a table next to it. That
two-part pattern is W3C's for complex images
([W3C complex images](https://www.w3.org/WAI/tutorials/images/complex/)).
In SVG, give the figure `role="img"` with `<title>` and `<desc>`.

## Libraries

Hand-written SVG or HTML from computed data is the default. When a chart needs
real axes, scales or more than two series, use a pinned library rendered to static
SVG at build time. A library is a dependency decision; `team.md` names the one the
team accepted.
Compute contrast with the WCAG formula in a few lines of code; no color library.

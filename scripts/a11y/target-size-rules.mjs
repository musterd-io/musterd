/**
 * The 2.5.8 judging rules — pure geometry, no browser.
 *
 * Kept apart from `target-size-sweep.mjs` on purpose: the sweep needs Chrome to READ a page, and
 * these rules need nothing to DECIDE one. A rule that can only be exercised by standing up a
 * browser gets exercised rarely and reasoned about instead, and the spacing exception is far too
 * fiddly to be reasoned about — it is the clause that decides whether an undersized target is a
 * defect or a conformance, and getting it wrong in the permissive direction makes the whole gate
 * decorative. So it is unit-tested against the spec's own worked shapes (`target-size-rules.test.ts`).
 *
 * A "target" here is `{ x, y, w, h, inline, essential, name, sel }` in CSS px, viewport-relative —
 * exactly what the in-page walker returns.
 */

/** WCAG 2.2 AA. (AAA is 44; the iOS HIG asks 44pt. This gate holds the AA line.) */
export const MIN = 24;

/**
 * THE HOUSE FLOOR — stricter than the spec, on the shared chrome only, and labelled as such.
 *
 * This exists because measuring settled a question the 2026-09-21 audit got wrong. That audit
 * called the 21-22px nav and footer links a 2.5.8 defect. They are not: nothing sits within 12px
 * of their centres, so the SPACING exception applies and they conform. Falsified directly — the
 * built nav shrunk back to 20px and re-swept still passed, as `spacing` (2026-09-21, lane
 * 01M32HG5GJ). A gate that failed them would be failing conforming markup, which is how a gate
 * gets switched off.
 *
 * But the team did not decide "conform to 2.5.8"; it decided the shared chrome gets 24px, and
 * landed that as min-heights (lane 01M32GF49Z). Conforming is not the same as comfortable, and a
 * 21px link on a phone is a thing you miss twice before you hit it — the iOS HIG asks 44pt for
 * the same reason.
 *
 * So both are enforced and they are never conflated. A house-floor row says HOUSE FLOOR, never
 * "below AA", so nobody reports a house preference as a WCAG failure to anyone outside this repo.
 * The scope is deliberately the shared chrome and nothing else, because that is exactly what was
 * decided: prose links are judged by the spec alone, and the 22px links in `/docs`'s lists are
 * reported as conforming-on-spacing rather than failed.
 */
export const HOUSE_FLOOR_SCOPE = 'header, footer, nav';

export const centre = (t) => ({ x: t.x + t.w / 2, y: t.y + t.h / 2 });
/** Distance from a point to a rect (0 when inside). The spec's circle-reaches-a-target test. */
export const distToBox = (p, b) => {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
  return Math.hypot(dx, dy);
};
export const overlaps = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Decide one target, and say which clause decided it.
 *
 * Order matters and is the spec's: essential and inline are exceptions to the criterion, so they
 * are read before size. Overlap is judged separately for everyone — see the header.
 */
export const judge = (t, all) => {
  if (t.essential !== null && t.essential !== undefined)
    return { verdict: 'essential', why: t.essential };
  /* Before the spec clauses, because it is stricter than all of them and because a chrome link
     that passes on spacing must still not pass here. See HOUSE_FLOOR_SCOPE for why this tier
     exists at all and why it is never reported as a WCAG failure. */
  if (t.chrome && (t.w < MIN || t.h < MIN))
    return {
      verdict: 'house',
      why:
        `${Math.round(t.w)}×${Math.round(t.h)} in the shared chrome, under the house ${MIN}px ` +
        'floor (it CONFORMS to 2.5.8 on spacing — this is the stricter line the team set in ' +
        'lane 01M32GF49Z, not a WCAG failure)',
    };
  if (t.inline) return { verdict: 'inline', why: 'in a sentence (2.5.8 inline exception)' };
  if (t.w >= MIN && t.h >= MIN)
    return { verdict: 'size', why: `${Math.round(t.w)}×${Math.round(t.h)}` };

  const c = centre(t);
  const others = all.filter((o) => o !== t);
  const crowdedBy = others.find((o) => distToBox(c, o) < MIN / 2);
  if (crowdedBy)
    return {
      verdict: 'fail',
      why:
        `${Math.round(t.w)}×${Math.round(t.h)} is under ${MIN}×${MIN}, and its ${MIN}px circle ` +
        `reaches "${crowdedBy.name || crowdedBy.sel}" (${distToBox(c, crowdedBy).toFixed(1)}px away)`,
    };
  const tooClose = others
    .filter((o) => o.w < MIN || o.h < MIN)
    .find((o) => Math.hypot(c.x - centre(o).x, c.y - centre(o).y) < MIN);
  if (tooClose)
    return {
      verdict: 'fail',
      why:
        `${Math.round(t.w)}×${Math.round(t.h)} is under ${MIN}×${MIN}, and another undersized ` +
        `target "${tooClose.name || tooClose.sel}" is inside its ${MIN}px circle`,
    };
  return {
    verdict: 'spacing',
    why: `${Math.round(t.w)}×${Math.round(t.h)}, undersized but clear by ${MIN / 2}px+`,
  };
};

/**
 * Is a target out of reach — none of it can be brought on screen, or only a sliver under the size it
 * has? Returns the reason, or null when it can be reached. `reach` is the sweep's measure: the part
 * of the box any scroll can show (absent when not measured).
 *
 * Its own tier, like the house floor, and never counted as a 2.5.8 failure: 2.5.8 judges a target's
 * size, and these pass it. They fail because no finger gets to them at all, which no size clause
 * asks (lane 01M59782TX: five 30×30 /live topbar buttons sat past a phone's right edge and passed
 * SIZE, #2879). A target cut to less than its own size but still ≥24 in both directions is
 * reachable: half of a 62px pill is still a 31px target.
 */
export const offscreen = (t) => {
  if (t.reach === undefined) return null;
  if (t.reach === null) return 'no part of it can be scrolled on screen';
  const cutW = t.reach.w < Math.min(t.w, MIN);
  const cutH = t.reach.h < Math.min(t.h, MIN);
  if (!cutW && !cutH) return null;
  return (
    `only ${Math.round(t.reach.w)}×${Math.round(t.reach.h)} of its ` +
    `${Math.round(t.w)}×${Math.round(t.h)} can be scrolled on screen`
  );
};

/**
 * Every PARTIALLY overlapping pair.
 *
 * Not folded into `judge` because overlap is a property of the pair, and because it applies to
 * targets that are each comfortably ≥24×24 — the exact case the 01M32GF49Z fix hit, where a first
 * cut traded a small-target violation for an overlap one and only measuring caught it.
 *
 * CONTAINMENT IS NOT OVERLAP. A button inside a card that is itself a link is a nesting: the inner
 * one is the target, the outer is its container, and both are reachable. Only partial overlap is
 * the failure, where neither target can be hit reliably. Without this carve-out the gate fires on
 * every well-formed composite control on the site and gets muted within a week.
 */
export const overlappingPairs = (targets) => {
  const out = [];
  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      const a = targets[i];
      const b = targets[j];
      // A finger lands on what is VISIBLE. `vis` is the part of a target left after the scroll
      // containers around it clip it (absent when nothing clips it, null when it is wholly scrolled
      // out of view). A row three screens down inside a list that scrolls has a rect that can sit
      // exactly under the ticker, and no finger can put it there — judged on that rect, a
      // well-formed scrolling list fails against whatever abuts its edge (the Now panel, 2026-10-09).
      // SIZE is still judged on the full box: a row half-scrolled is not an undersized target.
      if (a.vis === null || b.vis === null) continue;
      const va = a.vis ?? a;
      const vb = b.vis ?? b;
      if (!overlaps(va, vb)) continue;
      const contained =
        (va.x <= vb.x &&
          va.y <= vb.y &&
          va.x + va.w >= vb.x + vb.w &&
          va.y + va.h >= vb.y + vb.h) ||
        (vb.x <= va.x && vb.y <= va.y && vb.x + vb.w >= va.x + va.w && vb.y + vb.h >= va.y + va.h);
      if (contained) continue;
      out.push([a, b]);
    }
  }
  return out;
};

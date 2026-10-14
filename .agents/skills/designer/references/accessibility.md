# Accessibility

Open for contrast, focus, targets, keyboard and pointer access, screen readers, canvas scenes and
live updates. WCAG 2.2 AA is the floor; criterion numbers point to W3C's Understanding documents,
which are cited and never adapted (W3C Document License).

## 1. Where real products fail

The WebAIM Million (2026) found detected WCAG failures on 95.9% of home pages: low-contrast text on
83.9%, missing alt text on 53.1%, unlabeled inputs on 51%, empty links on 46.3%, empty buttons on
30.6% ([WebAIM](https://webaim.org/projects/million/), cited). Check those first.

## 2. The criteria that matter most here

| Criterion | Rule | Common miss |
| --- | --- | --- |
| 1.4.3 Contrast (text) | 4.5:1, or 3:1 for large text | Fill tokens reused as text; dimming with opacity |
| 1.4.11 Non-text contrast | 3:1 for chart marks, icons, focus rings, input borders | An accent on white |
| 1.4.1 Use of color | Meaning also in a word, glyph or shape | Status dots alone |
| 2.4.7 Focus Visible / 2.4.11 Focus Not Obscured | A visible focus ring that sticky headers and footers do not cover; on light surfaces a light accent ring needs a dark second ring | Sticky bars over the focused row; fix with `scroll-padding` |
| 2.5.8 Target size | At least 24×24 CSS px, or 24 px spacing | Icon buttons in toolbars |
| 2.5.7 Dragging movements | A single-pointer way to do what dragging does ("Move to…", arrow buttons) | Boards with drag-only reordering; keyboard support alone does not satisfy it |
| 1.4.10 Reflow | Usable at 320 CSS px wide without two-way scrolling | Wide tables and fixed stages |
| 2.2.2 Pause, stop, hide (Level A) | Anything moving or auto-updating for more than 5 s beside other content has a visible pause that resumes at the current state | Live dashboards; reduced motion alone does not satisfy it |
| 2.3.3 Animation from interactions (AAA) | Interaction-triggered motion can be turned off | Honor `prefers-reduced-motion` |
| 4.1.2 Name, role, value | Every control has an accessible name and the right role | `div` buttons, icon-only buttons |

## 3. Canvas, SVG and animated scenes

- A canvas is invisible to assistive technology. Give it `role="img"` and a name, and put the
  information it shows in the page as real text (a list or table next to it).
- Live announcements: at most two live regions, present at page load (one polite, one assertive).
  Insert each message whole, keep it short, and clear the region afterwards. Never put controls
  in a live region. Screen-reader and browser pairs differ, so test (after Sara Soueidan, cited).
- A scene that changes constantly must not announce every change. Announce what a person would act
  on, and let them read the rest on demand.

## 4. Testing

- **Automated checks catch part of it.** axe-core reports about 57% of issues by volume in Deque's
  own study, and is commonly quoted as covering 20–30% of WCAG success criteria; each figure counts
  something different (`PROVENANCE.md`). Uncertain results come back "incomplete" and need a person.
- **Manual pass, every surface change**:
  1. Tab through the whole surface: every control reachable, focus always visible, order sensible.
  2. Operate every control without a mouse, and every drag without dragging.
  3. Zoom to 200% and narrow to 320 px.
  4. Turn on reduced motion and check nothing important disappeared.
  5. Run a screen reader (VoiceOver on macOS, NVDA on Windows) over the page title, headings,
     landmarks, one task and one live update.
- **Contrast is measured on the painted pixels** where it can be, because opacity, overlays and
  blending change what the token says.

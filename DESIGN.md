# Design guide: "Calendly B" (pure white, hairlines)

Paste this file (and the reference screenshot `calendly-b-reference.jpg`) into your coding agent or design tool as the UI spec.

## Prompt (paste-ready)

> Build the UI in the "Calendly B" style described in DESIGN.md: an all-white product UI with no shadows, where panels are separated only by thin blue-grey hairlines. Navy ink for text, one bright blue (#006bff) for actions, selection and the primary data series, and quiet blue-greys for everything else. Plus Jakarta Sans throughout. Rounded 12px panels, fully rounded pill buttons and chips, generous whitespace, tabular numbers. Use the CSS tokens in DESIGN.md exactly; do not introduce new colours, shadows, gradients or fonts. Match the reference screenshot's spacing and hierarchy.

## Character

- **Calm and clean.** White everywhere; structure comes from 1px hairlines, not shadows or fills.
- **Blue does the work.** #006bff is the only saturated colour besides green/red for change. It means "act here" or "this is you".
- **Navy, not black.** All text is navy or blue-grey, which keeps it soft but readable.
- **Friendly geometry.** Pill buttons and chips, 12px panel corners, airy padding.
- **Numbers first.** Big bold metrics, small muted context underneath (counts, intervals).

## Tokens

```css
:root {
  /* surfaces */
  --bg: #ffffff;            /* page, sidebar, panels: all white */
  --line: #e3eaf3;          /* hairlines: panel borders, dividers, table rows */
  --blue-soft: #eef4ff;     /* selected nav item, highlighted table row, active segment */

  /* text */
  --ink: #0b3558;           /* headings, body, numbers */
  --ink-2: #476788;         /* secondary text, nav items, table headers */
  --faint: #7d93ab;         /* meta, captions, axis labels, group labels */

  /* accent + data */
  --blue: #006bff;          /* primary buttons, links, focus, selection, "you" series */
  --series-2: #476788;      /* other series, darkest first */
  --series-3: #a9b8c9;
  --series-4: #d3dce7;
  --positive: #0a8a5f;      /* increases */
  --negative: #d93a3a;      /* decreases, errors */
  --notice-bg: #fff8e6;     /* rare warning badge */
  --notice-ink: #8a5a00;

  /* type */
  --font: "Plus Jakarta Sans", system-ui, -apple-system, sans-serif;

  /* shape + rhythm */
  --radius-panel: 12px;
  --radius-control: 999px;  /* buttons, chips, filters, badges */
  --radius-small: 6px;      /* tags, avatars, segmented items */
  --hairline: 1px solid var(--line);
  --gap: 16px;              /* between panels */
  --pad: 16px;              /* inside panels */
}
```

Load the font: `https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap`

## Typography

| Role | Size / weight | Colour | Example |
|---|---|---|---|
| Page title | 28 / 600, letter-spacing -0.01em | --ink | Overview |
| Section / panel title | 14 / 600 | --ink | Top brands · Visibility |
| Body, controls, nav | 14 / 400 (nav 14 / 500) | --ink or --ink-2 | Which AI answers name you… |
| Metric | 26 / 700, tabular-nums | --ink | 53.0% |
| Change next to metric | 12.5 / 600 | --positive / --negative | +12.0 |
| Meta / evidence | 11.5 / 400 | --faint | 2,212 of 4,176 answers · 95% CI 51.5–54.5% |
| Sidebar group label | 12 / 500 | --faint | Optimize |

Use `font-variant-numeric: tabular-nums` for every number in tables and metrics.

## Layout

- **Sidebar** ~230px, white, separated from content by a hairline. Logo top-left (blue rounded-square mark + bold name). Group labels in --faint, items 14px --ink-2 with 16px line icons; the active item gets a --blue-soft fill, --blue icon and --ink text, radius 8px.
- **Top bar** 48px, white, hairline bottom. Breadcrumb left (--ink-2 › --ink). Right: a small green dot + "Updated 4 min ago" in --faint, then pill buttons.
- **Filter row** under the top bar: pill dropdowns on the left (Brand ▾, Last 30 days ▾, All filters ▾); secondary pill buttons on the right with one blue primary (Share).
- **Content**: page title + one-line --ink-2 subtitle, then panels on a 16px grid. Panels are white with a hairline border and 12px radius. **No box-shadows anywhere.**

## Components

- **Primary button**: pill, height 32px, padding 0 14px, --blue background, white 14/600 text. Hover: slightly darker blue.
- **Secondary button / filter chip**: pill, height 32px, white, hairline border, --ink 14/500 text. Hover: --blue-soft background.
- **KPI strip**: one panel split into equal cells by vertical hairlines. Each cell: label (13 --ink-2) with an ⓘ icon at right in --faint, metric (26/700), change inline, then two lines of meta (--faint).
- **Chart panel**: title left; a small segmented control right (D / W / M, --blue-soft on the active item). Gridlines dashed --line, axis labels --faint 11px. The "you" series is a 2px --blue line with dots; competitors are 1.5px lines in --series-2..4. Legend below with short line swatches.
- **Table**: header row in --ink-2 13/500 with a hairline under it; rows 44px separated by hairlines; numbers right-aligned. Highlight "your" row with a --blue-soft background and a small "You" label in --blue. Brand avatars are 18px rounded squares with a letter.
- **List rows** (e.g. recent chats): a small outlined tag (radius 6, hairline, 11.5px --ink-2), a 14px --ink title, a --faint meta line underneath, and a value right-aligned.
- **Badge / notice**: pill, --notice-bg with --notice-ink text and a thin matching border. Use rarely.
- **Focus**: 2px --blue outline, 2px offset, on every interactive element.

## Do / don't

- Do keep everything white; separate with hairlines and spacing.
- Do reserve --blue for actions, selection, focus and "you".
- Do show context under numbers (counts, intervals) in --faint.
- Don't add shadows, gradients, coloured backgrounds or extra accent colours.
- Don't use pure black text or square buttons.
- Don't colour competitors brightly; they stay in blue-greys so "you" stands out.

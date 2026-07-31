# Block-aware pagination smoke test

This fixture is intentionally long enough to produce several terminal/PNG preview pages. Page boundaries should move between major blocks rather than cutting through a heading group, diagram, code block, table row, or ordinary list item.

The first page may be shorter than the fixed target height when keeping the next fitting block intact requires an earlier cut. That trade-off is intentional: a clean semantic boundary is preferable to a fuller page with clipped content.

## Diagram that should stay intact

```mermaid
flowchart LR
  source[Markdown source] --> parse[Pandoc]
  parse --> render[Browser render]
  render --> split[Block-aware pages]
  split --> terminal[Terminal preview]
  classDef input fill:#f8f9fa,stroke:#868e96,stroke-width:2px
  classDef process fill:#fff3bf,stroke:#f08c00,stroke-width:2px
  classDef output fill:#f3f0ff,stroke:#7950f2,stroke-width:2px
  class source input
  class parse,render,split process
  class terminal output
```

> This blockquote belongs to the introductory material. It contains enough text to make the first prospective fixed-height cut land inside the code block below. The new paginator should instead move that cut to the code section boundary.
>
> A second paragraph exercises spacing inside the same top-level blockquote without creating an artificial page boundary.

## Code block that should stay intact

The heading and the following code block should appear on the same page. Numbered comments make an accidental cut easy to spot.

```typescript
interface PageSlice {
  index: number;
  y: number;
  height: number;
  reason: "block-boundary" | "fixed-fallback";
}

const observations = [
  "line 01 — measure the rendered document",
  "line 02 — collect top-level block positions",
  "line 03 — identify headings",
  "line 04 — keep headings with following content",
  "line 05 — protect fitting paragraphs",
  "line 06 — protect fitting diagrams",
  "line 07 — protect fitting code blocks",
  "line 08 — protect fitting tables",
  "line 09 — inspect oversized lists",
  "line 10 — collect list-item boundaries",
  "line 11 — inspect oversized tables",
  "line 12 — collect table-row boundaries",
  "line 13 — preserve maximum page count",
  "line 14 — prefer a nearby semantic cut",
  "line 15 — allow a deliberately short page",
  "line 16 — retain a hard-cut fallback",
  "line 17 — avoid zero-height slices",
  "line 18 — keep slices contiguous",
  "line 19 — cover the complete render height",
  "line 20 — invalidate old fixed-slice caches",
  "line 21 — render the first page",
  "line 22 — render the second page",
  "line 23 — render the third page",
  "line 24 — cache each page independently",
  "line 25 — restore cached page counts",
  "line 26 — preserve PNG intrinsic dimensions",
  "line 27 — preserve terminal navigation",
  "line 28 — preserve browser preview behavior",
  "line 29 — preserve PDF behavior",
  "line 30 — preserve Mermaid rendering",
  "line 31 — preserve annotation rendering",
  "line 32 — preserve syntax highlighting",
  "line 33 — preserve theme colors",
  "line 34 — verify dark mode",
  "line 35 — verify light mode",
  "line 36 — verify ordinary paragraphs",
  "line 37 — verify nested lists",
  "line 38 — verify blockquotes",
  "line 39 — verify display mathematics",
  "line 40 — verify final-page height",
];

export function summarizeSlices(slices: PageSlice[]): string {
  const covered = slices.reduce((total, slice) => total + slice.height, 0);
  return `${slices.length} pages cover ${covered}px`;
}

console.log(observations.join("\n"));
```

## Table that should stay intact when it fits

| Check | Expected behavior | Result |
|:--|:--|:--:|
| Heading | Travels with the following block | ✓ |
| Paragraph | Is not cut when it fits a page | ✓ |
| Mermaid | SVG remains intact | ✓ |
| Code | Highlighted block remains intact | ✓ |
| Table 01 | Row boundary remains visible | ✓ |
| Table 02 | Row boundary remains visible | ✓ |
| Table 03 | Row boundary remains visible | ✓ |
| Table 04 | Row boundary remains visible | ✓ |
| Table 05 | Row boundary remains visible | ✓ |
| Table 06 | Row boundary remains visible | ✓ |
| Table 07 | Row boundary remains visible | ✓ |
| Table 08 | Row boundary remains visible | ✓ |
| Table 09 | Row boundary remains visible | ✓ |
| Table 10 | Row boundary remains visible | ✓ |
| Table 11 | Row boundary remains visible | ✓ |
| Table 12 | Row boundary remains visible | ✓ |
| Fallback | Oversized blocks may still be sliced | ✓ |

## Long list with safe internal boundaries

1. Measure the document after fonts and Mermaid finish rendering.
2. Record the position of each top-level block.
3. Treat a heading and its following block as a protected group.
4. Protect any ordinary block that fits within one target page.
5. For an oversized list, collect its direct item boundaries.
6. For an oversized table, collect row boundaries.
7. Aim for the established terminal page height.
8. Prefer the latest suitable semantic boundary before that target.
9. Use an earlier protected-block boundary when necessary.
10. Respect the configured maximum number of preview pages.
11. Fall back to a fixed cut when no safe boundary exists.
12. Keep all generated clips contiguous.
13. Ensure the clips cover the full rendered height exactly once.
14. Screenshot each variable-height clip independently.
15. Cache page images using the existing page keys.
16. Let image dimensions carry variable page heights naturally.
17. Preserve left/right page navigation in the terminal overlay.
18. Preserve PNG export naming such as `1-of-N` and `2-of-N`.
19. Leave browser preview continuous and unsplit.
20. Leave LaTeX-driven PDF pagination unchanged.
21. Display a warning only when the maximum render height truncates content.
22. Keep old cache entries isolated through a render-version bump.
23. Exercise both dark and light visual themes.
24. Verify that no text line disappears at a clip boundary.

## Mathematics and final-page check

The page slices should satisfy

\[
\bigcup_{i=1}^{n}[y_i,y_i+h_i)=[0,H),
\qquad
[y_i,y_i+h_i)\cap[y_j,y_j+h_j)=\varnothing\quad(i\ne j).
\]

Equivalently, their heights add to the rendered height:

\[
\sum_{i=1}^{n}h_i=H.
\]

[an: Final visual check: no heading should be stranded at the bottom of a page, and no fitting code block, diagram, table, or list item should be cut in two.]

The last page is allowed to be shorter than the target height. Its bottom padding and rounded preview-card border should still remain visible.

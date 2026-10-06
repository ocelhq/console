# @ocelhq/variables-ui

The variables table that the Ocel console and the CLI's `ocel env ui` both render. React,
styled with Tailwind v4 against `@ocelhq/theme`.

```sh
npm install @ocelhq/variables-ui @ocelhq/theme react react-dom @phosphor-icons/react
```

The components ship as built ESM with Tailwind class names in them, so the consumer's
Tailwind build has to scan the package, and needs the same plugins and dark variant the
components were written against:

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";
@import "@ocelhq/theme/tokens.css";
@import "@ocelhq/theme/base.css";

@custom-variant dark (&:is(.dark *));

/* relative to this CSS file */
@source "../node_modules/@ocelhq/variables-ui/dist";
```

`@ocelhq/variables-ui/model` exports the model without any React.

Published, but not part of Ocel's public API: versions follow the needs of Ocel's own surfaces.

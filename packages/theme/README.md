# @ocelhq/theme

The color tokens, base styles and fonts that Ocel's surfaces render in: the console, the
docs site and the CLI's `ocel env ui`. CSS and font files only; no JavaScript.

```sh
npm install @ocelhq/theme
```

```css
@import "tailwindcss";
@import "@ocelhq/theme/tokens.css";
@import "@ocelhq/theme/base.css";
```

Fonts ship as woff2 files under `@ocelhq/theme/fonts/`:

| Family | File |
|---|---|
| IBM Plex Sans | `fonts/ibm-plex-sans/ibm-plex-sans-latin-100-700.woff2` |
| Space Grotesk | `fonts/space-grotesk/space-grotesk-latin-300-700.woff2` |
| IBM Plex Mono | `fonts/ibm-plex-mono/ibm-plex-mono-latin-{400,500,600}.woff2` |
| Archivo | `fonts/archivo/archivo-latin-800.woff2` |

With `next/font/local`, give the path relative to the calling file, for example
`../node_modules/@ocelhq/theme/fonts/archivo/archivo-latin-800.woff2`.

`DESIGN.md` describes the design rules the tokens encode.

Published, but not part of Ocel's public API: versions follow the needs of Ocel's own surfaces.

// Writes the CSS files of the package next to the compiled JavaScript:
//   dist/tokens.css   plain CSS variables (import in any web app)
//   dist/tailwind.css Tailwind v4 @theme mapping (import after tokens.css)
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tailwindThemeCss, tokensCss } from '../dist/index.js';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
mkdirSync(dist, { recursive: true });
writeFileSync(`${dist}tokens.css`, tokensCss());
writeFileSync(`${dist}tailwind.css`, tailwindThemeCss());

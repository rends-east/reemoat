/**
 * `import "./index.css"` is an instruction to Vite, not a module this compiler
 * can resolve.
 *
 * TypeScript 7 refuses a side-effect import with no declaration behind it —
 * `TS2882`, "Cannot find module or type declarations for side-effect import" —
 * where 5.9 accepted it silently. The import is real and load-bearing: Vite
 * turns it into the stylesheet the app ships with. There is simply nothing to
 * type, so this declares exactly that and no more.
 *
 * ⚠ **Not `vite/client`**, which would also declare this and is the reflex fix.
 * That reference pulls in the whole `ImportMeta` surface plus declarations for
 * every asset kind Vite can import, none of which this package uses — and
 * `tsconfig.json`'s `types: []` is deliberate about what is allowed to reach
 * browser code. One line that says one thing beats a reference that says
 * forty.
 */
declare module "*.css";

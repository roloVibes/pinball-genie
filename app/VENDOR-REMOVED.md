<!-- not served as a route; a note for whoever looks for public/vendor/ -->
`public/vendor/tesseract/` (15 MB) was **removed 2026-07-30** with the public
launch. It was uploaded by `deploy-prod.sh` and, once the site stopped requiring
a session, publicly fetchable — a 2.8 MB WASM OCR engine plus a 2.0 MB trained
language model that **nothing in the shipped bundle referenced** (the only call
site, `src/identify/scan.ts`, has been unimported since the AR/auto-ID removal
on 2026-07-29).

To bring it back: `node scripts/prepare-vendor.mjs` — it repopulates the tree
from `node_modules/tesseract.js{,-core}`, which are still installed on purpose
(`scan.ts` remains on disk and is still type-checked by `tsc --noEmit`, so
removing the deps outright would break typecheck).

**2026-08-13 — demoted, not removed.** `tesseract.js` and `@techstark/opencv-js`
moved from `dependencies` to `devDependencies`. Their only import sites are the
two cold-storage files `src/identify/scan.ts` and `src/ar/tracker.worker.ts`,
both unimported by anything that ships; neither package appears anywhere in
`dist/`. They stay installed because `tsconfig.json` still typechecks those
files, and because `prepare-vendor.mjs` reads them out of `node_modules`.
`devDependencies` is the honest classification: build/typecheck-time only,
never runtime. Nothing about the deploy changes — `deploy-prod.sh` builds from
a full local install and ships `dist/`, so it never does a production-only
(`--omit=dev`) install that would starve the typecheck.

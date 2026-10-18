// Vite build config for Pinball Genie Web. Vanilla TS, no framework plugin.
// Worker format 'es' so ar/*.worker.ts (quaddetect, tracker — owned by other
// agents) can use `import` inside the worker; target es2022 matches tsconfig.
import { defineConfig, type Plugin } from 'vite'
import { copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// pinball_auth.py serves login.html (plus its extracted login.css/login.js —
// the site CSP forbids inline style/script) from alongside its --root
// directory (mirrors the vegas2-auth pattern: login page lives next to the
// served app, not next to the script). Copying them into dist/ at build time
// means the plain dev-loop invocation in README.md
// (`npm run build` then `pinball_auth.py --dev --root app/dist ...`) finds
// them with no separate manual copy step. Plain node:fs — no new dependency.
const LOGIN_FILES = ['login.html', 'login.css', 'login.js']
function copyLoginFiles(): Plugin {
  return {
    name: 'copy-login-files',
    apply: 'build',
    closeBundle() {
      for (const name of LOGIN_FILES) {
        const src = resolve(import.meta.dirname, '../server', name)
        if (existsSync(src)) {
          copyFileSync(src, resolve(import.meta.dirname, 'dist', name))
        }
      }
    },
  }
}

export default defineConfig({
  plugins: [copyLoginFiles()],
  // __BUILD_STAMP__ (declared in src/build-stamp.d.ts) — a literal string
  // substituted at build time so the shipped bundle carries its own build
  // timestamp. Diagnostic for the recurring "am I actually on the newest
  // build?" confusion (stale service worker / browser cache on a phone);
  // surfaced as small dim text in the how-to guide's footer (ui/howto.ts).
  define: {
    __BUILD_STAMP__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    // MUST stay false now that the site is public (2026-07-30). While the app
    // was behind the 6-user login gate, shipping maps was a harmless debugging
    // convenience. Public mode turned them into a public artifact: the emitted
    // index/map2d/achievements/glossary .map files carried `sourcesContent` —
    // ~84 KB of the original TypeScript across 10 modules, every internal
    // comment included. That published, among other things, the entire
    // invalid-traffic design in ui/adslot.ts (the pg_ads_kill_switch key name,
    // the production-hostname check, and the AdSense account-closure rationale)
    // — i.e. a documented map of how to defeat the ad guard — and sat badly
    // against terms.html's own reverse-engineering clause. If you need maps to
    // debug production, use 'hidden' (emits them, omits the sourceMappingURL
    // comment) AND delete them from the webroot in deploy-prod.sh; do not go
    // back to plain `true`.
    sourcemap: false,
  },
  worker: {
    format: 'es',
  },
})

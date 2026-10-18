/// <reference types="vite/client" />
// Vite's ambient types — chiefly `import.meta.env` (ui/offline.ts reads
// import.meta.env.PROD so the service worker is only registered by a real
// build, never by `vite dev`). Types only: this adds no plugin and no runtime
// code; Vite substitutes import.meta.env.PROD with a literal at build time.

// Ambient declaration for the build-time constant injected by vite.config.ts's
// `define` (see that file's header comment) — a diagnostic so "am I on the
// newest build?" has a one-glance answer in the how-to guide's footer
// (ui/howto.ts). esbuild/Vite's `define` does a literal text substitution at
// build time, so no import is needed at any call site — just this ambient
// `declare` so tsc knows the identifier exists.
declare const __BUILD_STAMP__: string

// ui/chunkError.ts — the fallback when a lazily-loaded chunk fails to arrive.
//
// WHY THIS EXISTS (2026-07-31, rolo: "the manage account button doesn't send me
// to the next page"). Vite splits the app into content-hashed chunks, and
// deploy-prod.sh REMOVES the whole `assets/` directory on every deploy before
// uploading the new build. A visitor who had the app open across a deploy is
// still running the previous `index-<hash>.js`, which references chunk
// filenames that no longer exist on the server. The moment they tap Map,
// Achievements or Glossary, the dynamic import 404s.
//
// Every one of those call sites was written as `void import('...').then(...)`
// with NO rejection handler, so the failure was completely silent: no error, no
// spinner, no message — the button simply did nothing, which reads as "the app
// is broken" and is impossible for a user to report usefully. That is exactly
// how the Manage-account bug reached rolo's phone.
//
// A stale chunk is NOT recoverable in-page: the running bundle can only ask for
// filenames it was built with, and those are gone for good. Reloading is the
// only fix, because it fetches the new index.html and with it the new chunk
// names. So this says so plainly and offers the reload, rather than retrying a
// fetch that can never succeed.
//
// Deliberately dependency-free and statically imported everywhere it is used —
// a module whose whole job is to handle "the network failed" must never itself
// be behind a network fetch.

/** Shows a dismissable banner explaining that the app needs a reload. */
function showReloadBanner(what: string): void {
  // Only ever one at a time, however many chunks fail.
  const existing = document.querySelector('.pg-chunk-error')
  if (existing) return

  const bar = document.createElement('div')
  bar.className = 'pg-chunk-error'
  bar.setAttribute('role', 'alert')

  const msg = document.createElement('span')
  msg.className = 'pg-chunk-error-text'
  msg.textContent = `Couldn't open ${what} — Pinball Genie was updated while you had it open.`

  const reload = document.createElement('button')
  reload.type = 'button'
  reload.className = 'pg-chunk-error-btn'
  reload.textContent = 'Reload'
  reload.addEventListener('click', () => {
    // location.reload() can be served from cache in some iOS states; replacing
    // with a cache-busted URL is the reliable way to get the NEW index.html,
    // which is the only thing that knows the new chunk names.
    const url = new URL(window.location.href)
    url.searchParams.set('_r', String(Date.now()))
    window.location.replace(url.toString())
  })

  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.className = 'pg-chunk-error-dismiss'
  dismiss.setAttribute('aria-label', 'Dismiss')
  dismiss.textContent = '✕'
  dismiss.addEventListener('click', () => bar.remove())

  bar.append(msg, reload, dismiss)
  document.body.appendChild(bar)
}

/**
 * Run a dynamic `import()` with a real failure path.
 *
 * `what` is the user-facing name of the thing being opened ("the map",
 * "achievements") — it goes straight into the banner copy, so write it
 * lowercase and as a noun phrase.
 *
 * Errors are swallowed after the banner is shown: a chunk that will never load
 * is not an exception the caller can do anything useful with, and rethrowing
 * would only produce an unhandled rejection.
 */
/**
 * WARM a chunk without opening anything — the idle-time prefetch (P6,
 * 2026-08-14) that lets the Machine Library appear instantly on the first tap
 * instead of after a round trip on arcade Wi-Fi.
 *
 * SILENT ON FAILURE, deliberately, and that is the whole difference from
 * loadChunk above. A prefetch is speculative: the visitor did not ask for
 * anything, so a banner telling them "Couldn't open the machine list" for a
 * request they never made would be a spontaneous error message about nothing.
 * Nothing is latched either, so the real user-initiated open still runs through
 * loadChunk and still gets the banner if the chunk is genuinely stale — the
 * failure surface is unchanged, it just isn't raised twice.
 *
 * Deliberately NOT `void load()` at the call site: an unhandled rejection is
 * exactly the silent-failure shape ui/chunkError.ts exists to end, and
 * app/tests/chunk-guard.test.mjs enforces that every dynamic import() in this
 * app is an argument to one of these two functions.
 */
export function prefetchChunk<T>(load: () => Promise<T>): void {
  void load().catch(() => {
    // Speculative work. If it failed, the real open will find out and say so.
  })
}

export function loadChunk<T>(
  load: () => Promise<T>,
  what: string,
  use: (mod: T) => void,
  onError?: () => void,
): void {
  void load().then(use).catch((err: unknown) => {
    // Keep the real reason in the console for anyone actually debugging; the
    // banner carries the part a visitor can act on.
    console.error(`[pinball-genie] failed to load chunk for ${what}:`, err)
    // Callers latch a "mounted" flag BEFORE awaiting, so a failure would
    // otherwise leave that flag stuck true and make a second tap do nothing at
    // all — turning a recoverable blip into a permanently dead tab. onError is
    // where the caller unlatches it. (A genuinely stale chunk still cannot
    // load, hence the banner; but a transient network failure retries.)
    if (onError) onError()
    showReloadBanner(what)
  })
}

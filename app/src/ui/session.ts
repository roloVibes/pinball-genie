// ui/session.ts — single shared /whoami check for the whole app. New file
// (2026-07-30 security review, D6 client half).
//
// BEFORE this file existed, ui/achievements.ts's boot() called BOTH
// GET /whoami AND GET /api/achievements unconditionally, in one Promise.all
// (see that file's git history / this repo's D6 finding). A signed-out
// visitor — the EXPECTED case post-launch, not a degraded one — got TWO 401s
// every time they opened the Achievements tab, and the Caddy access-log
// fail2ban jail this service sits behind bans an IP at 12 401s in 10
// minutes. Six tab-opens from behind one shared-NAT household (a family's
// wifi, a school, an office) was enough to ban the whole household from the
// entire site for an hour, over a study tool that needs no account at all.
//
// The fix is sequencing, not caching alone: NEVER fetch /api/achievements
// before knowing, from THIS module's answer, that a session actually
// exists (achievements.ts's boot() awaits getSession() first, then only
// calls fetchProgress() if it resolved non-null — see that file's own
// comment). getSession() itself still costs exactly one /whoami round trip
// per page load, same as before — that part is unavoidable and expected;
// what's fixed is the SECOND, ADDITIONAL request that used to piggyback on
// every one of those for free.
//
// Memoization is what lets a SECOND caller in the same page load (ui/
// account.ts, reached from achievements.ts's signed-in "Manage account"
// row) ask "am I signed in, and as whom" without re-issuing the network
// call (and, if signed out, re-incurring a second 401) — whichever caller
// asks first kicks off the one real fetch; everyone else gets the same
// pending/resolved promise.

/**
 * The `/whoami` response shape this client actually gets today, per
 * pinball_auth.py's own docstring ("WHY THE SESSION NAMES A STABLE UID, NOT
 * THE EMAIL"): `user` is an opaque, never-displayed uid, not a human
 * identity. `email` is NOT part of the current server contract — it is
 * typed here as optional, forward-compatible with a future response that
 * adds it, but on the server as of this writing /whoami will never send it.
 * See ui/account.ts's own header comment for how the Account overlay
 * degrades in that (current, real) case.
 */
export interface Session {
  uid: string
  email?: string
}

let cached: Promise<Session | null> | null = null

async function requestSession(): Promise<Session | null> {
  try {
    const r = await fetch('/whoami', { credentials: 'same-origin' })
    if (!r.ok) return null // 401 (or anything else) -> signed out
    const data: unknown = await r.json()
    if (!data || typeof data !== 'object') return null
    const rec = data as Record<string, unknown>
    const uid = rec.user
    if (typeof uid !== 'string' || uid.length === 0) return null
    const email = typeof rec.email === 'string' && rec.email.length > 0 ? rec.email : undefined
    return { uid, email }
  } catch {
    return null
  }
}

/** Returns the SAME in-flight/resolved promise to every caller this page
 *  load — see this file's header for why sharing one /whoami call matters. */
export function getSession(): Promise<Session | null> {
  if (!cached) cached = requestSession()
  return cached
}

/** Called right before a client-observed sign-out/account-deletion
 *  navigates away (ui/account.ts's callbacks) — not strictly required
 *  (both call sites do a hard reload, which would re-derive this from
 *  scratch anyway), but cheap belt-and-suspenders against a future caller
 *  that reads getSession() again on the SAME page after one of those
 *  actions without an intervening reload. */
export function forgetSession(): void {
  cached = Promise.resolve(null)
}

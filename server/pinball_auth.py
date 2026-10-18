#!/usr/bin/env python3
"""pinball-auth — server-side session auth in front of the Pinball Genie Web
static build (app/dist) and its /data/*.json goal datasets.

Python 3 stdlib only (plus the sibling `mail_sender` module, also stdlib-
only — see its own docstring). Architecture adapted from the PROVEN
vegas2-auth pattern (Vegas/v2/server/vegas2_auth.py): signed session cookie,
a real login page (no browser basic-auth popup), and a literal HTTP 401 on
rejected auth attempts so the existing Caddy access-log fail2ban jail (which
bans on 401s) covers this service too — Caddy reverse_proxy's to us on
127.0.0.1:<port> and just forwards/logs whatever status we return.

PHASE 5 (2026-07-30) — MAGIC-LINK ACCOUNTS, PASSWORDS RETIRED. This replaces
the 2026-07-29 multi-user username+password model (auth.json, PBKDF2 hashes,
6 fixed accounts) with real self-serve registration: a visitor types an
email, gets a one-time sign-in link, clicks it, is signed in. There is no
password field anywhere in this service, ever — not stored, not hashed, not
compared. `server/auth.json` and everything that used to read it (AuthStore,
validate_auth_doc, verify_password, USERNAME_RE/HASH_RE, the fake-salt
constant-time-failure dance) are gone; the file itself is simply never
opened by this script again (rolo's 2026-07-30 pre-cutover backup of it, and
of the achievements directory — verified EMPTY, since nobody had saved
progress yet — lives in `_Business/ARCHIVE/pre-phase5-20260730-013046/`).
The session cookie's identity field is now a STABLE, randomly generated USER
ID (`uid`), never the email — see "MAGIC-LINK SECURITY MODEL" below for why
that matters even for a single-user site.

ACCESS: two modes, selected by env PINBALL_PUBLIC (unchanged from the
2026-07-30 public launch — see LAUNCH-CHECKLIST.md Phase 3):

  PINBALL_PUBLIC=0 (default; the staging unit): nothing except /health,
    /login, POST /auth/request, GET /auth/verify, the login page's CSS/JS,
    and the legal pages is reachable without a session.

  PINBALL_PUBLIC=1 (the production unit): the SPA itself, /assets/*, and
    /data/*.json are open to the public with no session. /login, POST
    /auth/request, and GET /auth/verify are UNCHANGED in this mode — still
    live, so the achievements tracker can still be signed into on the
    public site. /whoami, /api/achievements, GET /auth/export, and POST
    /auth/delete stay session-gated in BOTH modes: per-user state (and the
    ability to export/delete it) is meaningless without a user, public app
    or not.

  The legal pages (/privacy, /terms, /about, /contact) and their shared
  stylesheet (/legal/legal.css) are reachable with no session in EITHER
  mode, same as /login and its assets.

  /machines and /machines/<slug> (the Phase 4 SEO guide pages, 2026-07-30)
  are ALSO reachable with no session in EITHER mode, for the identical
  reason: a search crawler and an ad-network reviewer both need to fetch
  62 real guide pages with no cookie and no JS. Unlike the legal pages,
  these ship INSIDE the app/dist build (ROOT_DIR) that PUBLIC_MODE already
  gates in mode 0 — see Handler._serve_machine_guide's docstring for why
  that still requires an explicit bypass rather than being "free".

Routes:
  GET  /health                         -> 200 "ok", always, no session needed
  GET  /whoami                         -> valid session: 200 {"user": uid}
                                           else: 200 {"user": null} (both
                                           modes — "user" is the frontend's
                                           existing field name
                                           (app/src/ui/achievements.ts) and is
                                           treated there as an opaque signed-
                                           in/out token, never displayed, so
                                           returning the stable uid instead of
                                           a human username is a compatible,
                                           silent change). NOT a bare 401 —
                                           see D6 (2026-07-30 security
                                           review): a signed-out GET /whoami
                                           fires on every single anonymous
                                           page load of a public SPA that
                                           checks auth status on boot, which
                                           made it, by volume, almost
                                           certainly the DOMINANT source of
                                           401s feeding the fail2ban jail
                                           described above — banning ordinary
                                           anonymous visitors for doing
                                           exactly what the page asks them to
                                           do. /api/achievements right below
                                           keeps a REAL 401 when signed out:
                                           a legitimate client only ever
                                           calls it after seeing a real uid
                                           from here, so a 401 there still
                                           means something adversarial.
  GET  /api/achievements               -> valid session: 200 the user's own
                                           progress blob ({} if none yet)
                                           else: 401 (both modes)
  PUT  /api/achievements               -> valid session + same-site: replace
                                           the user's blob (atomic, <=128KB
                                           JSON object) -> 204. Filename
                                           derives from the SESSION uid, so
                                           state is per-user by construction.
                                           else: 401 (both modes)
  GET  /auth/export                    -> valid session: 200 a JSON export of
                                           everything held about this user
                                           (email, timestamps, achievements)
                                           else: 401 (both modes)
  POST /auth/delete                    -> valid session + same-site: delete
                                           the user row, their achievements
                                           blob, and any live magic tokens;
                                           clear the session cookie -> 200
                                           else: 401 (both modes)
  POST /auth/revoke-sessions           -> valid session + same-site: bump
                                           this account's session_epoch,
                                           invalidating EVERY outstanding
                                           session cookie for this uid (this
                                           device, every other device, any
                                           captured copy) while leaving the
                                           account/achievements untouched;
                                           clear this device's cookie too
                                           (caller signs in again via a
                                           fresh magic link) -> 200
                                           else: 401 (both modes). Added
                                           2026-07-31 (surface-1 security
                                           review) — see _do_revoke_sessions
                                           and UserStore.bump_epoch for why:
                                           before this, the only response to
                                           a leaked session cookie was full
                                           account deletion (see
                                           _do_signout's docstring).
  GET  /login                          -> valid session: 302 -> /
                                           else: 200 login.html (both modes) —
                                           an email field + "Send me a link",
                                           or (with ?sent=1) the "check your
                                           inbox" confirmation state
  POST /auth/request                   -> ALWAYS the same neutral 302 ->
                                           /login?sent=1, whether the address
                                           is new, already registered, or not
                                           even syntactically an email — see
                                           "MAGIC-LINK SECURITY MODEL" below.
                                           No account row is created here —
                                           see "DEFERRED ACCOUNT CREATION"
                                           below.
                                           rate-limited (per-IP, per-/24
                                           subnet, per-requester+email, or
                                           the site-wide cap): 429, rendering
                                           the real login page in a "too many
                                           attempts" state with a Retry-After
                                           header (D5, 2026-07-30 security
                                           review — this used to be a bare
                                           Content-Length:0 body, which reads
                                           to a real visitor as the site
                                           being broken rather than "slow
                                           down")
                                           cross-origin: 401 (fail2ban signal)
                                           (all of the above, both modes)
  GET  /auth/verify?token=...          -> valid, unused, unexpired: consumes
                                           the token, creates the account row
                                           if this is its first successful
                                           verify (see "DEFERRED ACCOUNT
                                           CREATION" below), issues a
                                           session, 302 -> /
                                           expired/used: 410 Gone + a
                                           friendly HTML page (D6, 2026-07-30
                                           security review — this used to be
                                           401, which is exactly the status
                                           the fail2ban jail below counts,
                                           so a user clicking a stale or
                                           already-used link out of their own
                                           inbox — completely routine, not an
                                           attack — got fed straight into the
                                           ban counter; reproduced)
                                           malformed/unknown-selector/
                                           tampered-verifier ("invalid"): 401
                                           + a friendly HTML page (never a
                                           stack trace or a bare 401 body) —
                                           this status is kept as a REAL 401
                                           specifically because it's the one
                                           case in this set that still means
                                           something adversarial (see D6's
                                           reasoning above) (both modes)
  GET  /legal/legal.css                -> 200 the shared legal-page
                                           stylesheet, always, no session
                                           needed (404 if not deployed yet)
  GET  /privacy /terms /about /contact -> 200 the corresponding legal page,
                                           always, no session needed (same
                                           404-if-missing behavior)
  GET  /machines                       -> 200 the guide-page index, always,
                                           no session needed (404 if not
                                           built yet)
  GET  /machines/<slug>                -> 200 that machine's SEO guide page,
                                           always, no session needed (same
                                           404-if-missing behavior). Canonical
                                           form has NO trailing slash (matches
                                           /privacy et al); /machines/<slug>/
                                           and /machines/ 301 to the slash-
                                           free form — see
                                           Handler._serve_machine_guide.
  GET  /data/<name>.json               -> PUBLIC_MODE=1: 200 serve from
                                             --data, always
                                           PUBLIC_MODE=0: valid session: 200
                                             serve from --data; else 401
                                             (fetch/JSON path, no redirect —
                                             a `fetch()` in the app can't
                                             usefully follow one)
  *    anything else (GET/HEAD)        -> PUBLIC_MODE=1: 200 serve from
                                             --root (path "/" ->
                                             root/index.html), always
                                           PUBLIC_MODE=0: valid session: 200
                                             serve from --root; else 302 ->
                                             /login, UNLESS the request looks
                                             like a fetch/XHR (Accept:
                                             application/json or a
                                             non-navigate Sec-Fetch-Dest),
                                             in which case 401
  *    anything else (POST)            -> 404

Session cookie: pinball_session=<uid>.<exp>.<sig>
  uid = opaque random user id (secrets.token_urlsafe), NEVER the email — see
        "MAGIC-LINK SECURITY MODEL" below
  exp = unix seconds the session expires (issued-at + SESSION_MAX_AGE)
  sig = hex hmac_sha256(secret, "<uid>.<exp>.<epoch>") — epoch is NOT a
        cookie field (the wire shape above is still exactly 3 dot-separated
        parts); it's UserStore's current session_epoch for <uid>, looked up
        fresh at both sign time (_success_login) and verify time
        (_valid_session). D-EPOCH (2026-07-31, surface-1 security review):
        this is what lets POST /auth/revoke-sessions invalidate every
        outstanding cookie for an account — bumping the stored epoch means
        every previously-issued signature stops matching on its very next
        use, with nothing added to the cookie and nothing to distribute.
        See UserStore.bump_epoch's docstring for the gap this closes (before
        it, the only response to a leaked cookie was full account deletion).
HttpOnly, SameSite=Lax always; Secure unless --dev (plain-HTTP local runs).

MAGIC-LINK SECURITY MODEL (read this before changing anything below):

  * WHY THE SESSION NAMES A STABLE UID, NOT THE EMAIL: an email address is
    something the *user* can change (typo correction, switching providers,
    a future "change my email" feature) and something an *attacker* might
    partially control the display of (case folding, provider aliasing
    quirks). Keying achievements, the session cookie, and every internal
    lookup off a uid generated once at account-creation time and never
    reused means none of that can ever orphan or merge someone's saved
    progress. The email lives in exactly one place per user (UserStore's
    users/by_email maps) and is looked up FROM the uid, never the reverse,
    at the points that need it (sending mail, the data export).

  * TOKEN CONSTRUCTION — "selector.verifier", not one opaque blob: the
    emailed link's token is `secrets.token_urlsafe(9)` (the selector) + "."
    + `secrets.token_urlsafe(32)` (the verifier). The selector is a plain
    dict key for O(1) lookup and is NOT secret by itself — knowing a
    selector without the matching verifier proves nothing and grants
    nothing. The verifier is the actual bearer credential; only an
    HMAC-SHA256 of it (keyed with this service's session-signing SECRET,
    domain-separated with a fixed prefix — see _hash_verifier) is ever
    persisted, and it is checked with hmac.compare_digest, never `==`, so a
    stored-token-file compromise doesn't hand over live bearer secrets and a
    timing side-channel can't shave bits off the comparison. This is the
    same selector/verifier split used by "remember me" cookie schemes for
    exactly this reason (Laravel, Django-adjacent implementations, etc) —
    not novel here, just applied to a magic-link instead of a long-lived
    cookie. token_urlsafe's alphabet never contains ".", so splitting the
    combined token on the first "." is unambiguous.

  * SINGLE-USE, ATOMIC CONSUME: TokenStore.consume() looks up, verifies, and
    flips `used=True` all under ONE lock, and only writes the store back to
    disk once that flag is set. Two threads racing the same token (a
    double-clicked email link, or a mail-scanner prefetch racing the real
    click — see the next point) serialize on that lock: whichever runs
    first wins the sign-in, the second sees `used=True` and gets the exact
    same "already used" response any other replay would get.

  * ENUMERATION RESISTANCE — why POST /auth/request always looks the same:
    the spec for this service is "requesting a link for an unknown address
    and a known address must be INDISTINGUISHABLE". The mechanism that makes
    this true isn't hiding a difference — it's that there IS no difference
    to hide: POST /auth/request does not touch UserStore AT ALL (see
    "DEFERRED ACCOUNT CREATION" below) — for a brand-new address and a
    returning one alike, the only disk I/O on this path is TokenStore.issue()
    (always exactly one write, whether or not this email already had other
    live tokens — see issue()'s own comment on why revoking a matching
    address's prior tokens doesn't reintroduce an asymmetry), and
    SENDER.send() is always called. A syntactically invalid address (no "@",
    empty, absurdly long) skips all of the above — that asymmetry is fine,
    because "this input isn't an email address" is already public
    information anyone can see by looking at what they typed; no side
    channel is needed to learn it, so there is nothing to leak by responding
    faster.

    (Before the 2026-07-30 D7 fix below, this endpoint DID call
    `UserStore.find_or_create()` right here, and that method's own docstring
    used to carry this exact reasoning to justify writing through
    unconditionally even for a known address. That reasoning has moved with
    the call.)

  * DEFERRED ACCOUNT CREATION — why the permanent user row is created at
    VERIFY time, never at REQUEST time (D7 fix, 2026-07-30 security review):
    before this fix, POST /auth/request called `UserStore.find_or_create()`
    immediately, so simply TYPING a syntactically-plausible address into the
    sign-in form — a typo, a prank, someone else's address copied off a
    scraped list, a bot fuzzing the form — minted a real, permanent row in
    users.json for an address that never asked to be registered and might
    never even see the email (reproduced: 55 rows, zero of which had ever
    clicked a link). `find_or_create()` is now called ONLY from `_do_verify`,
    after `TokenStore.consume()` has already confirmed a valid, unexpired,
    single-use token — i.e. after the recipient has proven they control the
    mailbox by clicking the exact link that was sent to it. Until that
    happens, the only trace of a signup attempt is an ordinary, already-
    short-TTL, already-pruned TokenStore row (selector -> {verifier_hash,
    email, exp, used, created_at}) — the SAME row that carries the emailed
    credential itself, not a separate "pending account" structure, so the
    existing TTL + TokenStore._prune_locked() purge (see that method) is
    already exactly the cleanup a never-verified signup attempt needs: it
    ages out of the store on its own, same as any other unused token, with
    no user-facing trace ever having existed. `find_or_create()` is
    idempotent by email, so a second still-live token for the same
    not-yet-registered address (the visitor clicked "send it again" before
    verifying the first one) just attaches to the same freshly-created uid
    on whichever verify happens first — see that method's own comment.

  * RATE LIMITING IS TWO DIFFERENT MECHANISMS, LAYERED, BECAUSE THEY CATCH
    DIFFERENT THINGS: the existing RateLimiter class (kept from the
    password-auth era, retargeted) counts FAILURES within a window and
    blocks further attempts from that IP — perfect for the old "bad
    password" case, and still useful here for cross-origin-blocked requests
    and bad /auth/verify tokens (both are "someone is doing something a
    normal client wouldn't"). But it is USELESS against magic-link abuse in
    its own right, because every accepted POST /auth/request "succeeds" by
    design (see the enumeration point above) — nothing about the neutral
    response is ever a "failure" for RateLimiter to count. That's what
    SlidingWindowLimiter is for: it caps the COUNT of accepted requests
    (regardless of outcome) per IP, per containing /24 (IPv4) or /48 (IPv6)
    subnet, per (requester IP, normalized email) pair, and globally. All
    four run on every accepted request; hitting any one of them renders the
    login page's "too many attempts" state (see _send_rate_limited) before
    any store work happens. See REQUEST_LIMIT_* below for the actual
    numbers and the reasoning behind each.

    D5 FIXES (2026-07-30 security review), on top of the design above:

    - Every rate-limit rejection used to be `_plain_status(429)` — a real
      HTTP 429 but with Content-Length: 0 and no body, which to an actual
      human visitor renders as a blank white page indistinguishable from
      the site being down. All of them now render the real login.html in a
      third templated state ("too many attempts, try again in N minutes",
      with a Retry-After header for well-behaved clients/proxies too) via
      _send_rate_limited() — see login.html's .limited-panel.

    - The global cap used to be ONE bucket (_GLOBAL_KEY = "*"): reproduced,
      as few as ~8 source IPs (each individually staying under its own
      per-IP cap) could collectively exhaust the 60/hour site-wide ceiling
      and lock sign-in for every OTHER visitor on the internet for up to an
      hour. REQUEST_LIMIT_SUBNET now sits between the per-IP and the
      site-wide checks, bucketed per containing /24 (IPv4) or /48 (IPv6) —
      see subnet_key() — so a burst concentrated in one subnet trips ITS
      OWN, much lower ceiling (REQUEST_LIMIT_PER_SUBNET_MAX) long before it
      can meaningfully dent the shared global bucket other subnets rely on.
      The site can now only ever be locked out subnet-by-subnet ("degrade"),
      never in one shot by a handful of IPs sharing a /24 ("hard-lock").

    - The per-email cap used to be keyed on the normalized email ALONE, with
      no reference to who was asking. That meant anyone who merely knew a
      victim's address — no access to their inbox required — could send
      REQUEST_LIMIT_PER_EMAIL_MAX requests from anywhere and lock the
      REAL owner out of requesting their own sign-in link for the rest of
      the window; the attacker never had to be, and never was, the one who
      paid any cost. It is now keyed on (requester IP, normalized email):
      the cap still exists and still trips at the same count, but it counts
      against the REQUESTER, so a fresh IP (in particular, the real owner's
      own) always gets its own fresh budget against that address regardless
      of how many times anyone else has asked for it. This does trade away
      some protection against a genuinely distributed (many-source-IP)
      mail-bomb of one target address — that residual risk is accepted,
      same posture already taken for REQUEST_LIMIT_GLOBAL's own "not a
      guarantee against a sustained multi-hour, multi-IP...attack" language
      below, and is partly covered in aggregate by REQUEST_LIMIT_SUBNET/
      REQUEST_LIMIT_GLOBAL regardless of which email each request names.

  * A GET THAT CONSUMES A TOKEN, AND WHY THAT'S THE RIGHT CALL HERE: a GET
    request mutating state (marking a token used, creating a session) is a
    real, normally-correct-to-avoid smell — GETs are supposed to be safe and
    idempotent, and this one is neither. It is unavoidable given the actual
    constraint: an email client only ever follows a link via GET; there is
    no way to make "click the link in your email" arrive as a POST. Given
    that constraint, the mitigations actually available are the ones this
    file already uses — single-use + atomic consume + a short (15-minute)
    TTL — and they are sufficient: the WORST outcome of the GET's mutation
    being triggered by something other than the intended human (a corporate
    mail-scanner/"safe links" proxy that prefetches URLs found in incoming
    mail to check them for malware, e.g. Microsoft Defender for Office 365,
    Proofpoint, Mimecast) is that the token gets burned before the real user
    clicks it, and the user sees the "already used" friendly page and
    requests a fresh link — a known, bounded UX cost that essentially every
    production magic-link product accepts (Slack, Notion, Medium, ...), not
    a security hole: the scanner's own infrastructure never forwards the
    resulting Set-Cookie anywhere the user's browser can use it, so nobody
    actually gains an authenticated session out of a prefetch — the
    practical effect is indistinguishable from the user's own link having
    simply expired. Given that, building a second confirmation step (turn
    the initial GET into a "click here to actually sign in" page, POSTed by
    a real click) would trade a real, working, spec-literal single-GET flow
    for meaningfully worse UX (an extra click, on every sign-in, for every
    user, forever) to guard against a residual risk that is already
    self-limiting (15-minute TTL) and already a known, accepted tradeoff
    industry-wide. Decision: accept it, documented here rather than silently
    designed around.

Config (CLI flags win; falls back to env vars, meant for the systemd unit —
see pinball-auth.service's PINBALL_ROOT= convention, mirroring vegas2-auth's
_ROOT-prefixed-defaults idiom):
  --port PORT     bind port on 127.0.0.1        default: 9310
  --root DIR      static app build to serve     default: $PINBALL_ROOT
  --data DIR      goal-dataset JSON directory    default: $PINBALL_ROOT/data
  --dev           ephemeral secret, drop the cookie's Secure flag (plain
                  HTTP localhost testing), and allow PINBALL_PUBLIC_ORIGIN
                  to be omitted (falls back to the request's own Host
                  header — see D2 below and _build_magic_link)
  env PINBALL_PUBLIC_ORIGIN      canonical origin used to build every
                                                  emailed magic-link URL, e.g.
                                                  "https://pinball-genie.com"
                                                  — REQUIRED outside --dev;
                                                  main() refuses to start
                                                  without a valid absolute
                                                  https origin here (no path/
                                                  query/fragment/userinfo).
                                                  D2 fix (2026-07-30 security
                                                  review): the link used to
                                                  be built from the
                                                  request's own Host header,
                                                  so `Host: evil.example`
                                                  put an attacker-chosen
                                                  domain straight into a
                                                  real, working, emailed
                                                  sign-in credential — a
                                                  one-click takeover of any
                                                  address the attacker could
                                                  get to click the resulting
                                                  (legitimate-looking, since
                                                  it's the REAL token) link.
  env PINBALL_AUTH_SECRET_FILE   session secret  default: /etc/pinball-auth/secret
                                                  (ignored in --dev: ephemeral)
  env PINBALL_AUTH_LOGIN         login.html path default: <root>/login.html
  env PINBALL_RESEND_KEY_FILE    Resend API key  default: /etc/pinball-auth/resend_key
                                                  (missing/empty -> DevLogSender,
                                                  see mail_sender.py)
  env PINBALL_MAGIC_TTL_SECONDS  token TTL       default: 900 (15 min, the
                                                  spec'd value). TESTING KNOB
                                                  ONLY — the production unit
                                                  never sets this, so it always
                                                  gets the real 15 minutes; a
                                                  loud stderr warning fires at
                                                  startup if it's ever
                                                  overridden, precisely so an
                                                  accidental override in a real
                                                  deployment is impossible to
                                                  miss in `journalctl -u
                                                  pinball-auth`.
  env PINBALL_STATE_DIR          writable state  default: /var/lib/pinball-auth
                                                  (achievements/, users.json,
                                                  magic_tokens.json — see
                                                  UserStore/TokenStore below)
"""

# Lets `X | None` / `dict[str, list[float]]`-style annotations below stay
# inert strings instead of being evaluated at def-time (PEP 604 syntax is
# 3.10+; this repo's target is "stdlib-only Python 3" broadly, and the
# system python3 this was developed/tested against is 3.9.6).
from __future__ import annotations

import argparse
import hashlib
import hmac
import html as html_lib
import http.server
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import socket
import sys
import tempfile
import threading
import time
import urllib.parse

import mail_sender  # sibling module — see its own docstring; same directory
# on sys.path[0] both locally (server/) and on the droplet (/opt/pinball-auth/,
# see deploy-prod.sh step (d), which uploads both files together).

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

BIND_HOST = "127.0.0.1"
DEFAULT_PORT = 9310
SESSION_MAX_AGE = 30 * 24 * 3600  # 30 days
MAX_BODY_BYTES = 4096
MAGIC_REQUEST_MAX_BODY = 2048  # one `email=...` form field; generous

# PG-02 (HIGH, 2026-07-31 webapp pentest) — TOTAL wall-clock budget for reading
# a declared request body, in seconds. See Handler._read_body_bounded for the
# denial-of-service this bounds. Deliberately far below Handler.timeout (the
# per-socket-operation timeout, 15s): the whole point is that a client which
# declares a body and then trickles must lose its worker slot quickly, not
# after the full socket timeout.
#
# 5s is generous for what actually crosses this boundary. The backend binds
# loopback and Caddy is its only caller, so the bytes here have already
# travelled the internet once and are being streamed over lo — 128KB (the
# ACHIEVEMENTS_MAX_BODY ceiling) moves in single-digit milliseconds. The budget
# exists for the pathological client, not the slow one.
BODY_READ_TIMEOUT = 5.0
COOKIE_NAME = "pinball_session"
# PG-06 (2026-07-31 webapp pentest): the same-browser binding cookie for magic
# links. Set by POST /auth/request, checked by GET /auth/verify — see
# _verify_confirm_page for the login-CSRF this closes. Deliberately NOT
# Path-scoped to /auth: the sign-in POST is made from /login, and a
# Path=/auth cookie would not be sent back on the /auth/verify GET in every
# browser's interpretation of the path-match rule. Lifetime matches the token's
# own TTL — it is useless the moment the link it belongs to expires.
LINK_NONCE_COOKIE = "pinball_link"
UID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")  # secrets.token_urlsafe's own
# alphabet, so every uid this service ever mints matches by construction —
# this is a defensive re-check on cookie DECODE, not a generator constraint.
HEX_RE = re.compile(r"^[0-9a-fA-F]+$")

# PG-01 (2026-07-31 webapp pentest): every C0 control character plus DEL.
# Handler.parse_request rejects any request whose PERCENT-DECODED target
# contains one of these — see that method for the response-splitting incident
# this closes. CR and LF are the ones that were actually exploitable; the rest
# of the C0 range is included because none of them has any legitimate meaning
# in this service's request targets either (the only decoded inputs it ever
# sees are path segments, catalog slugs, a base64url magic-link token, and
# `sent=1`), and enumerating "just the dangerous two" is how the next parser
# difference becomes the next bug. NUL is in here too, which makes
# resolve_safe_path's own "\x00" check a second layer rather than the only one.
_CONTROL_CHARS = frozenset(chr(c) for c in range(0x20)) | {"\x7f"}

# Minimal email well-formedness check — NOT a full RFC 5322 validator (there
# isn't a useful one; the only real validator is "did an email arrive"). Just
# enough to decide whether it's worth spending a TokenStore write + a Resend
# call on, versus the same neutral response with none of that work (see the
# module docstring's ENUMERATION note for why that particular asymmetry is
# safe to keep).
#
# D13 fix (2026-07-30 security review): the local AND domain parts used to
# only exclude whitespace and "@" (`[^\s@]`), so `,`/`;`/`<`/`>`/`"` all
# sailed through — e.g. `a,b@example.com` was accepted as one well-formed
# address. That string then goes straight into
# `mail_sender.ResendSender.send`'s `"to": [to_email]` — if Resend's own
# address parser ever splits an incoming recipient string on a comma (a
# common convention for a comma-separated recipient LIST), ONE accepted
# /auth/request call silently becomes N distinct recipients, each minted a
# real magic link, entirely outside this service's own per-email
# SlidingWindowLimiter (which only ever saw the ONE string the requester
# typed) — this service unintentionally becomes a mail-relay-as-open-relay
# for anyone who can name a batch of targets separated by commas. `;`/`<`/
# `>`/`"` carry the same class of "no legitimate use in an address this
# service needs to accept, but plausible significance to SOME downstream
# parser" risk, so all five are excluded from both the local part and the
# domain (not just the local part) as defense in depth.
_EMAIL_SAFE_CHAR = r'[^\s@,;<>"]'
EMAIL_RE = re.compile(rf"^{_EMAIL_SAFE_CHAR}{{1,64}}@{_EMAIL_SAFE_CHAR}{{1,255}}\.{_EMAIL_SAFE_CHAR}{{1,63}}$")
MAX_EMAIL_LEN = 254  # RFC 5321 4.5.3.1.3

RATE_LIMIT_MAX_FAILS = 5
RATE_LIMIT_WINDOW = 5 * 60  # seconds
RATE_LIMIT_MAX_TRACKED_IPS = 10_000  # see RateLimiter.record_failure's sweep

# Magic-link token lifetime. 900s (15 min) is the spec'd production value;
# see the module docstring's Config section for the (test-only) env override
# and why it's safe.
_ttl_env = os.environ.get("PINBALL_MAGIC_TTL_SECONDS")
if _ttl_env:
    try:
        MAGIC_TOKEN_TTL = int(_ttl_env)
    except ValueError:
        MAGIC_TOKEN_TTL = 15 * 60
    if MAGIC_TOKEN_TTL != 15 * 60:
        print(
            f"WARNING: PINBALL_MAGIC_TTL_SECONDS overrides the token TTL to "
            f"{MAGIC_TOKEN_TTL}s (spec default is 900s / 15 min). This env var "
            "exists ONLY so tests don't have to wait 15 real minutes to prove "
            "expiry — it must never be set on the production systemd unit.",
            file=sys.stderr,
        )
else:
    MAGIC_TOKEN_TTL = 15 * 60
TOKEN_SWEEP_INTERVAL = 60 * 60  # PG-17: hourly time-driven retention sweep
# PG-18 (2026-07-31, rolo) — SIGN-IN CODE, for the installed-PWA case.
#
# On iOS a Home-Screen web app gets its OWN cookie jar, and Mail always opens
# links in Safari. So a magic link CANNOT deliver a session cookie into the
# installed app — the user signs in, and the app they actually use is still
# signed out. (rolo hit exactly this: his workaround was to re-add the app to
# the Home Screen after signing in, which re-seeds storage from Safari.) No
# cookie attribute fixes it; the two contexts simply do not share storage.
#
# The fix is a short code emailed ALONGSIDE the link, typed into whichever app
# the user is standing in. It also happens to fix the request-on-phone /
# sign-in-on-laptop case for free.
#
# ALPHABET excludes 0/O/1/I/L/S/5 — the pairs people mistype off a screen. 8
# chars from 25 symbols is ~1.5e11 combinations, and RATE_LIMITER already stops
# an IP after 5 failures in 5 minutes, so guessing is not a threat model. The
# code is stored HASHED (same treatment as the link's verifier) and is
# single-use through the same row, so a code and its link cannot both be spent.
CODE_ALPHABET = "ABCDEFGHJKMNPQRTUVWXYZ2346789"
CODE_LENGTH = 8
MAGIC_TOKEN_PRUNE_GRACE = 5 * 60  # keep a just-expired/just-used row around a
# little past its TTL so a slightly-late click still resolves to a real
# "expired"/"used" reason instead of "not found" — a UX kindness, not a
# security boundary (see TokenStore._prune_locked).

# Success-rate caps on POST /auth/request — see the module docstring's
# RATE LIMITING paragraph for why these exist ALONGSIDE, not instead of,
# RateLimiter below.
REQUEST_LIMIT_PER_IP_MAX = 8
REQUEST_LIMIT_PER_IP_WINDOW = 15 * 60  # a legit visitor mistyping their
# address and retrying a couple of times, or a small shared-NAT household /
# office requesting for a few different people in a burst, both fit easily.
REQUEST_LIMIT_PER_EMAIL_MAX = 3
REQUEST_LIMIT_PER_EMAIL_WINDOW = 15 * 60  # one legitimate "it didn't arrive,
# send it again" retry is normal; 3 covers that plus slack, while capping how
# many times this service can be made to mail-bomb one inbox it doesn't own.
# D5 fix (2026-07-30 review): keyed on (requester IP, email) — see the
# module docstring's RATE LIMITING section for why a bare-email key let
# anyone lock out an address's real owner without ever touching their
# inbox.
REQUEST_LIMIT_PER_SUBNET_MAX = 12  # PG-11: 48/hr, strictly under GLOBAL's 60/hr
REQUEST_LIMIT_PER_SUBNET_WINDOW = 15 * 60  # D5 fix (2026-07-30 review): sits
# between the per-IP and the site-wide caps, bucketed per containing /24
# (IPv4) or /48 (IPv6) subnet — see subnet_key(). 24 is 3x a single IP's own
# cap (REQUEST_LIMIT_PER_IP_MAX) — generous enough that a legitimately large
# shared-NAT office/university block sending a real burst still gets
# through comfortably, while sitting well under REQUEST_LIMIT_GLOBAL_MAX so
# one abusive /24 can never eat more than a fraction of the site-wide
# budget other subnets depend on (the exact failure reproduced pre-fix: ~8
# IPs sharing a /24, each individually under the per-IP cap, collectively
# exhausting the single global bucket and locking out every other visitor
# on the internet).
REQUEST_LIMIT_GLOBAL_MAX = 60
REQUEST_LIMIT_GLOBAL_WINDOW = 60 * 60  # Resend's free tier is 3,000/mo
# (~100/day average). 60/hour is nowhere near enough to burn the WHOLE
# month's quota in a single hour — the literal requirement — while still
# leaving real headroom for a legitimate traffic spike (a Reddit/HN mention).
# It is explicitly NOT a guarantee against a sustained multi-hour, multi-IP,
# multi-email attack that outlasts the per-IP/per-subnet/per-email caps
# above; that residual risk is accepted, same posture the fail2ban-backed
# RateLimiter already takes (defense in depth, not a hard ceiling) — a
# determined attacker who can sustain traffic for many consecutive hours
# across many source subnets is a materially different, harder, and more
# visible threat than a short burst or a single abusive /24 (which
# REQUEST_LIMIT_SUBNET now catches on its own — see that constant's
# comment), and is the point at which manual monitoring / the Resend
# dashboard's own alerting takes over from this in-process limiter.
# NEW-3 (2026-07-30, second review pass): the per-subnet RESERVE that the
# global bucket cannot touch. Consulted ONLY once REQUEST_LIMIT_GLOBAL is
# already exhausted — see _do_auth_request's comment for the full reasoning.
# Without it, the global cap is a site-wide sign-in kill switch: 9 IPs across
# 3 /24s were measured locking out every other visitor on the internet for an
# hour, because PER_SUBNET_MAX(24) x 3 >= GLOBAL_MAX(60) while 3 IPs/subnet
# stays under PER_IP_MAX(8). 2/hour is deliberately small: enough that a real
# person who wants to sign in during an attack can (request, and one retry if
# the first mail is slow), far too little to be worth an attacker spinning up
# subnets to harvest, and negligible against the send quota.
REQUEST_LIMIT_RESERVE_MAX = 2
REQUEST_LIMIT_RESERVE_WINDOW = 60 * 60

# PG-11 (2026-07-31 adversarial review) — THE MISSING DAILY BUDGET.
#
# Every limiter above is hourly or shorter, but the resource they exist to
# protect is MONTHLY: Resend's free tier is 3,000 sends/month. Sustaining the
# global hourly ceiling is 60 x 24 x 30 = 43,200 sends/month — 14x the quota —
# so the control set could not bound the thing it was sized against.
#
# Worse, the tiers were inverted. REQUEST_LIMIT_PER_SUBNET_MAX was 24/900s =
# 96/hr against a global ceiling of 60/hr, so ONE /24 could consume 100% of the
# site-wide budget by construction. The comment below the subnet limiter
# accepted residual risk on the premise that "a single abusive /24 ...
# REQUEST_LIMIT_SUBNET now catches on its own" — arithmetically it did not.
# Per-subnet is now 12/900s = 48/hr, strictly under the global 60/hr, so a
# single subnet can no longer take the whole budget.
#
# WHAT HAPPENS WHEN THE QUOTA DIES MATTERS AS MUCH AS THE NUMBER. _do_auth_request
# deliberately swallows send exceptions to preserve enumeration-neutrality, so a
# quota-exhausted Resend account produces a cheerful "check your inbox" for every
# user, forever, with nothing surfaced in the product. See the
# consecutive-failure alarm in _do_auth_request for the counter added alongside
# this budget.
#
# IN-MEMORY, DELIBERATELY. Like every other limiter here, this resets when the
# service restarts, so a deploy re-opens the day's budget. That is a real
# weakness and it is accepted rather than hidden: deploys are operator-initiated
# and infrequent, an attacker cannot force one, and the alternative (a persisted
# counter under STATE_DIR) is materially more machinery for a service whose
# whole design note is "one process, JSON files, no database".
#
# SIZED FOR THE FREE TIER BY DEFAULT (90/day ~= 2,700/month, just inside 3,000).
# Override with PINBALL_DAILY_SEND_MAX once the Resend plan is upgraded — a
# paid tier is 50,000/month and this should rise with it, because on a NAT-heavy
# venue network this cap is also what throttles legitimate visitors.
REQUEST_LIMIT_DAILY_WINDOW = 24 * 60 * 60


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    """Read a positive int from the environment, falling back loudly."""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError:
        print(f"WARNING: {name}={raw!r} is not an integer — using {default}", file=sys.stderr)
        return default
    if value < minimum:
        print(f"WARNING: {name}={value} is below the minimum {minimum} — using {minimum}", file=sys.stderr)
        return minimum
    return value


REQUEST_LIMIT_DAILY_MAX = _env_int("PINBALL_DAILY_SEND_MAX", 90)

_GLOBAL_KEY = "*"  # SlidingWindowLimiter's single site-wide bucket key

# PG-11: consecutive magic-link send failures. A one-element list rather than a
# module-level int so the handler can mutate it without a `global` declaration
# in a method. Reset to 0 on the first success.
_SEND_FAILURES = [0]
_SEND_FAILURE_LOCK = threading.Lock()

# ACCESS ENFORCEMENT (rolo, 2026-07-30): the SPA + /data/*.json go public on
# the production unit (PINBALL_PUBLIC=1) — the achievements tracker stays
# gated regardless (/whoami + /api/achievements check the session no matter
# what this flag is), and /login + POST /auth/request + GET /auth/verify
# stay LIVE in public mode too (see the module docstring's ACCESS section).
# Defaults OFF so the staging unit is unaffected; the production systemd
# unit sets PINBALL_PUBLIC=1 via a drop-in (see deploy-prod.sh) rather than
# changing this default, so a stray staging redeploy can never accidentally
# inherit "public".
PUBLIC_MODE = os.environ.get("PINBALL_PUBLIC", "0") == "1"

EXTRA_MIME_TYPES = {
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".html": "text/html; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".map": "application/json",
    ".webp": "image/webp",
}

# Populated by main() before the server starts serving.
SECRET: str = ""
DEV_MODE = False
PUBLIC_ORIGIN: str = ""  # canonical "https://host[:port]" used to build
# every emailed magic-link URL (see _build_magic_link and D2 in the module
# docstring's Config section). Validated + required outside --dev at
# startup; only ever empty in --dev, where _build_magic_link falls back to
# the request's own Host header for local convenience.
ROOT_DIR = ""
DATA_DIR = ""
# Per-user server-side state (achievements progress, the user registry, and
# live magic-link tokens). Under systemd this is StateDirectory=pinball-auth
# (/var/lib/pinball-auth) — the ONE writable path the hardened unit allows
# (ProtectSystem=strict). 2026-07-29 (achievements); 2026-07-30 (users +
# tokens, Phase 5).
STATE_DIR = ""
ACHIEVEMENTS_MAX_BODY = 128 * 1024  # a full 62-machine progress blob is ~KBs

# PG-09 (HIGH, 2026-07-31 adversarial review) — MAXIMUM NESTING DEPTH for a
# stored achievements document.
#
# The real shape is {machine_slug: {goal_id: true}} — depth 2, maybe 3 if the
# client ever nests per-step state. 32 is absurdly generous for that and still
# far below every cliff below.
#
# WHAT THIS CLOSES. _put_achievements only ever checked `isinstance(doc, dict)`,
# so any JSON shape under 128KB could be stored. Three separate failures come
# out of that, and one fix removes all three:
#
#  1. EXPORT AMPLIFICATION. GET /auth/export pretty-prints with indent=2, and
#     indentation cost is quadratic in depth. Measured: 24 chains of depth 900
#     packed into a 126.7KB PUT (legal today) export as **37.4 MB** — 302x —
#     built entirely in memory, against a unit capped at MemoryMax=256M. A
#     handful of concurrent exports is an OOM.
#  2. UNCAUGHT RecursionError ON EXPORT. json.loads survives ~20k deep (D14's
#     cap) and json.dumps COMPACT survives 3000+, so a 1000-deep document is
#     accepted and written successfully — but json.dumps(indent=2) raises
#     RecursionError from depth ~1000. So the export path dies with an uncaught
#     exception and no response, permanently, on every retry, because the blob
#     is already on disk. Same dead-thread class as PG-07.
#  3. It bounds the write path's own json.dumps too, rather than relying on the
#     compact serialiser happening to have more headroom than the pretty one.
#
# Checked at the WRITE side on purpose: the read side cannot fix a document
# that is already stored.
ACHIEVEMENTS_MAX_DEPTH = 32
USERS: "UserStore" = None  # type: ignore[assignment]
TOKENS: "TokenStore" = None  # type: ignore[assignment]
SENDER = None  # mail_sender.ResendSender | mail_sender.DevLogSender, set in main()
LOGIN_CACHE: "FileCache" = None  # type: ignore[assignment]
# login.html's extracted stylesheet/script (the site's CSP forbids inline
# style/script, so the login page links these; they must be reachable
# pre-auth just like /login itself).
LOGIN_ASSETS: "dict[str, tuple[FileCache, str]]" = {}
# Legal/marketing pages (privacy, terms, about, contact) + their shared
# stylesheet, served from <root>/legal/. Same "always reachable, no session,
# regardless of PUBLIC_MODE" treatment as LOGIN_ASSETS, for the same reason
# (2026-07-30): crawlers/ad-network reviewers need these with no login wall
# and no JS. Unlike LOGIN_ASSETS, missing files are NOT fatal at startup —
# these pages can be deployed incrementally (see main()'s comment).
LEGAL_ASSETS: "dict[str, tuple[FileCache, str]]" = {}
RATE_LIMITER: "RateLimiter" = None  # type: ignore[assignment]
REQUEST_LIMIT_IP: "SlidingWindowLimiter" = None  # type: ignore[assignment]
REQUEST_LIMIT_SUBNET: "SlidingWindowLimiter" = None  # type: ignore[assignment]
REQUEST_LIMIT_EMAIL: "SlidingWindowLimiter" = None  # type: ignore[assignment]
REQUEST_LIMIT_GLOBAL: "SlidingWindowLimiter" = None  # type: ignore[assignment]
REQUEST_LIMIT_RESERVE: "SlidingWindowLimiter" = None  # type: ignore[assignment]
REQUEST_LIMIT_DAILY: "SlidingWindowLimiter" = None  # type: ignore[assignment]  # PG-11

# --------------------------------------------------------------------------
# login.html state marker — one template slot, two states (default form /
# "check your inbox" confirmation). See login.html's header comment for the
# full incident history of why the marker must live ONLY in login.html and
# never in login.css (login.css is served raw through LOGIN_ASSETS and is
# never templated — a marker placed there is served verbatim, forever, and
# that exact mistake shipped a permanently-visible error banner on
# 2026-07-29; the marker changed shape for Phase 5 but the hazard it guards
# against did not).
# --------------------------------------------------------------------------
STATE_MARKER = "%%STATE%%"
STATE_DEFAULT = ""  # marker -> empty: the sign-in form is shown (CSS default)
STATE_SENT = "is-sent"  # marker -> this class: "check your inbox" is shown
STATE_LIMITED = "is-limited"  # marker -> this class: "too many attempts" is
# shown (D5, 2026-07-30 security review — see _send_rate_limited). Same
# marker slot, same substitution mechanism, same incident-history rule as
# STATE_SENT above: this value is only ever written into login.html, never
# login.css/login.js.

# A SECOND template slot (D5), substituted alongside STATE_MARKER above,
# carrying a human-readable minute count for the "too many attempts, try
# again in N minutes" copy. Same raw-vs-templated hazard as STATE_MARKER —
# see login.css's own header comment for the incident — so this marker,
# too, is spelled out ONLY in login.html and never in login.css/login.js.
RETRY_MARKER = "%%RETRY_MIN%%"


# --------------------------------------------------------------------------
# Branded 404 page
# --------------------------------------------------------------------------
# A mistyped URL used to answer with the bytes `not found` and nothing else —
# correct HTTP, but to a visitor (and to a crawler sampling a site's error
# handling) it reads as a broken server rather than a wrong address. This is
# the same reasoning as D5's rate-limit page above: a status code is for
# machines, a page is for people.
#
# NO INLINE STYLE, NO INLINE SCRIPT, BY CONSTRUCTION. The site's CSP (set in
# Caddy — see deploy-prod.sh's header block: `style-src 'self'; script-src
# 'self'`) forbids both, so this page carries no <style> block, no style=""
# attribute and no <script> at all; every rule it needs already exists in
# /machines/guide.css, which is why it links that stylesheet rather than
# growing one of its own. guide.css ships inside app/dist/machines/ and is
# served by _serve_machine_guide, i.e. it is reachable with NO session in
# BOTH PUBLIC_MODE settings — the same tier this 404 itself is served at. If
# a checkout has no guide pages built, the page degrades to unstyled dark-
# default HTML and still says the right words with working links.
#
# `noindex` because a 404 body is not content: the status code alone already
# tells a well-behaved crawler that, but the two are cheap to state together
# and disagree in no case.
#
# Bytes, not a template: nothing here is request-derived, so there is no
# substitution step and no way for a URL to reach the response body (the
# reflected-path 404 page is a classic self-XSS shape — this one cannot be,
# because it never sees the path).
_NOT_FOUND_HTML = b"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Page not found &mdash; Pinball Genie</title>
    <meta name="robots" content="noindex" />
    <meta name="theme-color" content="#0a0b10" />
    <meta name="color-scheme" content="dark" />
    <link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png" />
    <link rel="stylesheet" href="/machines/guide.css" />
  </head>
  <body>
    <header class="site-header">
      <div class="header-inner">
        <a class="brand" href="/">
          <span class="brand-ball" aria-hidden="true"></span>
          Pinball Genie
        </a>
        <a class="back-link" href="/">&larr; Back to the app</a>
      </div>
    </header>

    <main>
      <div class="container">
        <h1>Page not found</h1>
        <p class="dek">
          That address isn't on this site. It may have moved, or the link may
          have been mistyped.
        </p>
        <div class="callout">
          <p><a href="/">Home</a> &middot; <a href="/machines">All machines</a></p>
        </div>
      </div>
    </main>
  </body>
</html>
"""


# --------------------------------------------------------------------------
# Email normalization
# --------------------------------------------------------------------------


def normalize_email(raw: str) -> "str | None":
    """Trims + lowercases; returns None for anything that doesn't even look
    like an email address.

    NORMALIZATION POLICY (decided once, documented once, per the build
    spec's explicit requirement to do so):

    * Lowercase the WHOLE address, including the local part. Domains are
      case-insensitive by spec either way; folding the local part too is a
      deliberate choice beyond the RFC's letter, made because no mainstream
      mailbox provider actually treats the local part case-sensitively in
      practice, and NOT folding it would let "Bob@x.com" and "bob@x.com"
      silently become two different accounts a confused user has no way to
      reconcile (they'd just see an empty progress blob on whichever
      capitalization they didn't use first).

    * Deliberately NOT applying Gmail-style canonicalization: stripping dots
      from the local part ("bob.smith" == "bobsmith") or truncating at a
      "+tag" ("bob+pinball" == "bob"). That behavior is Gmail-specific (and
      a couple of other providers) — Outlook, Yahoo, and any custom domain
      do NOT fold dots or plus-tags the same way, so hard-coding Gmail's
      rule here would silently merge two DIFFERENT real inboxes into one
      account on some domains while doing nothing at all on others: neither
      outcome is something this service can verify is even correct without
      actually knowing which provider's rules apply to a given domain. The
      cost of NOT canonicalizing is small and fully recoverable — a user who
      signs in via a dot/plus variant of an address they've used before just
      sees a fresh, empty progress blob under a second account, and both
      account deletion and data export exist if that ever needs cleaning up
      by hand. The cost of getting provider-specific canonicalization wrong
      is a silent, undetectable merge of two addresses that might belong to
      two different people. Simple-and-correct beats clever-and-provider-
      specific here.
    """
    s = raw.strip().lower()
    if not s or len(s) > MAX_EMAIL_LEN or "\x00" in s:
        return None
    if not EMAIL_RE.match(s):
        return None
    # D13 fix (2026-07-30 security review): `user@example.com.` (a trailing
    # dot on the domain) is a technically-legal root-labeled FQDN under
    # DNS's own rules, and EMAIL_RE's char classes don't reject it on their
    # own (the final label just becomes the single character "."). It's an
    # extremely unusual thing for a human to type by hand and an easy way
    # to construct an address that's byte-for-byte distinct from, but reads
    # identically to, a normal one — rather than trust every downstream
    # consumer (Resend, this service's own by_email index) to normalize a
    # trailing dot the same way, reject it outright.
    if s.endswith("."):
        return None
    return s


# --------------------------------------------------------------------------
# Canonical public origin (D2 — see the module docstring's Config section
# and _build_magic_link)
# --------------------------------------------------------------------------


def validate_public_origin(value: str) -> "str | None":
    """Returns `value` re-serialized as "scheme://netloc" if it's a
    well-formed absolute https origin with no path/query/fragment/userinfo
    — None for anything else (empty, wrong scheme, a path, a stray "?" or
    "#", embedded credentials). Used at startup to validate
    PINBALL_PUBLIC_ORIGIN; a bad value is a FATAL, not a silent fallback —
    see main()."""
    try:
        parts = urllib.parse.urlsplit(value)
    except ValueError:
        return None
    if parts.scheme != "https":
        return None
    if not parts.hostname:
        return None
    if parts.username is not None or parts.password is not None:
        return None
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        return None
    return f"{parts.scheme}://{parts.netloc}"


# --------------------------------------------------------------------------
# Magic-link token hashing (see the module docstring's TOKEN CONSTRUCTION
# note for the selector/verifier split this backs)
# --------------------------------------------------------------------------


def json_depth_exceeds(doc, limit: int) -> bool:
    """True if `doc` nests deeper than `limit`. ITERATIVE on purpose (PG-09).

    A recursive depth check would itself blow the stack on exactly the input
    it exists to reject, turning the guard into the bug. This walks an explicit
    stack of (node, depth) pairs and stops the moment the limit is passed, so
    the cost is bounded by the limit rather than by the document."""
    stack = [(doc, 1)]
    while stack:
        node, depth = stack.pop()
        if depth > limit:
            return True
        if isinstance(node, dict):
            children = node.values()
        elif isinstance(node, list):
            children = node
        else:
            continue
        for child in children:
            if isinstance(child, (dict, list)):
                stack.append((child, depth + 1))
    return False


def _hash_code(code: str) -> str:
    """HMAC of a sign-in code (PG-18). Same key, own domain prefix — see
    _hash_verifier. Normalised upper-case and stripped of separators first, so
    "abcd-efgh" and "ABCDEFGH" are the same code."""
    return hmac.new(SECRET.encode("utf-8"), b"signin-code-v1:" + normalize_code(code).encode("utf-8"),
                    hashlib.sha256).hexdigest()


def normalize_code(raw: str) -> str:
    """Upper-case, strip anything that isn't in the alphabet. Lets a user type
    the code with or without the display hyphen, in either case."""
    return "".join(ch for ch in (raw or "").upper() if ch in CODE_ALPHABET)


def generate_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def format_code(code: str) -> str:
    """Display form: XXXX-XXXX. Easier to read off a phone screen."""
    half = CODE_LENGTH // 2
    return f"{code[:half]}-{code[half:]}"


def _hash_link_nonce(nonce: str) -> str:
    """HMAC of the PG-06 same-browser nonce. Same key as sign()/_hash_verifier,
    separate domain prefix — see _hash_verifier's docstring for why one key
    across independent purposes is fine as long as the prefixes differ.
    Stored on the token row; the raw nonce only ever lives in the requesting
    browser's cookie jar, so a read of magic_tokens.json does not yield
    something that satisfies the check."""
    return hmac.new(SECRET.encode("utf-8"), b"link-nonce-v1:" + nonce.encode("utf-8"), hashlib.sha256).hexdigest()


def _hash_verifier(verifier: str) -> str:
    """HMAC-SHA256 of a token's verifier half, keyed with the SAME session-
    signing SECRET the cookie scheme uses (sign(), below) but with a fixed
    domain-separation prefix so a hash computed here can never collide in
    meaning with a session signature computed there, even though they share
    a key — standard multi-use guidance for one HMAC key across independent
    purposes. Never compared with `==` — see TokenStore.consume()."""
    return hmac.new(SECRET.encode("utf-8"), b"magic-token-v1:" + verifier.encode("utf-8"), hashlib.sha256).hexdigest()


# --------------------------------------------------------------------------
# Stores: FileCache (static assets), UserStore (the account registry),
# TokenStore (live magic-link tokens). All three under the same rule: ONE
# process, ONE lock per store, read-modify-write under that lock, atomic
# os.replace on every write — the exact pattern _put_achievements() already
# used for per-user blobs before Phase 5 existed. See the module docstring's
# TOKEN CONSTRUCTION note and this class's own comment for why JSON + a
# threading.Lock was chosen over sqlite3: this service is single-process
# (pinball-auth.service is Type=simple, one ExecStart, no prefork/workers),
# so the only concurrency that ever matters is between THREADS within this
# one process, and a plain lock around read-modify-write already gives that.
# sqlite3 would earn its keep the day this becomes a multi-process
# deployment; it explicitly is not that today.
# --------------------------------------------------------------------------


class FileCache:
    """mtime-keyed cache over a static file (login.html) so a redeploy is
    picked up without restarting the service."""

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        self._mtime = None
        self._data = None

    def read(self) -> bytes:
        with self._lock:
            st = os.stat(self.path)  # OSError propagates to caller
            if self._data is None or st.st_mtime != self._mtime:
                with open(self.path, "rb") as f:
                    self._data = f.read()
                self._mtime = st.st_mtime
            return self._data


# PG-04 (2026-07-31 webapp pentest): per-uid write serialization for the
# achievements blobs. See Handler._put_achievements for the corruption this
# closes.
#
# STRIPED rather than a dict-of-locks-per-uid, deliberately. A dict keyed by
# uid would need eviction (it grows with every user that ever writes, and
# entries can't be dropped while a lock is held without a second lock to guard
# the dict) — that is real machinery to get wrong for no benefit here. A fixed
# array of locks selected by a stable hash of the uid has constant memory,
# needs no cleanup, and is never wrong: two uids that collide on a stripe just
# serialize against each other unnecessarily, which costs a few microseconds on
# a route that writes a few KB. 64 stripes against a single-digit user count
# makes even that vanishingly unlikely.
#
# hashlib rather than the builtin hash(): PYTHONHASHSEED randomizes str hashing
# per process, which is fine for correctness here but makes behaviour
# irreproducible between runs — and a test that can't pin which uids share a
# stripe can't deterministically exercise the collision path.
_ACHIEVEMENT_LOCK_STRIPES = 64
_ACHIEVEMENT_LOCKS = tuple(threading.Lock() for _ in range(_ACHIEVEMENT_LOCK_STRIPES))


def _achievements_lock(uid: str) -> threading.Lock:
    digest = hashlib.sha256(uid.encode("utf-8")).digest()
    return _ACHIEVEMENT_LOCKS[digest[0] % _ACHIEVEMENT_LOCK_STRIPES]


def subnet_key(ip: str) -> str:
    """Buckets `ip` into its containing /24 (IPv4) or /48 (IPv6) network
    string, for REQUEST_LIMIT_SUBNET (D5, 2026-07-30 security review — see
    that limiter's own comment for why a coarser-than-single-IP bucket
    exists at all: a handful of IPs sharing one subnet could otherwise
    collectively exhaust the site-wide cap while each individually staying
    under its own per-IP limit). Unparseable input (the "invalid" sentinel
    _client_ip() can return for a bogus X-Forwarded-For) gets a literal,
    fixed bucket key of its own so it can never collide with a real
    subnet's key."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return "unparsed-ip"
    prefix = 24 if addr.version == 4 else 48
    return str(ipaddress.ip_network(f"{ip}/{prefix}", strict=False))


class RateLimiter:
    """In-memory per-IP FAILURE tracker: >= max_fails failures within
    window_seconds blocks further attempts (correct or not) from that IP
    until the oldest failure ages out. Defense in depth on top of the
    fail2ban jail that watches for this service's 401s.

    Phase 5 retarget (2026-07-30): this class predates magic-link auth (it
    used to track bad-password attempts on the old POST /auth). It is kept
    as-is and now backs two different "someone is doing something a normal
    client wouldn't" signals: cross-origin-blocked POST /auth/request calls,
    and rejected GET /auth/verify tokens (malformed/tampered/expired/used).
    It is deliberately NOT used for the neutral, always-"succeeds" path of a
    well-formed same-origin POST /auth/request — see SlidingWindowLimiter
    below and the module docstring's RATE LIMITING paragraph for why a
    failure-only counter is the wrong tool for that path specifically."""

    def __init__(self, max_fails: int, window_seconds: int):
        self.max_fails = max_fails
        self.window = window_seconds
        self._lock = threading.Lock()
        self._fails: "dict[str, list[float]]" = {}

    def _prune_locked(self, ip: str, now: float) -> "list[float]":
        cutoff = now - self.window
        fails = [t for t in self._fails.get(ip, []) if t > cutoff]
        if fails:
            self._fails[ip] = fails
        else:
            self._fails.pop(ip, None)
        return fails

    def _sweep_aged_locked(self, now: float) -> None:
        """Drop every tracked IP whose most recent failure has already aged
        out of the window. Only per-IP access prunes normally (see
        _prune_locked); a flood of distinct source IPs that each fail once
        and never return would otherwise grow this dict without bound, so
        record_failure calls this instead once the dict gets large."""
        cutoff = now - self.window
        for ip, fails in list(self._fails.items()):
            if not fails or fails[-1] <= cutoff:
                self._fails.pop(ip, None)

    def is_blocked(self, ip: str) -> bool:
        with self._lock:
            fails = self._prune_locked(ip, time.time())
            return len(fails) >= self.max_fails

    def record_failure(self, ip: str) -> None:
        with self._lock:
            now = time.time()
            if len(self._fails) > RATE_LIMIT_MAX_TRACKED_IPS:
                self._sweep_aged_locked(now)
            fails = self._prune_locked(ip, now)
            fails.append(now)
            self._fails[ip] = fails

    def record_success(self, ip: str) -> None:
        with self._lock:
            self._fails.pop(ip, None)

    def retry_after(self, ip: str) -> int:
        """Seconds until `ip`'s oldest tracked failure ages out of the
        window and it stops being blocked — used to render "try again in N
        minutes" (D5, 2026-07-30 security review) instead of a bare 429.
        0 if `ip` isn't currently blocked at all; a coarse UX estimate, not
        an exact-to-the-second promise."""
        with self._lock:
            fails = self._prune_locked(ip, time.time())
            if not fails:
                return 0
            return max(1, int(self.window - (time.time() - fails[0])) + 1)


class SlidingWindowLimiter:
    """Caps the COUNT of accepted calls (not just failures) to a bucketed
    key within a rolling window — the piece RateLimiter does NOT provide.
    Five instances back POST /auth/request: per client IP, per /24-or-/48
    subnet, per (IP, email) pair, one keyed by a single constant key
    (_GLOBAL_KEY) for a site-wide ceiling, and a per-subnet RESERVE that is
    consulted only once that global ceiling is exhausted (NEW-3). See REQUEST_LIMIT_* above for the
    numbers and the reasoning behind each."""

    def __init__(self, max_count: int, window_seconds: int, max_tracked_keys: int = 10_000):
        self.max_count = max_count
        self.window = window_seconds
        self.max_tracked_keys = max_tracked_keys
        self._lock = threading.Lock()
        self._hits: "dict[str, list[float]]" = {}

    def _prune_locked(self, key: str, now: float) -> "list[float]":
        cutoff = now - self.window
        hits = [t for t in self._hits.get(key, []) if t > cutoff]
        if hits:
            self._hits[key] = hits
        else:
            self._hits.pop(key, None)
        return hits

    def _sweep_aged_locked(self, now: float) -> None:
        cutoff = now - self.window
        for k, hits in list(self._hits.items()):
            if not hits or hits[-1] <= cutoff:
                self._hits.pop(k, None)

    def allow(self, key: str) -> bool:
        """Checks-and-records one hit for `key` atomically under one lock,
        so two requests racing at exactly max_count can't both slip through.
        Returns False (and does NOT record a hit) once `key` is already at
        the cap within the window."""
        with self._lock:
            now = time.time()
            if len(self._hits) > self.max_tracked_keys:
                self._sweep_aged_locked(now)
            hits = self._prune_locked(key, now)
            if len(hits) >= self.max_count:
                return False
            hits.append(now)
            self._hits[key] = hits
            return True

    def retry_after(self, key: str) -> int:
        """Seconds until `key`'s oldest hit ages out of the window and a
        new call would be allowed again — see RateLimiter.retry_after's
        docstring for the same UX-estimate caveat. 0 if `key` isn't
        currently at its cap."""
        with self._lock:
            hits = self._prune_locked(key, time.time())
            if len(hits) < self.max_count:
                return 0
            return max(1, int(self.window - (time.time() - hits[0])) + 1)


class UserStore:
    """The account registry: uid -> {email, created_at, last_login_at}, plus
    an email -> uid reverse index for POST /auth/request's lookups. See this
    section's header comment for the JSON-+-lock-+-atomic-replace design and
    why sqlite3 wasn't needed. Loaded once and kept authoritative in memory
    (unlike FileCache/the old AuthStore, this store is never re-stat'd on
    read — those existed to notice an OPERATOR redeploying a static file out
    from under a running process; this store has exactly one writer, this
    process itself, so re-checking mtime on every read would only add I/O
    for no benefit)."""

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        self._data = None  # "dict[str, dict] | None"

    def _load_locked(self) -> None:
        if self._data is not None:
            return
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            self._data = {"users": {}, "by_email": {}}
            return
        except (OSError, json.JSONDecodeError) as e:
            raise RuntimeError(f"cannot read/parse {self.path}: {e}") from e
        if not isinstance(data, dict) or "users" not in data or "by_email" not in data:
            raise RuntimeError(f"{self.path}: unexpected shape (expected 'users'/'by_email' keys)")
        self._data = data

    def _write_locked(self) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._data, f, separators=(",", ":"))
        # D12 fix (2026-07-30 security review): open()'s mode is subject to
        # the process umask, and the default umask left this file (which
        # holds every registered email address in cleartext) at -rw-r--r--
        # — world-readable, a regression from the retired auth.json's 0640.
        # chmod BEFORE the atomic os.replace so the file at its final path
        # is never even briefly at the umask-derived mode.
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    def preload(self) -> None:
        """Loads (and validates) the store once at startup so a corrupt
        file is a loud, immediate FATAL at boot — same posture the old
        AuthStore took toward a corrupt auth.json — rather than a confusing
        500 on the first real request."""
        with self._lock:
            self._load_locked()

    def find_or_create(self, email: str) -> "tuple[str, bool]":
        """Returns (uid, created). Idempotent lookup-or-create under one
        lock, so two verifies racing the same not-yet-registered address
        (two still-live tokens for the same email, both clicked before
        either resolves) can't race two different uids into existence for
        it.

        CALLED ONLY FROM _do_verify's successful-consume path, NEVER FROM
        POST /auth/request (D7 fix, 2026-07-30 security review — see the
        module docstring's "DEFERRED ACCOUNT CREATION" section): a
        permanent row here used to be created the instant someone typed ANY
        syntactically-plausible address into the sign-in form, whether or
        not they ever proved they could read that inbox (reproduced: 55
        rows, zero of which had ever clicked a link). This is now reached
        only after TokenStore.consume() has already confirmed a valid,
        single-use, unexpired token — i.e. after the caller has proven
        inbox control.

        WRITES THROUGH UNCONDITIONALLY, even when `email` already had a
        uid and nothing changed. This was originally load-bearing for POST
        /auth/request's enumeration resistance (see the module docstring's
        ENUMERATION note) — a known address had to cost the same disk I/O
        as an unknown one. Now that this method is only ever reached from a
        successful verify, that specific timing concern no longer applies
        HERE (presenting a valid consumed-once token is a far stronger,
        already-asymmetric signal than merely typing an address). Left
        as an unconditional write anyway, for simplicity and to match
        touch_login's own always-write shape, rather than adding this
        store's first conditional-write code path for a property this call
        site no longer needs.
        """
        with self._lock:
            self._load_locked()
            uid = self._data["by_email"].get(email)
            created = uid is None
            if created:
                uid = secrets.token_urlsafe(12)
                now = int(time.time())
                self._data["users"][uid] = {
                    "email": email,
                    "created_at": now,
                    "last_login_at": None,
                    "session_epoch": 0,  # see bump_epoch()/REVOKE-SESSIONS below
                }
                self._data["by_email"][email] = uid
            self._write_locked()
            return uid, created

    def exists(self, uid: str) -> bool:
        with self._lock:
            self._load_locked()
            return uid in self._data["users"]

    def get(self, uid: str) -> "dict | None":
        with self._lock:
            self._load_locked()
            rec = self._data["users"].get(uid)
            return dict(rec) if rec is not None else None

    def bump_epoch(self, uid: str) -> "int | None":
        """Increments `uid`'s session_epoch and returns the new value, or
        None if `uid` doesn't exist. See sign()/_valid_session()'s own
        comments for how this folds into the cookie signature: every
        outstanding session cookie for this user (however many devices, and
        including any copy an attacker captured earlier) was signed against
        the OLD epoch, so every one of them stops verifying the instant this
        returns — without touching the user row, the achievements blob, or
        any other account data. This is what POST /auth/revoke-sessions
        calls (D-EPOCH, 2026-07-31 security review, closing the gap the
        2026-07-30 review's NEW-1/signout work explicitly flagged and
        deferred: before this, the ONLY way to invalidate a leaked session
        cookie was full account deletion — destroying the achievements blob
        along with it — because sessions are stateless signed cookies with
        no server-side row to revoke individually. A per-user epoch is the
        standard fix for "stateless token, needs occasional revocation"
        without reintroducing a server-side session table: one integer per
        user, checked on every request, bumped on demand.)"""
        with self._lock:
            self._load_locked()
            rec = self._data["users"].get(uid)
            if rec is None:
                return None
            new_epoch = int(rec.get("session_epoch", 0)) + 1
            rec["session_epoch"] = new_epoch
            self._write_locked()
            return new_epoch

    def touch_login(self, uid: str) -> None:
        with self._lock:
            self._load_locked()
            rec = self._data["users"].get(uid)
            if rec is None:
                return
            rec["last_login_at"] = int(time.time())
            self._write_locked()

    def delete(self, uid: str) -> "str | None":
        """Removes the user row + the email index entry; returns the
        removed email (or None if the uid didn't exist) so the caller can
        also purge that email's live magic tokens (see TokenStore.
        delete_for_email) and achievements blob."""
        with self._lock:
            self._load_locked()
            rec = self._data["users"].pop(uid, None)
            if rec is None:
                return None
            self._data["by_email"].pop(rec["email"], None)
            self._write_locked()
            return rec["email"]


class TokenStore:
    """Live magic-link tokens: selector -> {verifier_hash, email, exp, used,
    created_at}. See the module docstring's TOKEN CONSTRUCTION and
    SINGLE-USE sections for the selector/verifier split and why consume()
    does everything under one lock.

    NOTE (D7, 2026-07-30 security review): a row here no longer carries a
    `uid` field. Before this fix, POST /auth/request called
    UserStore.find_or_create() up front and stashed the resulting uid on
    the token at issue time; now that account creation is deferred to a
    successful verify (see the module docstring's "DEFERRED ACCOUNT
    CREATION" section), no uid exists yet when a token is issued — a live
    row here IS the entire record of a not-yet-proven signup attempt, keyed
    on the email alone, and it ages out via the ordinary TTL + prune path
    exactly like any other unused token if the recipient never clicks it."""

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        self._data = None  # "dict[str, dict] | None"

    def _load_locked(self) -> None:
        if self._data is not None:
            return
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            self._data = {}
            return
        except (OSError, json.JSONDecodeError) as e:
            raise RuntimeError(f"cannot read/parse {self.path}: {e}") from e
        if not isinstance(data, dict):
            raise RuntimeError(f"{self.path}: unexpected shape (expected an object)")
        self._data = data

    def _write_locked(self) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._data, f, separators=(",", ":"))
        # D12 fix (2026-07-30 security review): see UserStore._write_locked's
        # identical comment — this file holds every LIVE bearer credential
        # (magic-link verifier hashes) and was equally world-readable.
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    def preload(self) -> None:
        with self._lock:
            self._load_locked()

    def _prune_locked(self) -> None:
        """Drops tokens whose TTL (plus a grace window — see
        MAGIC_TOKEN_PRUNE_GRACE — so a just-expired token still renders
        "expired" rather than "not found" for a little while) has fully
        passed. Runs on every issue() so the file can never grow without
        bound purely from request volume: the token TTL is short, so even a
        sustained flood only ever holds a bounded number of live rows
        before this reclaims them."""
        cutoff = int(time.time()) - MAGIC_TOKEN_PRUNE_GRACE
        for sel in [s for s, rec in self._data.items() if rec["exp"] < cutoff]:
            del self._data[sel]

    def peek(self, token: str) -> "tuple[str, str | None, str | None]":
        """Validate `token` WITHOUT consuming it: returns
        (status, email, nonce_hash) with exactly the same status vocabulary and
        the same deliberate indistinguishability as consume().

        PG-06 (2026-07-31 webapp pentest). _do_verify has to decide whether
        this click came from the browser that ASKED for the link before it
        decides whether to mint a session outright or show a confirmation —
        and it must be able to name the address on that confirmation page. Both
        need the row's contents while leaving the token spendable, because a
        user who is shown "sign in as x@y?" and taps Confirm must still have a
        live token to spend. Splitting read from spend is the whole point;
        consume() below is unchanged and is still the only thing that flips
        `used`, so the single-use guarantee is untouched.

        `nonce_hash` is None for a row written before this field existed — the
        magic_tokens.json rows already in flight at deploy time. Those degrade
        to the confirmation page rather than failing, which is the safe
        direction (an extra tap, never a wrongly-minted session)."""
        parts = token.split(".", 1)
        if len(parts) != 2 or not parts[0] or not parts[1] or len(parts[1]) > 128:
            return "invalid", None, None
        selector, verifier = parts
        with self._lock:
            self._load_locked()
            rec = self._data.get(selector)
            if rec is None:
                return "invalid", None, None
            if not hmac.compare_digest(_hash_verifier(verifier), rec["verifier_hash"]):
                return "invalid", None, None
            if rec["used"]:
                return "used", None, None
            if rec["exp"] <= int(time.time()):
                return "expired", None, None
            return "ok", rec["email"], rec.get("nonce_hash")

    def issue(self, email: str, nonce_hash: "str | None" = None) -> "tuple[str, str]":
        """Creates + persists a new single-use token (pruning expired ones
        first) and returns the opaque link token (`selector.verifier`) to
        embed in the emailed URL. Takes only `email`, not a uid — see this
        class's docstring (D7): no account exists yet for a brand-new
        address at issue time.

        D9 FIX (2026-07-30 security review): revokes every other still-
        UNUSED token already on file for this same email first. Before this
        fix, up to REQUEST_LIMIT_PER_EMAIL_MAX (3) separately-emailed bearer
        credentials for the same address stayed simultaneously valid — a
        "send it again" click didn't retire the earlier link, so a stale,
        possibly-forwarded-or-forgotten link from 14 minutes ago was just
        as live as the newest one. At most ONE unused token per email is
        now ever live. Already-USED tokens are left alone (not touched by
        this loop) so a replay of an old, already-consumed link still
        renders the "already used" page rather than suddenly "invalid"/
        not-found. Keyed on email rather than uid for the same reason
        issue() takes email in the first place: no uid exists yet for a
        first-time signup. This does not reopen the enumeration timing gap
        (see the module docstring's ENUMERATION note): the loop below is a
        full scan of _data regardless of whether it finds 0 or 2 matches
        (the _prune_locked() call just above it already does an equivalent
        full scan), so a brand-new address and a returning one do the same
        order of work either way."""
        with self._lock:
            self._load_locked()
            self._prune_locked()
            for sel in [s for s, rec in self._data.items() if rec["email"] == email and not rec["used"]]:
                del self._data[sel]
            selector = secrets.token_urlsafe(9)
            verifier = secrets.token_urlsafe(32)
            code = generate_code()  # PG-18
            now = int(time.time())
            self._data[selector] = {
                "verifier_hash": _hash_verifier(verifier),
                "email": email,
                "exp": now + MAGIC_TOKEN_TTL,
                "used": False,
                "created_at": now,
                # PG-06: HMAC of the nonce handed to the REQUESTING browser as
                # a cookie. Only _do_verify reads it; see peek() above.
                "nonce_hash": nonce_hash,
                # PG-18: the emailed sign-in code, hashed exactly like the
                # link's verifier. Spending either one marks THIS row used, so
                # a link and its code can never both be redeemed.
                "code_hash": _hash_code(code),
            }
            self._write_locked()
            return f"{selector}.{verifier}", code

    def consume(self, token: str) -> "tuple[str, str | None]":
        """Validates + ATOMICALLY marks `token` used, all under the single
        lock — so two requests racing the same token (a double-clicked
        email link, or a mail-scanner prefetch racing the real click) can
        never both succeed: whichever acquires the lock first flips `used`
        and returns ("ok", email); the second sees used=True and gets
        ("used", None), same as any other replay. Returns ("invalid", None)
        for a malformed token, an unknown selector, or a verifier that
        doesn't match (all three are indistinguishable to the caller by
        design — none of them tell an attacker anything about which emails
        are registered), and ("expired", None) once the TTL has passed.
        Callers render a distinct friendly page per status (see
        _verify_error_page) purely for UX — none of the three failure
        statuses leaks registration status. The caller (Handler._do_verify)
        is responsible for turning a successful ("ok", email) into an
        actual account via UserStore.find_or_create(email) — see the
        module docstring's "DEFERRED ACCOUNT CREATION" section for why that
        happens there and not in here."""
        parts = token.split(".", 1)
        if len(parts) != 2 or not parts[0] or not parts[1] or len(parts[1]) > 128:
            return "invalid", None
        selector, verifier = parts
        with self._lock:
            self._load_locked()
            rec = self._data.get(selector)
            if rec is None:
                return "invalid", None
            expected = _hash_verifier(verifier)
            if not hmac.compare_digest(expected, rec["verifier_hash"]):
                return "invalid", None
            if rec["used"]:
                return "used", None
            if rec["exp"] <= int(time.time()):
                return "expired", None
            rec["used"] = True
            self._write_locked()
            return "ok", rec["email"]

    def sweep(self) -> None:
        """Time-driven retention (PG-17, 2026-07-31 review).

        _prune_locked() only ever ran from issue(), so retention was a function
        of TRAFFIC, not of time: if nobody signs in, every row — each holding an
        address somebody typed into the form — sits on disk forever, which is
        not what the privacy page says happens. This runs on a timer instead,
        and writes (`_prune_locked` only mutates the in-memory dict)."""
        with self._lock:
            self._load_locked()
            before = len(self._data)
            self._prune_locked()
            if len(self._data) != before:
                self._write_locked()
                return
        return

    def consume_code(self, email: str, raw_code: str) -> str:
        """Redeem a sign-in code for `email` (PG-18). Returns the same status
        vocabulary as consume(): "ok" | "invalid" | "used" | "expired".

        Scans this email's rows and compares every candidate with
        hmac.compare_digest — the scan is over the whole (small) live-token set
        either way, so a wrong code costs the same work as a right one. Marks
        the row used under the same lock consume() uses, so a code and its link
        race exactly like two clicks of the same link do: one wins."""
        code = normalize_code(raw_code)
        if len(code) != CODE_LENGTH:
            return "invalid"
        expected = _hash_code(code)
        with self._lock:
            self._load_locked()
            matched = None
            for rec in self._data.values():
                if rec.get("email") != email:
                    continue
                stored = rec.get("code_hash")
                if stored and hmac.compare_digest(expected, stored):
                    matched = rec
            if matched is None:
                return "invalid"
            if matched["used"]:
                return "used"
            if matched["exp"] <= int(time.time()):
                return "expired"
            matched["used"] = True
            self._write_locked()
            return "ok"

    def delete_for_email(self, email: str) -> None:
        """Revokes every live token for `email` — called from account
        deletion (renamed from delete_for_uid, D7: rows no longer carry a
        uid — see this class's docstring) so a token emailed minutes ago
        can't silently mint a brand-new replacement account moments after
        the user asked this one to be deleted."""
        with self._lock:
            self._load_locked()
            for sel in [s for s, rec in self._data.items() if rec["email"] == email]:
                del self._data[sel]
            self._write_locked()


def load_secret(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = f.read().strip()
    except OSError as e:
        print(f"FATAL: cannot read secret file {path}: {e}", file=sys.stderr)
        sys.exit(1)
    if len(data) < 64 or not HEX_RE.match(data):
        print(
            f"FATAL: secret file {path} is missing/short/invalid (need >= 64 hex characters)",
            file=sys.stderr,
        )
        sys.exit(1)
    return data.lower()


def sign(uid: str, exp: int, epoch: int) -> str:
    """D-EPOCH (2026-07-31 security review): `epoch` is UserStore's current
    session_epoch for `uid` at the moment of signing/verifying — NOT carried
    in the cookie itself (the cookie's wire shape stays exactly
    `uid.exp.sig`; see the module docstring's Session cookie section). Both
    _success_login (signs) and _valid_session (re-derives and compares) look
    it up fresh from UserStore, so a cookie signed under an old epoch stops
    matching the moment UserStore.bump_epoch(uid) runs, with no change to
    what's stored in the browser at all. See bump_epoch()'s own docstring
    for why this exists: it's the difference between "delete the whole
    account" and "sign out every device" as the only two responses this
    service has to a leaked cookie."""
    msg = f"{uid}.{exp}.{epoch}"
    return hmac.new(SECRET.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()


def encode_cookie_field(s: str) -> str:
    """Percent-encode `s` for embedding in the dot-delimited session cookie
    value. urllib.parse.quote treats '.' as always-safe (RFC 3986 unreserved)
    and leaves it unescaped, but '.' is this cookie's field delimiter, so it
    is escaped here on top of quote()'s normal output to keep the 3-field
    split in _valid_session unambiguous regardless of what UID_RE ever
    allows."""
    return urllib.parse.quote(s, safe="").replace(".", "%2E")


# --------------------------------------------------------------------------
# Path-traversal-safe static file resolution
# --------------------------------------------------------------------------


def resolve_safe_path(base_dir: str, url_path: str) -> "str | None":
    """Resolves `url_path` (already percent-decoded, leading '/' stripped)
    against `base_dir`, refusing anything that escapes it (../, absolute
    symlink targets, embedded NULs, etc). Returns the real filesystem path,
    or None if unsafe or unresolvable."""
    if "\x00" in url_path:
        return None
    rel = url_path.lstrip("/")
    base_real = os.path.realpath(base_dir)
    candidate = os.path.realpath(os.path.join(base_dir, rel))
    if candidate == base_real or candidate.startswith(base_real + os.sep):
        return candidate
    return None


def guess_mime(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in EXTRA_MIME_TYPES:
        return EXTRA_MIME_TYPES[ext]
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


# --------------------------------------------------------------------------
# GET /auth/verify's friendly error page — a small static template (never a
# stack trace, never a bare 401 body — the STATUS is still 401 so fail2ban's
# existing Caddy-access-log filter keeps working; see the module docstring's
# "A GET THAT CONSUMES A TOKEN" note). Reuses login.css (already public, no
# session, in both modes) for visual consistency instead of shipping a
# second stylesheet.
# --------------------------------------------------------------------------

_VERIFY_ERROR_COPY = {
    "invalid": (
        "This link isn't valid",
        "Sign-in links are single-use and only work exactly as emailed. "
        "If you copied part of the link instead of clicking it directly, "
        "go back to your email and click it again.",
    ),
    "expired": (
        "This link has expired",
        "Sign-in links work for 15 minutes after they're sent. Request a "
        "fresh one below.",
    ),
    "used": (
        "This link has already been used",
        "Each sign-in link works once. If that wasn't you, request a fresh "
        "link below.",
    ),
}


def _verify_confirm_page(email: str, token: str) -> bytes:
    """PG-06 (2026-07-31 webapp pentest) — the cross-device confirmation step.

    THE FINDING. GET /auth/verify minted a session for whoever opened the URL,
    with nothing tying the token to the browser that requested it. So an
    attacker could request a link for THEIR OWN address and get a victim to
    open it: the victim is silently signed in as the attacker, and everything
    they record afterwards accrues to the attacker's account, readable via
    GET /auth/export. That is textbook login CSRF, and it is the one class a
    one-click magic link invites by construction.

    THE FIX, AND WHY IT ISN'T JUST "ALWAYS CONFIRM". POST /auth/request now
    hands the requesting browser a nonce cookie and stores its HMAC on the
    token. When the click arrives WITH a matching nonce — the same browser that
    asked, which is the overwhelmingly common case, including the iOS
    Mail-opens-Safari path — nothing changes: one click, straight in. This page
    is only reached when the nonce is missing or wrong, i.e. a genuinely
    different browser, which is exactly when "is this really your sign-in?"
    is a question worth asking.

    It names the ADDRESS, which is what actually defeats the attack: a victim
    who is about to be signed in as someone else sees whose account it is
    before anything happens. The token is deliberately NOT consumed to render
    this page — it is spent by the POST below — so a user who lands here and
    confirms still has a live, single-use token to spend.

    BACK LINK (2026-07-31, rolo): both this page and _verify_error_page carry
    an explicit "Back to Pinball Genie" link. They are full server-rendered
    pages, and in an INSTALLED PWA there is no address bar and no back button —
    a user who lands here with only a "request another link" option is simply
    stuck, with no route into the app at all. login.html already had its own
    "Skip sign-in" escape hatch for exactly this reason; these two pages did not.

    Same self-contained-template approach as _verify_error_page (reusing
    login.css, which is already public in both modes) rather than a new
    templated file: this page has no state to substitute beyond two values,
    and login.html's own header comment documents at length what goes wrong
    when marker substitution spreads across files."""
    return (
        "<!doctype html>\n"
        '<html lang="en"><head><meta charset="UTF-8" />\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1" />\n'
        "<title>Pinball Genie — Confirm sign-in</title>\n"
        '<meta name="robots" content="noindex, nofollow" />\n'
        '<link rel="stylesheet" href="/login.css" />\n'
        "</head><body>\n"
        '<div class="card">\n'
        '  <div class="marquee"><div class="marquee-ball" aria-hidden="true"></div><h1>Pinball Genie</h1></div>\n'
        '  <div class="verify-error">\n'
        '    <p class="verify-error-title">Confirm sign-in</p>\n'
        '    <p class="verify-error-body">This link was opened on a different browser '
        "than the one that asked for it. Check the address below is yours, then continue.</p>\n"
        f'    <p class="verify-confirm-email"><strong>{html_lib.escape(email)}</strong></p>\n'
        '    <form method="POST" action="/auth/verify">\n'
        f'      <input type="hidden" name="token" value="{html_lib.escape(token, quote=True)}" />\n'
        # Bare <button>: login.css styles the element, not a .submit class —
        # the sign-in form it already serves uses exactly this shape.
        '      <button type="submit">Sign in as this address</button>\n'
        "    </form>\n"
        '    <a class="login-alt-link" href="/login">Not you? Request your own link &rarr;</a>\n'
        '    <a class="login-alt-link login-back-link" href="/">&larr; Back to Pinball Genie</a>\n'
        "  </div>\n"
        "</div>\n"
        "</body></html>\n"
    ).encode("utf-8")


def _verify_error_page(reason: str) -> bytes:
    title, body = _VERIFY_ERROR_COPY.get(reason, _VERIFY_ERROR_COPY["invalid"])
    return (
        "<!doctype html>\n"
        '<html lang="en"><head><meta charset="UTF-8" />\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1" />\n'
        "<title>Pinball Genie — Sign-in link problem</title>\n"
        '<meta name="robots" content="noindex, nofollow" />\n'
        '<link rel="stylesheet" href="/login.css" />\n'
        "</head><body>\n"
        '<div class="card">\n'
        '  <div class="marquee"><div class="marquee-ball" aria-hidden="true"></div><h1>Pinball Genie</h1></div>\n'
        '  <div class="verify-error">\n'
        f'    <p class="verify-error-title">{html_lib.escape(title)}</p>\n'
        f'    <p class="verify-error-body">{html_lib.escape(body)}</p>\n'
        '    <a class="login-alt-link" href="/login">Request a new sign-in link &rarr;</a>\n'
        '    <a class="login-alt-link login-back-link" href="/">&larr; Back to Pinball Genie</a>\n'
        "  </div>\n"
        "</div>\n"
        "</body></html>\n"
    ).encode("utf-8")


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "pinball-auth/2.0"
    protocol_version = "HTTP/1.1"
    # See vegas2_auth.py's identical comment: without a socket timeout, a
    # client that opens a connection and trickles bytes (or sends none)
    # pins a worker thread forever — slowloris. 15s comfortably covers a
    # slow mobile client on a form submit.
    timeout = 15

    # ------------------------------------------------------------------
    # C1 (CRITICAL, 2026-07-31 security audit) — REQUEST SMUGGLING GUARD.
    #
    # THE BUG THIS CLOSES. Any route that answered without reading a declared
    # request body left those bytes sitting in the socket. Caddy POOLS backend
    # connections ACROSS DIFFERENT DOWNSTREAM VISITORS, so the leftover bytes
    # were handed to the next victim's request as if they belonged to it. An
    # unauthenticated attacker sent one ordinary request:
    #
    #     GET /health HTTP/1.1
    #     Content-Length: 91
    #
    #     POST /auth/delete HTTP/1.1
    #     Sec-Fetch-Site: none
    #     X-Junk:                      <-- deliberately UNTERMINATED
    #
    # do_GET answered 200 and never consumed the 91 bytes. The next visitor
    # routed over that pooled socket had their request line and headers —
    # INCLUDING THEIR Cookie — absorbed as header-continuation lines of the
    # attacker's smuggled request, which then executed AS THAT VICTIM. The
    # audit reproduced unauthenticated deletion of a victim's account, and
    # session fixation binding a victim's browser to the attacker's account,
    # through real Caddy 2.11.4 running the production site config.
    #
    # WHY THIS IS STRUCTURAL AND NOT ANOTHER _drain_or_close CALL SITE.
    # The earlier fix enumerated routes and added _drain_or_close() to each.
    # That is a list somebody must remember to extend, and it was already
    # incomplete the day it shipped — do_GET and do_HEAD were never on it,
    # which is exactly the hole above. Hooking handle_one_request covers every
    # method, every route, and every route added later, by default. It also
    # subsumes the chunked-encoding variant (L4) for free: Transfer-Encoding
    # is checked here too, and this server has no chunked parser at all.
    #
    # Closing the connection is right rather than draining: this server has no
    # legitimate use for a body on a request whose handler ignores it, and a
    # close cannot be got subtly wrong the way a partial drain can. The cost is
    # one dropped keep-alive per malformed request, which only an attacker or a
    # broken client ever triggers.
    #
    # WHY EVERY EXISTING TEST MISSED IT: they all smuggled a COMPLETE request,
    # which Go's HTTP transport rejects via its "unsolicited response on idle
    # connection" guard. An UNTERMINATED prefix produces no extra response and
    # sails straight past that. The regression test added with this fix
    # smuggles an unterminated prefix on a GET.
    # PG-08 (HIGH, 2026-07-31 adversarial review) — THE C1 GUARD HAD A HOLE,
    # AND IT WAS EXACTLY THE ARM C1's OWN COMMENT CLAIMED TO COVER.
    #
    # C1 above says "It also subsumes the chunked-encoding variant (L4) for
    # free: Transfer-Encoding is checked here too". It did not, because the
    # check was written as `not self._body_read AND (CL or TE)` — the
    # `_body_read` test short-circuits first, and one route sets that flag
    # while reading NOTHING:
    #
    #   _do_auth_request does `length = int(length_header) if length_header
    #   is not None else 0`. A chunked request carries NO Content-Length, so
    #   length is 0, _read_body_bounded(0) returns b"" instantly, and the next
    #   line asserts `_body_read = True` — "body consumed, connection safe to
    #   reuse" — when not one byte of the chunked frame has been touched.
    #   This server has no chunked parser at all, so the whole
    #   `<hex>\r\n<data>\r\n0\r\n\r\n` frame stays in the socket.
    #
    # Caddy forwards HTTP/1.1 chunked bodies to the backend STILL CHUNKED
    # (request_buffers 256KiB buffers the bytes but does not re-frame them),
    # the response is an ordinary 302 with no `Connection: close`, so Go
    # returns the socket to its shared pool believing it healthy. Python's
    # keep-alive loop then parses the leftover chunk-size token as a request
    # line, and because request_version has already reset to HTTP/0.9 the
    # resulting send_error writes a bare HTML body with NO status line and NO
    # headers onto a connection Caddy is about to hand to a real visitor.
    #
    # Measured against real Caddy 2.11.4 with the production reverse_proxy
    # block: 8 attacker connections drove **15.3% of unrelated visitors'
    # requests to 502** (1864/12207; 17.1% on a repeat), while the
    # byte-identical Content-Length-framed control produced 0 of 10578. No
    # rate limiter stops it — the poisoning is complete before any limiter is
    # consulted — and fail2ban cannot see it, because the neutral path answers
    # 302, not 401.
    #
    # THE FIX: test Transfer-Encoding FIRST and UNCONDITIONALLY. `_body_read`
    # can only ever mean "the Content-Length body was consumed"; it can never
    # be evidence about a chunked body, because there is no code in this file
    # that could consume one. Making the TE arm independent of the flag is
    # what C1's comment always claimed the code did.
    def handle_one_request(self):
        self._body_read = False
        super().handle_one_request()
        try:
            hdrs = self.headers
        except AttributeError:
            hdrs = None
        if hdrs is None:
            return
        if hdrs.get("Transfer-Encoding"):
            # No chunked parser exists here, so a chunked body is unread by
            # definition — regardless of what any handler set _body_read to.
            self.close_connection = True
        elif not self._body_read and hdrs.get("Content-Length"):
            self.close_connection = True

    # ------------------------------------------------------------------
    # PG-01 (CRITICAL, 2026-07-31 webapp pentest) — CONTROL CHARACTERS IN
    # THE REQUEST TARGET.
    #
    # THE BUG THIS CLOSES. _serve_machine_guide() answers a trailing-slash
    # /machines URL with a 301 whose Location is built from the request's own
    # PERCENT-DECODED path (`canonical = path.rstrip("/")`). CPython's
    # http.server.send_header does NO CR/LF filtering on header values — it
    # is a bare `"%s: %s\r\n" % (keyword, value)` — so a %0d%0a in the path
    # terminated the Location header early and everything after it was
    # emitted as further response headers:
    #
    #     GET /machines/%0d%0aSet-Cookie:%20pinball_session=<attacker>;%20Path=/;/
    #
    #  ->  Location: /machines/
    #      Set-Cookie: pinball_session=<attacker>; Path=/
    #
    # Verified against the LIVE site: an X-Injected-Probe header sent this way
    # came back in the real response from https://pinball-genie.com, so Caddy
    # forwards injected headers to the browser unchanged. The Set-Cookie form
    # is a one-click session fixation — the victim's browser is silently bound
    # to the ATTACKER's account, and every achievement they record afterwards
    # lands in the attacker's blob, readable via GET /auth/export.
    #
    # (Two things do NOT work, tested rather than assumed, and neither is
    # relied on here: Caddy's `header` directive REPLACES Content-Security-
    # Policy/X-Frame-Options/HSTS, so those can't be weakened; and a full
    # response split doesn't reach another visitor, because Go's transport
    # discards the desynced pooled connection. Novel headers and Set-Cookie
    # are enough on their own.)
    #
    # WHY parse_request AND NOT A FIX IN _serve_machine_guide. Sanitizing the
    # one route that happens to reflect the path today is the same
    # enumerate-the-callsites mistake the C1 comment above dissects: it is a
    # list somebody must remember to extend, and the next route that puts any
    # request-derived string into a header reopens it. parse_request() is the
    # single point every method and every route — including routes added
    # later — already passes through, and returning False from it rejects the
    # request before any do_*() handler ever runs. A request target carrying a
    # raw control character has no legitimate meaning for this service: the
    # only decoded inputs it ever sees are path segments, catalog slugs, a
    # base64url magic-link token, and `sent=1`.
    #
    # send_header below is the second layer — an assertion that must never
    # fire now that this one exists.
    def parse_request(self):
        if not super().parse_request():
            return False  # stdlib already sent its own error response
        try:
            decoded = urllib.parse.unquote(self.path)
        except Exception:  # noqa: BLE001 - malformed target is a 400 either way
            self.send_error(400, "Bad Request")
            return False
        if any(ch in _CONTROL_CHARS for ch in decoded):
            self._log_event("bad_request", "reason=control-char-in-target")
            self.send_error(400, "Bad Request")
            return False
        # PG-08 companion: refuse chunked outright rather than accepting the
        # request and silently ignoring a body this server cannot parse. The
        # close in handle_one_request is what makes the desync unreachable;
        # this makes the client's experience honest (411 Length Required, RFC
        # 9110 §15.5.12) instead of a 302 that pretends the body was read.
        # Nothing legitimate here sends chunked: the SPA's fetch() calls and
        # every HTML form both emit Content-Length.
        if self.headers.get("Transfer-Encoding"):
            self._log_event("bad_request", "reason=chunked-unsupported")
            self.send_error(411, "Length Required")
            return False
        return True

    def send_header(self, keyword, value):
        """PG-01 layer 2: refuse to emit a header value containing CR or LF.

        parse_request() above already rejects the only known way to get one
        here, so this is a fail-closed assertion rather than a filter: if it
        ever raises, a NEW injection path has been introduced and the right
        outcome is a dead connection and a stack trace in the service log, not
        a quietly-sanitized header that still ships a half-attacker-controlled
        response. Deliberately raises instead of stripping — silently rewriting
        a header value would hide the very bug this is here to surface."""
        if isinstance(value, str) and ("\r" in value or "\n" in value):
            raise ValueError(
                f"refusing to emit header {keyword!r} containing CR/LF "
                "(PG-01 response-splitting guard)"
            )
        # PG-07 companion assertion. The stdlib encodes header values as
        # latin-1/strict, so anything above U+00FF raises UnicodeEncodeError
        # from deep inside send_response and takes the whole worker thread with
        # it — no response, just a logged traceback (see _redirect's comment for
        # the incident). _redirect now percent-encodes the only request-derived
        # header this server emits, which makes this unreachable; it stays as a
        # named, immediate failure so that a FUTURE header built from user data
        # surfaces here with an obvious message instead of as a mystery empty
        # response 200 lines down a stack trace.
        if isinstance(value, str):
            try:
                value.encode("latin-1")
            except UnicodeEncodeError as e:
                raise ValueError(
                    f"refusing to emit header {keyword!r}: value is not latin-1 encodable "
                    f"({e.reason} at position {e.start}) — percent-encode it first "
                    "(PG-07; see _redirect)"
                ) from e
        super().send_header(keyword, value)

    def log_message(self, fmt, *args):  # noqa: A002 - stdlib signature
        pass  # structured logging via _log_event instead

    # -- helpers -------------------------------------------------------

    def _client_ip(self) -> str:
        # X-Forwarded-For is only honored when the TCP peer itself is
        # loopback: this service binds 127.0.0.1 and Caddy's reverse_proxy
        # is the only intended caller, so any request whose *socket* peer
        # isn't loopback is talking to us directly and gets no say over its
        # own logged/rate-limited identity. This does not distinguish Caddy
        # from some other loopback process on the same box — anything with
        # local access to this host can still forge XFF — but it does stop
        # a non-loopback network caller from spoofing it.
        peer = self.client_address[0]
        if peer not in ("127.0.0.1", "::1"):
            return peer
        xff = self.headers.get("X-Forwarded-For")
        if xff:
            # Caddy appends the real peer address to the RIGHT of any
            # client-sent XFF value — only the rightmost entry is
            # trustworthy, and only if it actually parses as an IP
            # (otherwise it could inject arbitrary text into this
            # structured log line).
            candidate = xff.split(",")[-1].strip()
            try:
                ipaddress.ip_address(candidate)
                return candidate
            except ValueError:
                return "invalid"
        return peer

    def _origin_allowed(self) -> bool:
        """CSRF defense-in-depth for state-changing POSTs, alongside
        SameSite=Lax cookies. Prefers Sec-Fetch-Site; falls back to
        comparing Origin's host against Host. Requests with neither header
        (curl, very old browsers) are allowed through — no cross-origin
        evidence to block."""
        sfs = self.headers.get("Sec-Fetch-Site")
        if sfs is not None:
            return sfs in ("same-origin", "none")
        origin = self.headers.get("Origin")
        if origin is not None:
            host = self.headers.get("Host", "")
            try:
                origin_host = urllib.parse.urlsplit(origin).netloc
            except ValueError:
                return False
            return bool(origin_host) and origin_host == host
        return True

    def _log_event(self, event: str, detail: str = "") -> None:
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        # Never log emails, tokens, or cookie values.
        print(f"{ts} event={event} ip={self._client_ip()} {detail}".rstrip(), flush=True)

    def _get_cookies(self) -> dict:
        raw = self.headers.get("Cookie", "")
        jar = {}
        for part in raw.split(";"):
            part = part.strip()
            if not part or "=" not in part:
                continue
            k, v = part.split("=", 1)
            jar[k.strip()] = v.strip()
        return jar

    def _valid_session(self) -> "str | None":
        cookie = self._get_cookies().get(COOKIE_NAME)
        if not cookie:
            return None
        parts = cookie.split(".")
        if len(parts) != 3:
            return None
        enc_uid, exp_s, sig = parts
        uid = urllib.parse.unquote(enc_uid)
        if not UID_RE.match(uid):
            return None
        # Session uid must still exist in the user registry — deleting an
        # account (or, in principle, editing users.json by hand) revokes
        # its live sessions on the next request. Mirrors the old auth.json-
        # rotation revocation story exactly, just against UserStore instead.
        # D-EPOCH (2026-07-31 review): this single UserStore.get() also
        # supplies the CURRENT session_epoch — sign() below is re-derived
        # against it, so a cookie signed under an epoch that's since been
        # bumped (POST /auth/revoke-sessions) fails right here, same as a
        # deleted uid, with no separate store or cookie field needed.
        # PG-14 (2026-07-31 review): validate the signature's SHAPE before it
        # reaches hmac.compare_digest. sign() always returns 64 lowercase hex
        # chars, but compare_digest raises TypeError on a non-ASCII str — so a
        # cookie carrying one killed the worker thread (502 + traceback) where
        # a plain 401 was the right answer. Checking here also short-circuits
        # ahead of the disk-backed USERS.get() below for junk cookies.
        if len(sig) != 64 or not HEX_RE.match(sig):
            return None
        rec = USERS.get(uid)
        if rec is None:
            return None
        try:
            exp = int(exp_s)
        except ValueError:
            return None
        if exp <= int(time.time()):
            return None
        expected = sign(uid, exp, int(rec.get("session_epoch", 0)))
        if not hmac.compare_digest(expected, sig):
            return None
        return uid

    def _wants_401(self, path: str) -> bool:
        """Whether an unauthenticated request should get a bare 401 instead
        of a browser-navigation-friendly 302 -> /login: JSON data fetches
        (which a page's own fetch() can't usefully follow a redirect out
        of) and anything else that looks like a fetch/XHR rather than a
        top-level navigation."""
        if path.startswith("/data/"):
            return True
        accept = self.headers.get("Accept", "")
        if "application/json" in accept:
            return True
        sfd = self.headers.get("Sec-Fetch-Dest")
        if sfd is not None and sfd not in ("document", "iframe"):
            return True
        return False

    def _drain_or_close(self) -> None:
        """MUST be called by any POST/PUT branch that is about to send a
        response WITHOUT itself having read the declared request body —
        every early-rejection path (401/403/404) below that doesn't go on
        to do its own `self.rfile.read(length)`.

        D16 fix (2026-07-31 security review, surface-2 pass): this
        connection is HTTP/1.1 and kept alive by default (protocol_version
        above); Caddy's reverse_proxy to this service has no `keepalive off`
        override (see /etc/caddy/conf.d/pinball-genie.conf), so it pools and
        REUSES backend connections across different downstream clients'
        requests — standard Go net/http.Transport behavior. If a handler
        answers a POST/PUT without reading the bytes the client already
        declared via Content-Length, those bytes are still sitting unread
        in this connection's stream, and http.server's keep-alive loop
        (BaseHTTPRequestHandler.handle) will hand them to the NEXT
        handle_one_request() call as if they were the start of the NEXT
        request's request-line/headers — reproduced locally: an
        unauthenticated PUT /api/achievements (401, body never read) or
        POST /auth/delete (401, body never read) immediately followed on
        the SAME connection by a pipelined GET /health came back corrupted
        (a bogus 400 "Bad request syntax" or 501 "Unsupported method" for
        what should have been a clean 200). Self-inflicted for a direct
        client, but on a connection Caddy is free to hand to a completely
        different downstream request next, this is exactly the shape of a
        request/response desync ("smuggling"): an attacker's leftover,
        attacker-chosen body bytes get prepended to whatever real request
        Caddy forwards next over that same reused backend socket, corrupting
        or misrouting a response that belongs to a different visitor
        entirely — not merely breaking the attacker's own connection.

        `_do_auth_request`'s existing oversized-body path already gets this
        right (it sets close_connection=True) — this helper generalizes
        that same fix to every other route that can reject a POST/PUT
        without reading its body: PUT /api/achievements (401 unauthenticated,
        403 cross-origin), POST /auth/signout, POST /auth/delete (401
        unauthenticated, 403 cross-origin), and the unmatched-path 404
        fallback in both do_POST and do_PUT.

        ALWAYS closes rather than attempting to read-then-keepalive when a
        body is declared, and deliberately never calls `self.rfile.read()`
        here — an EARLIER version of this fix tried to drain up to a small
        size cap first, to preserve keep-alive for the common case. That
        introduced a real regression, caught by this file's own existing
        CSRF regression test (t_cross_origin_achievements_put_rejected),
        which declares a `Content-Length` header without ever actually
        sending that many body bytes — a legal-enough client shape (a
        buggy proxy, a hand-built request, or an attacker doing it on
        purpose) that made the old `self.rfile.read(length)` here block for
        the full `Handler.timeout` (15s) waiting for bytes that were never
        coming, just to answer what should have been an instant rejection —
        reintroducing, on a smaller scale, exactly the kind of
        slow-body/thread-pinning risk this file already goes out of its way
        to bound elsewhere. Closing has none of that risk: it is a single
        non-blocking syscall, it is unconditionally safe regardless of how
        much (if any) of the declared body ever actually arrives, and it
        still fully closes the smuggling gap this method exists for —
        discarding a TCP connection discards whatever is left unread in its
        buffers, so no leftover attacker-controlled bytes can ever reach the
        next handle_one_request() call on it, on this process or (via
        Caddy's connection pool) on a completely different downstream
        request. The only cost is that these specific rejection responses
        no longer benefit from HTTP keep-alive — a negligible price for a
        401/403/404 on a state-changing route, not a hot path this site's
        performance depends on."""
        length_header = self.headers.get("Content-Length")
        if not length_header:
            return  # no Content-Length at all -> nothing declared, nothing to drain
        try:
            length = int(length_header)
        except ValueError:
            # Not a number this service can trust — treat it as "something
            # is there" rather than risk silently treating a malformed
            # header as an empty body.
            self.close_connection = True
            return
        if length > 0:
            self.close_connection = True
        # length <= 0 (an explicit "Content-Length: 0", or a negative junk
        # value): genuinely nothing declared to drain — closing here would
        # just be an unnecessary keep-alive cost for the common "no body"
        # case with no security benefit.

    def _read_body_bounded(self, length: int) -> "bytes | None":
        """Read exactly `length` body bytes under a TOTAL time budget
        (BODY_READ_TIMEOUT). Returns the bytes, or None if the client didn't
        deliver them in time / closed early — in which case the caller must
        answer 408 and close, never fall through to normal handling.

        PG-02 (HIGH, 2026-07-31 webapp pentest) — THE DoS THIS CLOSES.
        Both body-reading routes used to call `self.rfile.read(length)`: one
        blocking read for the whole declared length, bounded only by the 15s
        socket timeout. `POST /auth/request` does this BEFORE any rate-limit,
        CSRF, or auth check — it is the first thing an unauthenticated caller
        can reach. So one connection that declared `Content-Length: 2000` and
        then sent a SINGLE BYTE pinned a worker thread for the full 14.97s,
        measured, at a cost to the attacker of one byte.
        BoundedThreadingHTTPServer caps concurrency at 100, so ~100 such
        connections consume every slot: `process_request` then fails its
        `_slots.acquire(timeout=5)` and closes the incoming request outright.
        Reproduced end to end through Caddy 2.11.4 running the production site
        config — real visitors got **HTTP/1.1 502 Bad Gateway**, not a slow
        page. ~100 sockets and ~100 bytes took the whole site down, with no
        account and no rate limit ever consulted (the limiters are further
        down the function; the handler was already blocked above them).

        WHY A DEADLINE RATHER THAN A SMALLER Handler.timeout. Handler.timeout
        governs each individual socket operation, so lowering it neither bounds
        the total (a client dripping one byte per interval renews it forever)
        nor distinguishes the case that matters. A single wall-clock budget
        across the whole body does both, and it is the only knob that makes the
        attacker's cost scale with THEIR patience instead of our thread count.

        The read is chunked, and the socket timeout is narrowed to the
        remaining budget before each chunk, so a stalled client is cut off at
        the deadline rather than at the next 15s tick. The original timeout is
        restored in a finally — this handler may serve more requests on this
        connection if the body did arrive in time.

        On the failure path the caller closes the connection, so a partially
        consumed body is discarded with the socket. That matters: leaving
        unread bytes on a Caddy-POOLED connection is exactly the C1 smuggling
        bug (see handle_one_request), and closing is what makes this safe."""
        if length <= 0:
            return b""
        chunks: "list[bytes]" = []
        remaining = length
        deadline = time.monotonic() + BODY_READ_TIMEOUT
        try:
            original_timeout = self.connection.gettimeout()
        except OSError:
            original_timeout = self.timeout
        try:
            while remaining > 0:
                budget = deadline - time.monotonic()
                if budget <= 0:
                    return None
                try:
                    self.connection.settimeout(budget)
                    chunk = self.rfile.read(min(remaining, 65536))
                except (socket.timeout, TimeoutError, OSError, ValueError):
                    # ValueError: a BufferedReader whose underlying raw read
                    # timed out mid-chunk raises it rather than socket.timeout.
                    return None
                if not chunk:
                    return None  # client closed before delivering what it declared
                chunks.append(chunk)
                remaining -= len(chunk)
        finally:
            try:
                self.connection.settimeout(original_timeout)
            except OSError:
                pass
        return b"".join(chunks)

    def _body_timeout(self) -> None:
        """Answer a body that never fully arrived (see _read_body_bounded) and
        drop the connection. 408 is the status RFC 9110 §15.5.9 defines for
        exactly this, and closing is mandatory rather than polite: whatever the
        client did send is still unread, and leaving it on a connection Caddy
        pools across visitors is the C1 smuggling bug."""
        self._log_event("body_read_timeout")
        self.close_connection = True
        self._plain_status(408)

    def _send_bytes(self, status: int, body: bytes, content_type: str, extra_headers=None, cache: "str | None" = None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if cache is not None:
            self.send_header("Cache-Control", cache)
        for k, v in extra_headers or ():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _redirect(self, location: str, status: int = 302, extra_headers=None):
        # PG-07 (2026-07-31 webapp pentest) — NON-LATIN-1 IN A REDIRECT TARGET
        # KILLED THE HANDLER THREAD.
        #
        # `Location` is the ONE header on this server built from request-derived
        # data: _serve_machine_guide's trailing-slash canonicalisation passes
        # the PERCENT-DECODED request path here. Decoded, that path can contain
        # any Unicode at all — and CPython's send_header does
        # `("%s: %s\r\n" % (k, v)).encode('latin-1', 'strict')`, which raises
        # UnicodeEncodeError on anything above U+00FF. The exception escapes the
        # handler entirely: the worker thread dies, the client gets a bare
        # connection close with NO RESPONSE, and a full stack trace is written
        # to the service journal. One unauthenticated request does it:
        #
        #     GET /machines/%F0%9F%8E%B0/        (U+1F3B0, a slot-machine emoji)
        #
        # Reproduced against production during a SecLists content-discovery run
        # (the wordlist contained non-ASCII entries) and then locally: emoji,
        # CJK and Cyrillic all produced an empty response and a logged
        # traceback; a Latin-1-range character like "é" survived only because it
        # happens to encode. This is PRE-EXISTING — the stdlib send_header did
        # the same latin-1 encode before this file ever overrode it — and it is
        # a separate bug from PG-01, which rejected CONTROL characters in the
        # target but said nothing about characters that are merely
        # unencodable. Impact is availability + log amplification, not
        # disclosure: nothing leaks, but each request burns a worker and writes
        # ~20 lines of traceback, which is a cheap way to grow the journal.
        #
        # THE FIX IS THE CORRECT HTTP BEHAVIOUR, NOT A FILTER. Per RFC 9110
        # §10.2.2 a Location value is a URI reference, and URIs are ASCII —
        # non-ASCII must be percent-encoded (RFC 3986 §2.1). So encode it here
        # rather than rejecting the request: every caller of _redirect now emits
        # a well-formed Location by construction, including any route added
        # later, and the emoji path simply redirects to its percent-encoded form
        # and then 404s like any other unknown slug.
        #
        # `safe` keeps every character that is structurally meaningful in a URI
        # (RFC 3986 gen-delims + sub-delims + unreserved) so "/login?sent=1" and
        # "/machines/jaws" pass through byte-identical — verified by the
        # existing redirect assertions in the test suite and in deploy-prod.sh's
        # smoke gates. "%" is deliberately NOT in `safe`: this value is always
        # already-decoded, so a literal "%" in it came from a "%25" on the wire
        # and must go back out as "%25".
        safe_location = urllib.parse.quote(location, safe="/?#[]@!$&'()*+,;=~-._")
        self.send_response(status)
        self.send_header("Location", safe_location)
        self.send_header("Content-Length", "0")
        for k, v in extra_headers or ():
            self.send_header(k, v)
        self.end_headers()

    def _plain_status(self, status: int):
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send_not_found(self, url_path: str) -> None:
        """404 for a GET that missed a file — the branded page for anything a
        PERSON could plausibly be looking at, the old plain-text body for
        anything a MACHINE fetched.

        WHY THE SPLIT. A stale hashed chunk (`/assets/index-a1b2c3.js`) 404s
        constantly and by design — a browser holding an old index.html asks for
        chunk names the current build no longer has, which is exactly what
        app/tests/chunk-guard.test.mjs exists to handle — and those misses are
        answered to a `fetch()`/dynamic `import()` that will never render a byte
        of the body. Handing every one of them ~1.2 KB of HTML instead of 9
        bytes buys nothing and costs bandwidth on exactly the path that fires
        most. So the rule is the URL's own shape, decided with no I/O:

          - no extension at all (`/no-such-page`, `/machines/nope`) -> a page
          - trailing "/" or an explicit ".html"                     -> a page
          - anything else with an extension (.js/.css/.json/.png/…) -> text

        Extension is read from the LAST path segment only, so a dotted
        directory earlier in the path can't make a page-shaped URL look like an
        asset. Both branches are the same status and the same cache header;
        only the representation differs.

        POST/PUT 404s deliberately do NOT come through here — those stay
        `_plain_status(404)` with an empty body (see _handle_post's unmatched-
        path branch and D16's pipelining tests, which assert on the status line
        of a body-less response)."""
        last_segment = url_path.rsplit("/", 1)[-1]
        wants_page = url_path.endswith("/") or url_path.endswith(".html") or "." not in last_segment
        if wants_page:
            self._send_bytes(404, _NOT_FOUND_HTML, "text/html; charset=utf-8", cache="no-cache")
        else:
            self._send_bytes(404, b"not found", "text/plain; charset=utf-8", cache="no-cache")

    def _login_page(self, state: str, retry_minutes: int = 0) -> bytes:
        try:
            page = LOGIN_CACHE.read().decode("utf-8")
        except OSError:
            return b"login page unavailable"
        state_class = {"sent": STATE_SENT, "limited": STATE_LIMITED}.get(state, STATE_DEFAULT)
        page = page.replace(STATE_MARKER, state_class)
        # RETRY_MARKER is always substituted, even in the default/sent
        # states where .limited-panel stays hidden — never leave a raw
        # "%%...%%" marker in a page that actually gets served (D5).
        page = page.replace(RETRY_MARKER, str(max(1, retry_minutes)))
        return page.encode("utf-8")

    def _send_rate_limited(self, retry_after_seconds: int) -> None:
        """Renders the real login page in its "too many attempts" state
        instead of a bare Content-Length:0 429 (D5, 2026-07-30 security
        review — see the module docstring's RATE LIMITING section for the
        full incident: a blank 429 reads, to an actual visitor, as the
        site being down rather than "slow down and try again"). Sends a
        real Retry-After header too, for the well-behaved clients/proxies
        that honor it, on top of the human-readable minute count in the
        page copy itself."""
        retry_after_seconds = max(1, int(retry_after_seconds))
        retry_minutes = max(1, (retry_after_seconds + 59) // 60)
        try:
            body = self._login_page("limited", retry_minutes)
        except OSError:
            self._plain_status(429)
            return
        self._send_bytes(
            429,
            body,
            "text/html; charset=utf-8",
            extra_headers=[("Retry-After", str(retry_after_seconds))],
            cache="no-cache",
        )

    def _success_login(self, uid: str):
        exp = int(time.time()) + SESSION_MAX_AGE
        # D-EPOCH: sign against `uid`'s CURRENT session_epoch (0 for a user
        # row that predates this field) so a login issued right after a
        # revoke-sessions call gets a cookie that actually validates against
        # the just-bumped epoch, not a stale one.
        rec = USERS.get(uid)
        epoch = int(rec.get("session_epoch", 0)) if rec is not None else 0
        sig = sign(uid, exp, epoch)
        cookie_val = f"{encode_cookie_field(uid)}.{exp}.{sig}"
        secure_attr = "" if DEV_MODE else " Secure;"
        headers = [
            (
                "Set-Cookie",
                f"{COOKIE_NAME}={cookie_val}; HttpOnly;{secure_attr} SameSite=Lax; Path=/; Max-Age={SESSION_MAX_AGE}",
            ),
        ]
        self._redirect("/", extra_headers=headers)

    def _clear_session_cookie_header(self) -> tuple:
        secure_attr = "" if DEV_MODE else " Secure;"
        return ("Set-Cookie", f"{COOKIE_NAME}=; HttpOnly;{secure_attr} SameSite=Lax; Path=/; Max-Age=0")

    def _build_magic_link(self, token: str) -> str:
        # D2 fix (2026-07-30 security review): this used to be built from
        # `self.headers.get("Host")` unconditionally — a request-controlled
        # value — so `Host: evil.example` (or `Host: pinball-genie.com:1337`,
        # which Caddy's own vhost match doesn't reliably reject either) put
        # an attacker-chosen origin straight into a real, working, emailed
        # sign-in credential: a one-click account takeover of any address
        # the attacker could get to click the link in their OWN real inbox.
        # PUBLIC_ORIGIN is now the canonical source of truth outside --dev —
        # main() refuses to start without a validated absolute https origin
        # there (see validate_public_origin) — so reaching this function
        # with PUBLIC_ORIGIN unset is only possible in --dev, where a
        # Host-header fallback is an accepted, documented local-testing
        # convenience, never a production code path.
        if PUBLIC_ORIGIN:
            return f"{PUBLIC_ORIGIN}/auth/verify?token={token}"
        scheme = "http" if DEV_MODE else "https"
        host = self.headers.get("Host") or "localhost"
        return f"{scheme}://{host}/auth/verify?token={token}"

    # -- static file serving --------------------------------------------

    def _serve_cached_asset(self, cache_obj: "FileCache", mime: str) -> None:
        """Serves a small pre-cached always-public asset — a LOGIN_ASSETS or
        LEGAL_ASSETS entry — reachable with no session regardless of
        PUBLIC_MODE. 404s (rather than erroring) if the underlying file is
        missing, since legal pages may be deployed incrementally."""
        try:
            body = cache_obj.read()
        except OSError:
            self._plain_status(404)
            return
        self._send_bytes(200, body, mime, cache="no-cache")

    def _serve_static(self, base_dir: str, url_path: str, index_fallback: "str | None", cache: str):
        rel = url_path
        if index_fallback is not None and (url_path == "" or url_path == "/"):
            rel = index_fallback
        path = resolve_safe_path(base_dir, rel)
        if path is None or not os.path.isfile(path):
            self._send_not_found(url_path)
            return
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            self._send_bytes(500, b"read error", "text/plain; charset=utf-8", cache="no-cache")
            return
        self._send_bytes(200, body, guess_mime(path), cache=cache)

    def _serve_machine_guide(self, path: str) -> None:
        """GET /machines and /machines/<slug> — the Phase 4 SEO guide pages
        (2026-07-30). PUBLIC with no session in BOTH PINBALL_PUBLIC modes —
        see this method's callsite in _handle_get, which checks it BEFORE
        the PUBLIC_MODE gate, same tier as LOGIN_ASSETS/LEGAL_ASSETS just
        above it. A search crawler and an ad-network reviewer both need to
        fetch these with no cookie and no JS; the achievements tracker is
        the only thing on this site that's supposed to require an account,
        and a guide page isn't it.

        ROUTING DECISION — no FileCache map, unlike LEGAL_ASSETS: that map
        exists because server/legal/*.html lives OUTSIDE ROOT_DIR (app/dist)
        — nothing else in this file has any reason to look there, so naming
        each of its 5 files explicitly was the only way to reach them at
        all. The 62 guide pages + their index ship INSIDE ROOT_DIR itself —
        the identical webroot the SPA and /assets/* already come from — so
        resolve_safe_path against ROOT_DIR already knows how to find them;
        building a 63-entry FileCache dict here would just be reimplementing
        _serve_static's own file resolution by hand, for no benefit, and
        would need editing every time a machine is added to the catalog.
        The ONE thing actually missing for these URLs is "reachable with no
        session regardless of PUBLIC_MODE" — that's the sole reason this is
        its own method instead of just falling through to the ordinary
        catch-all static route at the bottom of _handle_get, which enforces
        the PUBLIC_MODE gate. Confirmed by actually loading a built fixture
        with no cookie in both PINBALL_PUBLIC settings, not assumed from
        "it's just a file" — see server/tests/test_magic_link_auth.py's
        Phase 4 section.

        CANONICAL FORM: no trailing slash, matching this site's existing
        /privacy /terms /about /contact convention. Each guide is generated
        as a DIRECTORY with its own index.html
        (ROOT_DIR/machines/<slug>/index.html), not a flat
        ROOT_DIR/machines/<slug>.html, so serving the clean URL means
        resolving one directory level deeper than _serve_static's own
        "/" -> index_fallback shortcut — this is that same idea applied one
        level down, not a different mechanism. A request that already
        carries a trailing slash 301s to the slash-free canonical instead of
        serving the same bytes under two URLs: duplicate, non-canonicalized
        URLs are a real SEO defect (two pages can end up splitting the same
        query's ranking signal), not a style nit — see deploy-prod.sh's
        Phase 4 smoke-test block for the check that this redirect and the
        page's own self-referencing <link rel="canonical"> agree.

        TRAVERSAL: the sub-path below is handed to resolve_safe_path exactly
        like every other static route in this file — the 62 slugs are DATA
        (from catalog.json), not code, and the URL segment naming one is
        attacker-controlled input like any other path segment, so this gets
        no special exemption from the same ../-refusing realpath check
        _serve_static already relies on. See test_magic_link_auth.py's
        Phase 4 section for both a direct resolve_safe_path unit-test proof
        and a live-server ../ + percent-encoded end-to-end proof.

        D15 fix (2026-07-31 security review, surface-2 pass): that
        traversal check used to be scoped to ROOT_DIR — correct for
        refusing an escape off the filesystem entirely (a real /etc/passwd
        attempt does still 404, and still does after this fix), but this
        route is reachable with NO session in BOTH PUBLIC_MODE settings,
        checked in _handle_get BEFORE the PUBLIC_MODE/session gate. Because
        ROOT_DIR is the SAME webroot the ordinary (session-gated, in mode 0)
        catch-all route serves everything else from, resolving against
        ROOT_DIR here let a percent-encoded "..' walk sideways OUT of
        machines/ and back INTO any other file already inside ROOT_DIR —
        e.g. GET /machines/%2e%2e/assets/app.js — and this route's own
        no-session bypass would serve it, completely defeating
        PINBALL_PUBLIC=0 gating for the entire webroot (reproduced locally:
        a gated fixture asset was served with no cookie via exactly that
        URL). Currently a no-op on the production unit specifically
        (PINBALL_PUBLIC=1 already leaves all of ROOT_DIR open, gate or no
        gate), but it silently defeats the staging unit's gating and would
        just as silently defeat gating regained via an incident-response
        rollback to PINBALL_PUBLIC=0 — the exact scenario gating exists
        for. Fix: resolve every candidate against MACHINES_ROOT
        (ROOT_DIR/machines) instead of ROOT_DIR, using only the segment
        AFTER the "/machines" prefix as the relative path — the identical
        primitive (resolve_safe_path), just with its escape boundary
        actually drawn at the subtree this route is supposed to own,
        instead of the much larger webroot it happens to live inside.
        """
        if path.endswith("/"):
            # Collapses "/machines/", "/machines/jaws/", and even a
            # pathological "/machines/jaws///" down to one canonical
            # no-trailing-slash target in a single redirect (str.rstrip
            # strips ALL trailing separators, not just one).
            canonical = path.rstrip("/")
            self._redirect(canonical if canonical else "/machines", status=301)
            return
        # D15: sub is "" for bare "/machines", else whatever follows the
        # "/machines/" prefix — resolved against MACHINES_ROOT below, never
        # against ROOT_DIR directly, so no "../" shape this segment can take
        # ever lands anywhere outside ROOT_DIR/machines.
        sub = "" if path == "/machines" else path[len("/machines/") :]
        machines_root = os.path.join(ROOT_DIR, "machines")
        # Try the literal path first so a future non-HTML asset under
        # /machines/** (a per-guide screenshot, say) needs no code change
        # here, before falling back to treating the segment as a directory
        # whose own index.html is the canonical page.
        try:
            exact = resolve_safe_path(machines_root, sub)
            if exact is not None and os.path.isfile(exact):
                with open(exact, "rb") as f:
                    body = f.read()
                self._send_bytes(200, body, guess_mime(exact), cache="no-cache")
                return
            indexed = resolve_safe_path(machines_root, os.path.join(sub, "index.html") if sub else "index.html")
            if indexed is None or not os.path.isfile(indexed):
                self._send_not_found(path)
                return
            with open(indexed, "rb") as f:
                body = f.read()
        except OSError:
            self._send_bytes(500, b"read error", "text/plain; charset=utf-8", cache="no-cache")
            return
        self._send_bytes(200, body, guess_mime(indexed), cache="no-cache")

    # -- GET / HEAD --------------------------------------------------------

    def do_GET(self):
        self._handle_get()

    def do_HEAD(self):
        # D8 fix (2026-07-30 security review): every other GET route in
        # this file is safe to also serve on HEAD as-is (_send_bytes already
        # skips writing the body for HEAD; nothing else mutates state), but
        # GET /auth/verify is a documented, deliberate exception (see the
        # module docstring's "A GET THAT CONSUMES A TOKEN" note) — and that
        # carve-out was scoped to an actual human clicking a link via GET,
        # never to HEAD. do_HEAD used to fall straight into _handle_get
        # like every other route, so it inherited the same token-consuming,
        # cookie-setting side effect. Mail/chat link-unfurlers (Slack,
        # Teams, iMessage, Outlook Safe Links) issue exactly this — a HEAD
        # to preview a link before a human ever opens the email — which is
        # precisely the mail-scanner-prefetch scenario the module docstring
        # already accepts for GET, but RFC 9110 §9.3.2 requires HEAD
        # specifically to be safe (no side effects), and there is no
        # equivalent "the unfurler's own cookie jar never reaches the real
        # user" argument to fall back on here: reproduced pre-fix, a HEAD
        # to /auth/verify returned 302 + Set-Cookie and burned the token,
        # so the user's own later GET click got 401 "already used" for a
        # link they had never actually opened yet. Answer with a static,
        # side-effect-free response and never touch TOKENS for HEAD.
        if urllib.parse.unquote(urllib.parse.urlsplit(self.path).path) == "/auth/verify":
            self._plain_status(200)
            return
        self._handle_get()

    def _handle_get(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)

        if path == "/health":
            self._send_bytes(200, b"ok", "text/plain; charset=utf-8", cache="no-cache")
            return

        # Per-user identity + achievements state (2026-07-29). Session-gated
        # even in PUBLIC_MODE — per-user state is meaningless without a user.
        if path == "/whoami":
            uid = self._valid_session()
            if not uid:
                # D6 fix (2026-07-30 security review): this used to be a
                # bare 401 — but a signed-out GET /whoami fires on EVERY
                # anonymous page load of a public SPA that checks its own
                # auth status on boot, making it (by sheer volume) almost
                # certainly the dominant source of 401s feeding the
                # fail2ban jail this service shares with GET /auth/verify
                # (see that route's own D6 fix and the module docstring) —
                # banning ordinary anonymous visitors for the page doing
                # exactly what it's supposed to. 200 + a null user is
                # indistinguishable to app/src/ui/achievements.ts's
                # `fetchWhoami()` from any other "not signed in" outcome
                # (it only ever checks for a truthy string `user` field).
                # /api/achievements just below keeps a REAL 401 — a
                # legitimate client only calls it after seeing a real uid
                # from here, so a 401 there still means something.
                self._send_bytes(200, b'{"user":null}', "application/json", cache="no-cache")
                return
            self._send_bytes(200, json.dumps({"user": uid}).encode("utf-8"),
                             "application/json", cache="no-cache")
            return

        if path == "/api/achievements":
            uid = self._valid_session()
            if not uid:
                self._plain_status(401)
                return
            fp = os.path.join(STATE_DIR, "achievements", f"{uid}.json")
            try:
                with open(fp, "rb") as f:
                    body = f.read()
            except OSError:
                body = b"{}"
            self._send_bytes(200, body, "application/json", cache="no-cache")
            return

        # Data export (Phase 5, 2026-07-30) — the privacy policy promises
        # this; session-gated in both modes like every other per-user route.
        if path == "/auth/export":
            uid = self._valid_session()
            if not uid:
                self._plain_status(401)
                return
            self._do_export(uid)
            return

        # GET /auth/verify — reachable with NO session, in BOTH modes, same
        # as /login: this IS how a session gets created. See the module
        # docstring's MAGIC-LINK SECURITY MODEL for the single-use/TTL/
        # atomic-consume story and the deliberate 401-with-friendly-body
        # status choice.
        if path == "/auth/verify":
            self._do_verify()
            return

        # Live in BOTH modes (2026-07-30) — public mode opens the SPA/data,
        # not the ability to sign in.
        if path == "/login":
            if self._valid_session():
                self._redirect("/")
                return
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            state = "sent" if q.get("sent", ["0"])[0] == "1" else "default"
            try:
                body = self._login_page(state)
            except OSError:
                self._send_bytes(500, b"login page unavailable", "text/plain; charset=utf-8")
                return
            self._send_bytes(200, body, "text/html; charset=utf-8", cache="no-cache")
            return

        if path in LOGIN_ASSETS:
            cache_obj, mime = LOGIN_ASSETS[path]
            self._serve_cached_asset(cache_obj, mime)
            return

        if path in LEGAL_ASSETS:
            cache_obj, mime = LEGAL_ASSETS[path]
            self._serve_cached_asset(cache_obj, mime)
            return

        # Phase 4 SEO guide pages (2026-07-30) — /machines and
        # /machines/<slug>, public with no session in BOTH PINBALL_PUBLIC
        # modes, same tier as LOGIN_ASSETS/LEGAL_ASSETS immediately above.
        # See _serve_machine_guide's docstring for why this needs its own
        # branch even though the files ship inside ROOT_DIR (which the
        # ordinary catch-all route below already serves, but ONLY once
        # PUBLIC_MODE or a valid session allows it).
        if path == "/machines" or path.startswith("/machines/"):
            self._serve_machine_guide(path)
            return

        if path.startswith("/data/"):
            if not PUBLIC_MODE and not self._valid_session():
                self._plain_status(401)
                return
            self._serve_static(DATA_DIR, path[len("/data/") :], index_fallback=None, cache="no-cache")
            return

        # Everything else: serve from ROOT_DIR (session-gated only when
        # PUBLIC_MODE is off).
        if not PUBLIC_MODE and not self._valid_session():
            if self._wants_401(path):
                self._plain_status(401)
            else:
                self._redirect("/login")
            return
        cache = "public, max-age=31536000, immutable" if path.startswith("/assets/") else "no-cache"
        self._serve_static(ROOT_DIR, path, index_fallback="index.html", cache=cache)

    def _do_export(self, uid: str):
        user = USERS.get(uid)
        if user is None:
            # The session cookie's signature+expiry still checked out, but
            # the user row is gone (e.g. deleted from another tab/device
            # within the same 30-day cookie lifetime) — _valid_session()
            # already re-checks USERS.get(uid) itself (D-EPOCH, 2026-07-31:
            # that same lookup also supplies the session_epoch the
            # signature is verified against) so this should be unreachable
            # in practice; kept as a defensive belt, same posture as the old
            # auth.json-rotation check.
            self._plain_status(401)
            return
        achievements: dict = {}
        fp = os.path.join(STATE_DIR, "achievements", f"{uid}.json")
        try:
            with open(fp, "r", encoding="utf-8") as f:
                achievements = json.load(f)
        except (OSError, json.JSONDecodeError):
            achievements = {}
        doc = {
            "user_id": uid,
            "email": user["email"],
            "created_at": user["created_at"],
            "last_login_at": user["last_login_at"],
            "achievements": achievements,
        }
        body = json.dumps(doc, indent=2).encode("utf-8")
        self._send_bytes(
            200,
            body,
            "application/json",
            extra_headers=[("Content-Disposition", 'attachment; filename="pinball-genie-data-export.json"')],
            cache="no-cache",
        )

    def _do_verify(self):
        ip = self._client_ip()
        if RATE_LIMITER.is_blocked(ip):
            self._log_event("verify_rate_limited")
            self._send_rate_limited(RATE_LIMITER.retry_after(ip))
            return
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        token = q.get("token", [""])[0]
        # 256 is a generous cap (real tokens are ~55 chars: 9+32 bytes of
        # token_urlsafe plus the "." separator, base64url-expanded) — this
        # just bounds the work TokenStore.consume() does on garbage input
        # before RATE_LIMITER even sees it as a failure.
        if not token or len(token) > 256:
            RATE_LIMITER.record_failure(ip)
            self._log_event("verify_fail", "reason=malformed")
            self._send_bytes(401, _verify_error_page("invalid"), "text/html; charset=utf-8", cache="no-cache")
            return
        # PG-06: read the row WITHOUT spending it, so the same-browser check
        # below can fall back to a confirmation page that still has a live
        # token to offer. TOKENS.consume() further down is still the only
        # thing that flips `used`.
        status, email, nonce_hash = TOKENS.peek(token)
        if status == "ok":
            presented = self._get_cookies().get(LINK_NONCE_COOKIE, "")
            matched = bool(nonce_hash) and bool(presented) and hmac.compare_digest(
                _hash_link_nonce(presented), nonce_hash
            )
            if not matched:
                # A different browser than the one that requested the link.
                # Do NOT mint a session; ask, naming the address. Neither
                # record_failure nor record_success: this is not evidence of
                # abuse (it is the ordinary request-on-phone/open-on-laptop
                # case) and it must not feed the fail2ban counter, same
                # reasoning as the 410 branch below.
                self._log_event("verify_confirm_required")
                self._send_bytes(200, _verify_confirm_page(email, token),
                                 "text/html; charset=utf-8", cache="no-cache")
                return
        status, email = TOKENS.consume(token)
        if status in ("expired", "used"):
            # D6 fix (2026-07-30 security review): this used to be a plain
            # 401, same as a genuinely malformed/tampered token — but an
            # expired or already-used link is exactly what a completely
            # ordinary, non-hostile user produces every time they click a
            # stale link out of an old email, or re-open/double-click a
            # link they already used once. The fail2ban jail this service
            # feeds bans an IP on 12x401/10min off Caddy's access log (see
            # the module docstring), so routing routine inbox behavior
            # through 401 fed real users into that ban counter (reproduced
            # 2026-07-30). 410 Gone is both the semantically correct status
            # ("this resource existed and is now permanently gone") and,
            # critically, NOT one of the statuses the jail watches. Neither
            # RATE_LIMITER.record_failure nor record_success is called here
            # on purpose: this isn't evidence of abuse, so it shouldn't feed
            # (or clear) that counter either.
            self._log_event("verify_fail", f"reason={status}")
            self._send_bytes(410, _verify_error_page(status), "text/html; charset=utf-8", cache="no-cache")
            return
        if status != "ok":
            # Still a genuine 401 + fail2ban signal: "invalid" covers a
            # malformed token, an unknown selector, or a tampered verifier —
            # all real evidence of probing, unlike the routine cases above.
            RATE_LIMITER.record_failure(ip)
            self._log_event("verify_fail", f"reason={status}")
            self._send_bytes(401, _verify_error_page(status), "text/html; charset=utf-8", cache="no-cache")
            return
        # D7 fix (2026-07-30 security review): the permanent user row is
        # created HERE — at the moment inbox control is actually proven —
        # never at POST /auth/request time. See the module docstring's
        # "DEFERRED ACCOUNT CREATION" section and find_or_create()'s own
        # comment. find_or_create() is idempotent, so a returning user (or
        # a second still-live token for the same not-yet-registered
        # address) just attaches to the existing/newly-made uid either way.
        uid, _created = USERS.find_or_create(email)
        USERS.touch_login(uid)
        RATE_LIMITER.record_success(ip)
        self._log_event("verify_ok")
        self._success_login(uid)

    # -- POST ----------------------------------------------------------------

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/auth/request":
            self._do_auth_request()
            return
        if path == "/auth/signout":
            self._do_signout()
            return
        if path == "/auth/delete":
            self._do_delete_account()
            return
        if path == "/auth/revoke-sessions":
            self._do_revoke_sessions()
            return
        if path == "/auth/verify":
            # PG-06: the confirm button on _verify_confirm_page. Only reachable
            # for a click that arrived without the requesting browser's nonce.
            self._do_verify_confirm()
            return
        if path == "/auth/code":
            self._do_verify_code()
            return
        # D16 fix (2026-07-31 security review): unmatched POST paths never
        # read whatever body a caller declared via Content-Length — see
        # _drain_or_close's docstring for why that leftover body corrupts
        # the next request on this same (Caddy-pooled) persistent
        # connection if left unread.
        self._drain_or_close()
        self._plain_status(404)

    def do_PUT(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/achievements":
            self._put_achievements()
            return
        self._drain_or_close()  # D16 fix — see do_POST's identical comment
        self._plain_status(404)

    def _put_achievements(self):
        """Replace the signed-in user's achievements blob (2026-07-29).
        Whole-document PUT: the client owns merge semantics; the server just
        validates it's a JSON object of sane size and writes atomically to
        STATE_DIR/achievements/<uid>.json. Per-user by construction — the
        filename comes from the session, never from the request."""
        uid = self._valid_session()
        if not uid:
            # D16 fix (2026-07-31 security review): this used to reject
            # before ever reading the body the caller declared via
            # Content-Length — see _drain_or_close's docstring for why an
            # unread body corrupts the next request on this same
            # (Caddy-pooled) persistent connection.
            self._drain_or_close()
            self._plain_status(401)
            return
        # Same cross-site defense as the auth routes: state-changing route.
        if not self._origin_allowed():
            self._drain_or_close()  # D16 fix — same reasoning as above
            self._log_event("achievements_put_blocked", "reason=cross-origin")
            self._plain_status(403)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = ACHIEVEMENTS_MAX_BODY + 1
        if length <= 0 or length > ACHIEVEMENTS_MAX_BODY:
            # D16 fix: reject without ever attempting to read a body this
            # size (up to 128KB declared, possibly more) — _drain_or_close
            # just closes the connection rather than reading, so this never
            # blocks regardless of how large `length` claims to be.
            self._drain_or_close()
            self._plain_status(413)
            return
        body = self._read_body_bounded(length)  # PG-02: bounded, never a blind blocking read
        self._body_read = True  # C1: body consumed, so the connection is safe to reuse
        if body is None:
            self._body_timeout()
            return
        try:
            doc = json.loads(body.decode("utf-8"))
        except (ValueError, RecursionError):
            # D14 fix (2026-07-31 security review, surface-2 pass): a body
            # well within ACHIEVEMENTS_MAX_BODY (128KB) can still be
            # thousands of levels of nested arrays/objects deep (e.g.
            # "[[[...]]]" x 20,000, ~40KB) — json.loads's recursive-descent
            # parser blows Python's call stack on that shape and raises
            # RecursionError, a RuntimeError subclass that the
            # JSONDecodeError-only except above never caught. Reproduced:
            # an authenticated PUT with such a body killed the handler
            # thread with an uncaught traceback and NO response at all
            # (bare connection close, not even a clean 400) — see
            # BoundedThreadingHTTPServer's docstring for why the thread
            # pool itself isn't exhausted by this (the semaphore is
            # released in a finally regardless), but a client hammering
            # this shape still gets a raw disconnect every time instead of
            # a normal error, and every attempt spams a full local stack
            # trace into the service log. No file write ever happens before
            # this point, so this never left partial/corrupted state on
            # disk — the fix is purely to answer with a clean 400 like any
            # other malformed body, same as the sibling exceptions here.
            #
            # PG-09 (2026-07-31 adversarial review): widened from
            # (UnicodeDecodeError, json.JSONDecodeError, RecursionError) to
            # (ValueError, RecursionError). Both of the dropped names ARE
            # ValueError subclasses, so this strictly widens — and it picks up
            # the case that was escaping: a JSON integer literal with more than
            # 4300 digits raises a BARE ValueError ("Exceeds the limit (4300
            # digits) for integer string conversion"), which is not a
            # JSONDecodeError, so it killed the worker thread with no response.
            self._plain_status(400)
            return
        if not isinstance(doc, dict):
            self._plain_status(400)
            return
        # PG-09: bound nesting BEFORE anything is written. See
        # ACHIEVEMENTS_MAX_DEPTH for the export amplification (302x measured)
        # and the uncaught-RecursionError-on-export this prevents.
        if json_depth_exceeds(doc, ACHIEVEMENTS_MAX_DEPTH):
            self._log_event("achievements_put_rejected", "reason=too-deep")
            self._plain_status(400)
            return
        # PG-04 (2026-07-31 webapp pentest) — CONCURRENT WRITES CORRUPTED THE
        # USER'S OWN DATA.
        #
        # This used to write to a FIXED scratch path, `.{uid}.json.tmp`. The
        # os.replace at the end is atomic and was never the problem; the
        # problem is that every concurrent writer for the same uid opened the
        # SAME temp file. Two PUTs in flight together interleave into one fd:
        # the shorter document lands, the longer one keeps writing past its
        # end, and os.replace then publishes the splice. Reproduced on the
        # FIRST attempt of a 25-round test: a 47,601-byte blob consisting of
        # writer B's complete document followed by writer A's tail, which
        # json.loads rejects with "Extra data: line 1 column 1362", plus a 500
        # from the writer whose temp file had been replaced out from under it.
        # GET /api/achievements then serves those bytes forever and the
        # client's JSON.parse throws — the achievements tab is broken for that
        # user until something overwrites it.
        #
        # NO ATTACKER IS REQUIRED. This is two devices, or two tabs, syncing at
        # once — ordinary use of a PWA whose whole point is that it follows you
        # to the arcade. That makes it a data-integrity bug first and a
        # security finding second, which is why it is fixed rather than
        # documented as acceptable.
        #
        # THE FIX IS TWO PARTS, and both are needed:
        #   1. tempfile.mkstemp gives each write its own private scratch file
        #      in the destination directory (same filesystem, so os.replace
        #      stays atomic). Writers can no longer share an fd at all.
        #   2. A per-uid lock serializes the read-modify-publish sequence, so
        #      last-writer-wins publishes a WHOLE document. Without it,
        #      mkstemp alone would still let two complete documents race into
        #      os.replace — harmless for integrity (each file is valid JSON)
        #      but it makes "which one won" depend on scheduler timing rather
        #      than on request order.
        # The leading "." is kept in the prefix so a scratch file that somehow
        # outlives a crash stays hidden and is obviously not a uid blob.
        target_dir = os.path.join(STATE_DIR, "achievements")
        final = os.path.join(target_dir, f"{uid}.json")
        tmp = None
        try:
            # Serialisation is inside the try (PG-09): with the depth cap above
            # this should not be able to raise, but a serialiser error must be
            # a clean 500 rather than an uncaught exception that kills the
            # worker and returns nothing at all.
            payload = json.dumps(doc, separators=(",", ":")).encode("utf-8")
            os.makedirs(target_dir, exist_ok=True)
            with _achievements_lock(uid):
                fd, tmp = tempfile.mkstemp(prefix=f".{uid}.", suffix=".json.tmp", dir=target_dir)
                with os.fdopen(fd, "wb") as f:
                    f.write(payload)
                # mkstemp creates 0600; make that explicit and permanent rather
                # than inherited, matching UserStore/TokenStore's D12 posture
                # for the other files under STATE_DIR.
                os.chmod(tmp, 0o600)
                os.replace(tmp, final)
                tmp = None  # replaced, nothing left to clean up
        except (OSError, ValueError, RecursionError):
            self._log_event("achievements_put_failed", "reason=io-or-serialize")
            self._plain_status(500)
            return
        finally:
            if tmp is not None:
                # Write or replace failed partway — never leave scratch behind.
                try:
                    os.remove(tmp)
                except OSError:
                    pass
        self._log_event("achievements_put_ok")
        self._plain_status(204)

    def _do_auth_request(self):
        """POST /auth/request {email} -> ALWAYS the same neutral 302 to
        /login?sent=1. See the module docstring's ENUMERATION and RATE
        LIMITING sections for the full reasoning; this function is the
        implementation of both."""
        length_header = self.headers.get("Content-Length")
        try:
            length = int(length_header) if length_header is not None else 0
        except ValueError:
            length = MAGIC_REQUEST_MAX_BODY + 1

        if length > MAGIC_REQUEST_MAX_BODY:
            self._plain_status(413)
            self.close_connection = True
            return

        # PG-02: this is the FIRST thing an unauthenticated caller reaches, and
        # it used to be an unbounded blocking read — see _read_body_bounded's
        # docstring for the 502-Bad-Gateway outage that made possible.
        body = self._read_body_bounded(length)
        self._body_read = True  # C1: body consumed, so the connection is safe to reuse
        if body is None:
            self._body_timeout()
            return
        ip = self._client_ip()

        # Failure-tracking limiter first, cheapest check, catches an IP
        # already flagged for cross-origin probing or bad verify tokens.
        if RATE_LIMITER.is_blocked(ip):
            self._log_event("auth_request_rate_limited", "reason=prior-abuse")
            self._send_rate_limited(RATE_LIMITER.retry_after(ip))
            return

        # CSRF: rejecting here happens BEFORE any email is even parsed, so
        # it cannot leak registration status — it only ever reflects
        # "this POST didn't look same-origin". 401 (not 403, unlike
        # /api/achievements's PUT) to preserve the fail2ban signal the old
        # POST /auth's cross-origin handling gave this same class of abuse.
        if not self._origin_allowed():
            RATE_LIMITER.record_failure(ip)
            self._log_event("auth_request_fail", "reason=cross-origin-blocked")
            self._plain_status(401)
            return

        try:
            fields = urllib.parse.parse_qs(body.decode("utf-8", errors="replace"), keep_blank_values=True)
        except Exception:
            fields = {}
        raw_email = fields.get("email", [""])[0]
        email = normalize_email(raw_email)

        # Per-IP, per-subnet, and global caps apply regardless of whether
        # `email` turned out to be well-formed — all three are keyed on
        # request volume, not on any property of the address, so checking
        # them here doesn't create an asymmetry between malformed and
        # well-formed input either. Per-subnet sits between per-IP and
        # global (D5, 2026-07-30 review — see REQUEST_LIMIT_PER_SUBNET_MAX's
        # comment and subnet_key()).
        if not REQUEST_LIMIT_IP.allow(ip):
            self._log_event("auth_request_rate_limited", "reason=per-ip")
            self._send_rate_limited(REQUEST_LIMIT_IP.retry_after(ip))
            return
        subnet = subnet_key(ip)
        if not REQUEST_LIMIT_SUBNET.allow(subnet):
            self._log_event("auth_request_rate_limited", "reason=subnet")
            self._send_rate_limited(REQUEST_LIMIT_SUBNET.retry_after(subnet))
            return
        if not REQUEST_LIMIT_GLOBAL.allow(_GLOBAL_KEY):
            # NEW-3 fix (2026-07-30, second review pass). The global bucket
            # alone was a site-wide sign-in kill switch: the re-verification
            # reproduced total lockout with 9 IPs spread over 3 /24s sending
            # 60 requests in seconds, because PER_SUBNET_MAX(24) x 3 subnets
            # already exceeds GLOBAL_MAX(60), and 3 IPs per subnet stays under
            # PER_IP_MAX(8). Every later visitor — from any network — then got
            # a blank-walled 429 with Retry-After: 3600.
            #
            # So the global cap no longer gets the last word. A subnet that has
            # barely used the service keeps a small private reserve that the
            # shared pool cannot consume. An attacker can still exhaust the
            # shared pool (that pool is what protects the send quota), but they
            # cannot reach into a stranger's reserve, because the reserve is
            # keyed by THEIR subnet, not by the global bucket. Flooding from N
            # subnets costs the attacker N subnets and still leaves every
            # untouched subnet able to sign in.
            #
            # This deliberately trades a little quota headroom for
            # availability: in the worst case, reserve traffic adds up to
            # RESERVE_MAX per distinct attempting subnet per window on top of
            # the global ceiling. At this site's scale that is a rounding
            # error, and the failure it prevents (nobody can sign in) is far
            # worse than the one it risks (a few sends over the intended
            # hourly shape, still bounded, and Resend simply rejects past its
            # own quota). Revisit if real traffic ever makes the reserve the
            # dominant term — the log line below is how you would notice.
            if REQUEST_LIMIT_RESERVE.allow(subnet):
                self._log_event("auth_request_global_reserve", "reason=global-exhausted-reserve-used")
            else:
                self._log_event("auth_request_rate_limited", "reason=global")
                self._send_rate_limited(
                    min(
                        REQUEST_LIMIT_GLOBAL.retry_after(_GLOBAL_KEY),
                        REQUEST_LIMIT_RESERVE.retry_after(subnet) or REQUEST_LIMIT_GLOBAL.retry_after(_GLOBAL_KEY),
                    )
                )
                return

        # PG-06: minted BEFORE the well-formed/malformed branch below and
        # attached to the response on EVERY path out of this function, so the
        # cookie's presence can never differ between a known address, an
        # unknown one, and junk — that asymmetry would be exactly the
        # enumeration leak the neutral 302 exists to prevent.
        link_nonce = secrets.token_urlsafe(16)

        # PG-11: the hard daily ceiling. Deliberately checked AFTER the
        # global/reserve branch above, so the reserve — which exists to keep a
        # quiet subnet able to sign in during a flood — cannot tunnel under the
        # quota it is supposed to be spending from. Nothing overrides this.
        if not REQUEST_LIMIT_DAILY.allow(_GLOBAL_KEY):
            self._log_event("auth_request_rate_limited", "reason=daily-budget")
            self._send_rate_limited(REQUEST_LIMIT_DAILY.retry_after(_GLOBAL_KEY))
            return

        if email is not None:
            # D5 fix (2026-07-30 review): keyed on (requester IP, email),
            # not email alone — see the module docstring's RATE LIMITING
            # section for why a bare-email key let anyone who merely knew
            # an address lock its real owner out without ever touching
            # their inbox.
            email_key = f"{ip}:{email}"
            if not REQUEST_LIMIT_EMAIL.allow(email_key):
                self._log_event("auth_request_rate_limited", "reason=per-email")
                self._send_rate_limited(REQUEST_LIMIT_EMAIL.retry_after(email_key))
                return
            try:
                # D7 fix (2026-07-30 security review): NO UserStore work of
                # any kind happens on this path anymore. TOKENS.issue()
                # below is the only disk write, for a known and an unknown
                # address alike — see the module docstring's "DEFERRED
                # ACCOUNT CREATION" section. Before this fix,
                # USERS.find_or_create(email) ran right here, minting a
                # permanent account row for anyone who merely typed a
                # syntactically-plausible address, whether or not they
                # ever proved they could read that inbox (reproduced: 55
                # rows, zero of which had ever clicked a link). The real
                # row is only ever created once a token issued here is
                # actually consumed — see _do_verify.
                token, code = TOKENS.issue(email, _hash_link_nonce(link_nonce))
                link = self._build_magic_link(token)
                SENDER.send(email, link, code)
                self._log_event("auth_request_ok")
            except Exception as e:  # noqa: BLE001 - see the comment below
                # PG-11: the neutral response below is still the right answer
                # for the CALLER, but silence toward the OPERATOR is what made
                # a dead Resend quota invisible — every user keeps seeing
                # "check your inbox" forever. Count consecutive failures and
                # escalate the log line so this is greppable/alertable.
                # A mail-provider hiccup or a disk error must NEVER surface
                # as anything other than the same neutral response below —
                # a differently-shaped failure response here IS the leak
                # the ENUMERATION note warns about (it would tell an
                # attacker "something server-side touched this address").
                # The real failure is still fully visible server-side via
                # this log line.
                with _SEND_FAILURE_LOCK:
                    _SEND_FAILURES[0] += 1
                    streak = _SEND_FAILURES[0]
                self._log_event("auth_request_error", f"reason={type(e).__name__} consecutive={streak}")
                if streak in (1, 5) or streak % 25 == 0:
                    print(
                        f"ALERT: magic-link send has failed {streak} time(s) in a row "
                        f"({type(e).__name__}). Sign-in is silently broken for every user — "
                        "check the Resend quota/key.",
                        file=sys.stderr, flush=True,
                    )
            else:
                with _SEND_FAILURE_LOCK:
                    _SEND_FAILURES[0] = 0
        else:
            self._log_event("auth_request_ok", "malformed_email=1")

        # PG-06: same neutral 302 as always, now carrying the binding cookie.
        secure_attr = "" if DEV_MODE else " Secure;"
        self._redirect(
            "/login?sent=1",
            extra_headers=[(
                "Set-Cookie",
                f"{LINK_NONCE_COOKIE}={link_nonce}; HttpOnly;{secure_attr} "
                f"SameSite=Lax; Path=/; Max-Age={MAGIC_TOKEN_TTL}",
            )],
        )

    def _do_verify_confirm(self):
        """POST /auth/verify — spend a token the user explicitly confirmed on
        _verify_confirm_page (PG-06). This is the cross-device half of the
        magic-link flow; the same-browser half never reaches here.

        SAME-ORIGIN IS THE CONTROL THAT MATTERS. The attacker in the login-CSRF
        scenario already holds a valid token — it is theirs. What they must not
        be able to do is spend it INTO A VICTIM'S BROWSER without the victim
        agreeing, and the two things that stop that are (a) the GET no longer
        mints a session at all when the nonce is absent, and (b) this POST
        refuses a cross-origin submission, so a hostile page cannot auto-submit
        the form on the victim's behalf. Without (b) the confirmation page
        would be decorative.

        Everything after the origin check is deliberately identical to
        _do_verify's success path — same consume(), same find_or_create(),
        same touch_login(), same _success_login() — so there is exactly one
        way a session is ever minted from a token, not two that can drift."""
        ip = self._client_ip()
        if RATE_LIMITER.is_blocked(ip):
            self._drain_or_close()
            self._log_event("verify_rate_limited")
            self._send_rate_limited(RATE_LIMITER.retry_after(ip))
            return
        if not self._origin_allowed():
            self._drain_or_close()
            RATE_LIMITER.record_failure(ip)
            self._log_event("verify_confirm_blocked", "reason=cross-origin")
            self._plain_status(403)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = MAGIC_REQUEST_MAX_BODY + 1
        if length <= 0 or length > MAGIC_REQUEST_MAX_BODY:
            self._drain_or_close()
            self._plain_status(413)
            return
        body = self._read_body_bounded(length)  # PG-02
        self._body_read = True
        if body is None:
            self._body_timeout()
            return
        try:
            fields = urllib.parse.parse_qs(body.decode("utf-8", errors="replace"), keep_blank_values=True)
        except Exception:  # noqa: BLE001
            fields = {}
        token = fields.get("token", [""])[0]
        if not token or len(token) > 256:
            RATE_LIMITER.record_failure(ip)
            self._log_event("verify_fail", "reason=malformed-confirm")
            self._send_bytes(401, _verify_error_page("invalid"), "text/html; charset=utf-8", cache="no-cache")
            return
        status, email = TOKENS.consume(token)
        if status in ("expired", "used"):
            # Same 410-not-401 reasoning as _do_verify: routine, not abuse.
            self._log_event("verify_fail", f"reason={status}")
            self._send_bytes(410, _verify_error_page(status), "text/html; charset=utf-8", cache="no-cache")
            return
        if status != "ok":
            RATE_LIMITER.record_failure(ip)
            self._log_event("verify_fail", f"reason={status}")
            self._send_bytes(401, _verify_error_page(status), "text/html; charset=utf-8", cache="no-cache")
            return
        uid, _created = USERS.find_or_create(email)
        USERS.touch_login(uid)
        RATE_LIMITER.record_success(ip)
        self._log_event("verify_ok", "confirmed=1")
        self._success_login(uid)

    def _do_verify_code(self):
        """POST /auth/code {email, code} — redeem an emailed sign-in code
        (PG-18).

        WHY THIS EXISTS: on iOS an installed PWA has its own cookie jar and
        Mail opens links in Safari, so a magic link physically cannot deliver a
        session into the installed app. A code the user types into whichever
        app they are standing in is the only thing that crosses that boundary.

        Guards are deliberately the SAME shape as the link path, because this
        is the same credential in another form: same failure limiter (so five
        wrong codes from an IP stops it), same CSRF origin check, same bounded
        body read, same single-use consumption through the same token row —
        redeem the code and its link dies with it.

        Response shape mirrors _do_verify's: a real 302 + session cookie on
        success, and the same friendly 401/410 pages on failure, so the two
        entry points are indistinguishable to a caller."""
        ip = self._client_ip()
        if RATE_LIMITER.is_blocked(ip):
            self._drain_or_close()
            self._log_event("code_rate_limited")
            self._send_rate_limited(RATE_LIMITER.retry_after(ip))
            return
        if not self._origin_allowed():
            self._drain_or_close()
            RATE_LIMITER.record_failure(ip)
            self._log_event("code_fail", "reason=cross-origin")
            self._plain_status(401)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = MAGIC_REQUEST_MAX_BODY + 1
        if length <= 0 or length > MAGIC_REQUEST_MAX_BODY:
            self._drain_or_close()
            self._plain_status(413)
            return
        body = self._read_body_bounded(length)  # PG-02
        self._body_read = True
        if body is None:
            self._body_timeout()
            return
        try:
            fields = urllib.parse.parse_qs(body.decode("utf-8", errors="replace"), keep_blank_values=True)
        except Exception:  # noqa: BLE001
            fields = {}
        email = normalize_email(fields.get("email", [""])[0])
        raw_code = fields.get("code", [""])[0]
        if email is None or not raw_code or len(raw_code) > 64:
            RATE_LIMITER.record_failure(ip)
            self._log_event("code_fail", "reason=malformed")
            self._send_bytes(401, _verify_error_page("invalid"), "text/html; charset=utf-8", cache="no-cache")
            return
        status = TOKENS.consume_code(email, raw_code)
        if status in ("expired", "used"):
            # Same 410-not-401 reasoning as _do_verify: routine, not abuse, and
            # deliberately not fed to the fail2ban counter.
            self._log_event("code_fail", f"reason={status}")
            self._send_bytes(410, _verify_error_page(status), "text/html; charset=utf-8", cache="no-cache")
            return
        if status != "ok":
            RATE_LIMITER.record_failure(ip)
            self._log_event("code_fail", "reason=invalid")
            self._send_bytes(401, _verify_error_page("invalid"), "text/html; charset=utf-8", cache="no-cache")
            return
        uid, _created = USERS.find_or_create(email)
        USERS.touch_login(uid)
        RATE_LIMITER.record_success(ip)
        self._log_event("verify_ok", "via=code")
        self._success_login(uid)

    def _do_signout(self):
        """POST /auth/signout — end this device's session, keep the account.

        Added 2026-07-30 to close NEW-1 from the Phase 5 re-verification: the
        client shipped a Sign out button (ui/account.ts) whose copy promises
        the shared-computer case ("Ends your session on this device — useful
        on a shared or public computer"), and this route did not exist, so the
        button 404'd and left the user signed in. A control that claims to
        protect a shared computer and silently does nothing is worse than no
        control, because the user stops looking for another way out. The
        client half was built against this exact path in the same pass; the
        server half was simply missed between two parallel agents.

        Deliberately mirrors _do_delete_account's guards rather than being
        laxer: session required (nothing to sign out otherwise) and
        same-origin required, so a hostile page cannot force-sign-out a
        visitor as a nuisance. Sessions are stateless signed cookies, so
        "sign out" is exactly "expire the cookie" — there is no server-side
        session row to revoke, and any copy of the cookie captured earlier
        would still validate until it expires. That is the same property the
        30-day cookie already had; it is why the account page's copy talks
        about *this device* rather than promising global revocation.

        D-EPOCH UPDATE (2026-07-31, surface-1 review): "delete the account"
        used to be the ONLY answer to "I think a session cookie leaked" —
        destroying the achievements blob along with every session, which is
        a disproportionate cost for a threat that has nothing to do with the
        DATA being wrong, only with WHO can present a cookie. POST
        /auth/revoke-sessions (see _do_revoke_sessions below) is the
        proportionate answer: it bumps the account's session_epoch, which
        invalidates every outstanding cookie for this uid — this device,
        every other device, and any copy an attacker captured — while
        leaving the account and its data untouched. This route is
        deliberately left as-is (this-device-only) rather than folded into
        revoke-everywhere, because the two are different guarantees a user
        might want separately (a shared-computer sign-out vs. "I think I've
        been compromised, kill every session").

        204 rather than 200+body: the client only needs to know it worked,
        and there is nothing meaningful to return.
        """
        # D16 fix (2026-07-31 security review): this route never reads a
        # request body on ANY of its outcomes below — a caller that sends
        # one anyway (nothing requires it not to) would leave it unread on
        # this persistent connection. See _drain_or_close's docstring for
        # why that corrupts the next request Caddy forwards over the same
        # pooled backend connection.
        self._drain_or_close()
        uid = self._valid_session()
        if not uid:
            # Already signed out. Idempotent by design — a double-tap, or a
            # click after the cookie already expired, must not look like an
            # error to the user. Still clear the cookie so a malformed or
            # stale one cannot linger.
            self._send_bytes(
                204, b"", "application/json",
                extra_headers=[self._clear_session_cookie_header()], cache="no-cache",
            )
            return
        if not self._origin_allowed():
            self._log_event("signout_blocked", "reason=cross-origin")
            self._plain_status(403)
            return
        self._log_event("signout_ok")
        self._send_bytes(
            204, b"", "application/json",
            extra_headers=[self._clear_session_cookie_header()], cache="no-cache",
        )

    def _do_delete_account(self):
        """POST /auth/delete — session-gated account deletion. Removes the
        user row, the email index entry, any live magic tokens for this
        uid, and the achievements blob; clears the session cookie. The
        privacy policy promises this exists and actually deletes."""
        # D16 fix (2026-07-31 security review): same reasoning as
        # _do_signout's identical call — this route never reads a request
        # body on any outcome below, so a caller-declared body would
        # otherwise sit unread on this persistent, Caddy-pooled connection.
        self._drain_or_close()
        uid = self._valid_session()
        if not uid:
            self._plain_status(401)
            return
        if not self._origin_allowed():
            self._log_event("account_delete_blocked", "reason=cross-origin")
            self._plain_status(403)
            return
        email = USERS.delete(uid)
        if email is not None:
            TOKENS.delete_for_email(email)
        # Best-effort: the achievements blob too. uids are never recycled
        # (secrets.token_urlsafe draws from a huge space), so a leftover
        # file here would be permanently orphaned rather than merely stale
        # — harmless in isolation, but "delete actually deletes" is the
        # literal spec, so remove it rather than leave a technically-inert
        # but semantically wrong artifact on disk.
        fp = os.path.join(STATE_DIR, "achievements", f"{uid}.json")
        try:
            os.remove(fp)
        except OSError:
            pass
        self._log_event("account_delete_ok")
        headers = [self._clear_session_cookie_header()]
        self._send_bytes(200, b'{"deleted":true}', "application/json", extra_headers=headers, cache="no-cache")

    def _do_revoke_sessions(self):
        """POST /auth/revoke-sessions — invalidate EVERY outstanding session
        for this account (this device, every other device, and any copy an
        attacker captured earlier) without touching the account or its
        achievements data. Added 2026-07-31 (surface-1 security review) to
        close the gap the 2026-07-30 review explicitly identified and
        deferred (see _do_signout's docstring and D9/NEW-1's own history):
        sessions are stateless signed cookies with no server-side row, so
        the ONLY prior way to invalidate a leaked cookie was full account
        deletion — a disproportionate response when the actual problem is
        "someone else might have my cookie", not "my data is wrong".

        MECHANISM: UserStore.bump_epoch(uid) increments the account's
        session_epoch. Every cookie was signed against the epoch that was
        current at issue time (see sign()/_success_login/_valid_session) —
        bumping it makes every one of those signatures stop matching on the
        very next request, on every device, with nothing to distribute and
        nothing for a client to poll. This INCLUDES the cookie on the very
        request making this call, so the response also clears it and the
        caller is expected to sign in again via a fresh magic link — same
        shape as "sign out of all devices" in any session-cookie-based
        product (Google, GitHub, etc.), applied here without needing a
        server-side session table.

        GUARDS mirror _do_delete_account/_do_signout exactly: a session is
        required (nothing to revoke otherwise, and an unauthenticated caller
        learns nothing either way — same 401 whether the cookie is missing,
        expired, tampered, or names a uid that no longer exists), and
        same-origin is required so a hostile page can't force a visitor to
        revoke their own sessions as a nuisance (a lower-stakes but still
        real annoyance than force-delete, so it gets the same defense).
        """
        self._drain_or_close()  # D16-pattern: this route never reads a body.
        uid = self._valid_session()
        if not uid:
            self._plain_status(401)
            return
        if not self._origin_allowed():
            self._log_event("revoke_sessions_blocked", "reason=cross-origin")
            self._plain_status(403)
            return
        new_epoch = USERS.bump_epoch(uid)
        if new_epoch is None:
            # The session's signature/expiry checked out but the user row is
            # gone by the time we got here (e.g. a race with a concurrent
            # /auth/delete on another tab) — nothing left to revoke sessions
            # FOR. Same defensive-belt posture as _do_export's identical
            # check; _valid_session already makes this practically
            # unreachable.
            self._plain_status(401)
            return
        # PG-15 (2026-07-31 review): bumping the epoch invalidates every COOKIE,
        # but an unused magic link is a bearer credential too — leaving those
        # live meant "revoke all sessions" was undone the moment someone
        # clicked a link that was already in an inbox (or already captured).
        # _do_delete_account has always purged them; this path must too, or the
        # control does not mean what its name says.
        rec = USERS.get(uid)
        if rec is not None:
            TOKENS.delete_for_email(rec["email"])
        self._log_event("revoke_sessions_ok")
        headers = [self._clear_session_cookie_header()]
        self._send_bytes(200, b'{"revoked":true}', "application/json", extra_headers=headers, cache="no-cache")


class BoundedThreadingHTTPServer(http.server.ThreadingHTTPServer):
    """ThreadingHTTPServer with a hard cap on concurrently-processed
    connections, so an attacker holding open many slow/idle connections
    (each pinned by Handler.timeout) still can't grow threads — and
    therefore memory — without bound."""

    def __init__(self, *args, max_concurrent: int = 100, **kwargs):
        super().__init__(*args, **kwargs)
        self._slots = threading.Semaphore(max_concurrent)

    def process_request(self, request, client_address):
        if not self._slots.acquire(timeout=5):
            try:
                request.close()
            except OSError:
                pass
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------


def parse_args(argv: "list[str]") -> argparse.Namespace:
    env_root = os.environ.get("PINBALL_ROOT")
    parser = argparse.ArgumentParser(description="pinball-auth server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--root", default=env_root, help="static app build dir (app/dist)")
    parser.add_argument(
        "--data",
        default=os.path.join(env_root, "data") if env_root else None,
        help="goal-dataset JSON directory",
    )
    parser.add_argument(
        "--state-dir",
        default=os.environ.get("PINBALL_STATE_DIR", "/var/lib/pinball-auth"),
        help="writable per-user state dir (achievements, users, tokens); systemd StateDirectory",
    )
    parser.add_argument("--dev", action="store_true", help="ephemeral secret; drop cookie Secure flag")
    args = parser.parse_args(argv)
    if not args.root:
        parser.error("--root is required (or set PINBALL_ROOT)")
    if not args.data:
        parser.error("--data is required (or set PINBALL_ROOT)")
    return args


def main(argv: "list[str] | None" = None) -> None:
    global SECRET, DEV_MODE, PUBLIC_ORIGIN, ROOT_DIR, DATA_DIR, STATE_DIR, USERS, TOKENS, SENDER
    global LOGIN_CACHE, LOGIN_ASSETS, LEGAL_ASSETS, RATE_LIMITER
    global REQUEST_LIMIT_IP, REQUEST_LIMIT_SUBNET, REQUEST_LIMIT_EMAIL, REQUEST_LIMIT_GLOBAL, REQUEST_LIMIT_RESERVE
    global REQUEST_LIMIT_DAILY

    args = parse_args(sys.argv[1:] if argv is None else argv)
    DEV_MODE = args.dev
    ROOT_DIR = os.path.abspath(args.root)
    DATA_DIR = os.path.abspath(args.data)
    STATE_DIR = os.path.abspath(args.state_dir)
    # Best-effort: under systemd, StateDirectory already exists with the right
    # owner; locally/--dev this creates it. PUT re-tries makedirs anyway.
    try:
        os.makedirs(os.path.join(STATE_DIR, "achievements"), exist_ok=True)
    except OSError:
        pass

    if not os.path.isdir(ROOT_DIR):
        print(f"FATAL: --root {ROOT_DIR} is not a directory (build the app first)", file=sys.stderr)
        sys.exit(1)
    if not os.path.isdir(DATA_DIR):
        print(f"FATAL: --data {DATA_DIR} is not a directory", file=sys.stderr)
        sys.exit(1)

    if DEV_MODE:
        SECRET = secrets.token_hex(32)
        print("dev mode: ephemeral session secret generated (sessions won't survive a restart)", file=sys.stderr)
    else:
        secret_path = os.environ.get("PINBALL_AUTH_SECRET_FILE", "/etc/pinball-auth/secret")
        SECRET = load_secret(secret_path)

    # D2 fix (2026-07-30 security review): validate the canonical public
    # origin used to build every emailed magic-link URL — see
    # _build_magic_link and the module docstring's Config section. Required
    # outside --dev; a bad or missing value is a loud FATAL at boot, same
    # posture as a corrupt state file or a bad session secret, rather than a
    # silent fallback to request-controlled data (the exact bug being fixed:
    # the old fallback WAS the request's own Host header, unconditionally).
    raw_origin = os.environ.get("PINBALL_PUBLIC_ORIGIN", "")
    if raw_origin:
        PUBLIC_ORIGIN = validate_public_origin(raw_origin) or ""
        if not PUBLIC_ORIGIN:
            print(
                f"FATAL: PINBALL_PUBLIC_ORIGIN={raw_origin!r} is not a valid absolute "
                "https origin (e.g. https://pinball-genie.com) — no path, query, "
                "fragment, or userinfo",
                file=sys.stderr,
            )
            sys.exit(1)
    elif not DEV_MODE:
        print(
            "FATAL: PINBALL_PUBLIC_ORIGIN is required outside --dev (e.g. "
            "https://pinball-genie.com). See D2 in the 2026-07-30 security "
            "review: falling back to the request's own Host header let an "
            "attacker choose the domain in an emailed sign-in link.",
            file=sys.stderr,
        )
        sys.exit(1)
    else:
        print(
            "dev mode: no PINBALL_PUBLIC_ORIGIN set — magic links will be built "
            "from the request's own Host header (fine for local testing ONLY; "
            "the production unit is required to set this — see main()).",
            file=sys.stderr,
        )

    # Account registry + live magic-link tokens (Phase 5, 2026-07-30) — both
    # under STATE_DIR, the one writable path the hardened systemd unit
    # allows. preload() validates each store's shape now, so a corrupt file
    # is a loud FATAL at boot rather than a confusing 500 on the first
    # request (same posture the old AuthStore took toward auth.json).
    USERS = UserStore(os.path.join(STATE_DIR, "users.json"))
    TOKENS = TokenStore(os.path.join(STATE_DIR, "magic_tokens.json"))
    try:
        USERS.preload()
        TOKENS.preload()
    except RuntimeError as e:
        print(f"FATAL: {e}", file=sys.stderr)
        sys.exit(1)

    # PG-17: hourly, time-driven token retention. Daemon thread so it can never
    # hold the process open, and every iteration is wrapped so a transient disk
    # error can only skip one sweep — a retention chore must never be able to
    # take the service down.
    def _token_sweeper() -> None:
        while True:
            time.sleep(TOKEN_SWEEP_INTERVAL)
            try:
                TOKENS.sweep()
            except Exception as e:  # noqa: BLE001 - see the comment above
                print(f"WARNING: token retention sweep failed: {type(e).__name__}: {e}",
                      file=sys.stderr, flush=True)

    threading.Thread(target=_token_sweeper, name="token-sweeper", daemon=True).start()

    # Email sender (Phase 5): Resend if a key is on disk, DevLogSender (with
    # a startup warning, not a crash) otherwise — see mail_sender.py.
    # STATE_DIR is passed through so DevLogSender has somewhere to write its
    # 0600 dev_magic_links.jsonl file (D4 — see that class's docstring).
    resend_key_path = os.environ.get("PINBALL_RESEND_KEY_FILE", "/etc/pinball-auth/resend_key")
    SENDER = mail_sender.build_sender(resend_key_path, STATE_DIR)

    login_path = os.environ.get("PINBALL_AUTH_LOGIN", os.path.join(ROOT_DIR, "login.html"))
    LOGIN_CACHE = FileCache(login_path)
    try:
        LOGIN_CACHE.read()
    except OSError as e:
        print(f"FATAL: cannot read login page at {login_path}: {e}", file=sys.stderr)
        sys.exit(1)

    login_dir = os.path.dirname(login_path)
    LOGIN_ASSETS = {
        "/login.css": (FileCache(os.path.join(login_dir, "login.css")), "text/css; charset=utf-8"),
        "/login.js": (FileCache(os.path.join(login_dir, "login.js")), "text/javascript; charset=utf-8"),
    }
    for asset_path, (asset_cache, _) in LOGIN_ASSETS.items():
        try:
            asset_cache.read()
        except OSError as e:
            print(f"FATAL: cannot read login asset {asset_path} at {asset_cache.path}: {e}", file=sys.stderr)
            sys.exit(1)

    # Legal/marketing pages (2026-07-30): <root>/legal/{privacy,terms,about,
    # contact}.html + their shared legal.css, mirroring the LOGIN_ASSETS
    # layout convention (files sit alongside the served app, not the
    # script). Unlike LOGIN_ASSETS these are NOT required to exist at
    # startup — they can be deployed incrementally, and a missing one just
    # 404s per-request (see Handler._serve_cached_asset) instead of blocking
    # the whole service from starting.
    legal_dir = os.path.join(ROOT_DIR, "legal")
    LEGAL_ASSETS = {
        "/legal/legal.css": (FileCache(os.path.join(legal_dir, "legal.css")), "text/css; charset=utf-8"),
        "/privacy": (FileCache(os.path.join(legal_dir, "privacy.html")), "text/html; charset=utf-8"),
        "/terms": (FileCache(os.path.join(legal_dir, "terms.html")), "text/html; charset=utf-8"),
        "/about": (FileCache(os.path.join(legal_dir, "about.html")), "text/html; charset=utf-8"),
        "/contact": (FileCache(os.path.join(legal_dir, "contact.html")), "text/html; charset=utf-8"),
    }

    RATE_LIMITER = RateLimiter(RATE_LIMIT_MAX_FAILS, RATE_LIMIT_WINDOW)
    REQUEST_LIMIT_IP = SlidingWindowLimiter(REQUEST_LIMIT_PER_IP_MAX, REQUEST_LIMIT_PER_IP_WINDOW)
    REQUEST_LIMIT_SUBNET = SlidingWindowLimiter(REQUEST_LIMIT_PER_SUBNET_MAX, REQUEST_LIMIT_PER_SUBNET_WINDOW)
    REQUEST_LIMIT_EMAIL = SlidingWindowLimiter(REQUEST_LIMIT_PER_EMAIL_MAX, REQUEST_LIMIT_PER_EMAIL_WINDOW)
    REQUEST_LIMIT_GLOBAL = SlidingWindowLimiter(REQUEST_LIMIT_GLOBAL_MAX, REQUEST_LIMIT_GLOBAL_WINDOW)
    REQUEST_LIMIT_RESERVE = SlidingWindowLimiter(REQUEST_LIMIT_RESERVE_MAX, REQUEST_LIMIT_RESERVE_WINDOW)
    REQUEST_LIMIT_DAILY = SlidingWindowLimiter(REQUEST_LIMIT_DAILY_MAX, REQUEST_LIMIT_DAILY_WINDOW)
    print(f"daily magic-link send budget: {REQUEST_LIMIT_DAILY_MAX}/day "
          f"(~{REQUEST_LIMIT_DAILY_MAX * 30:,}/month; override with PINBALL_DAILY_SEND_MAX)", file=sys.stderr)

    server = BoundedThreadingHTTPServer((BIND_HOST, args.port), Handler)
    print(f"pinball-auth listening on {BIND_HOST}:{args.port} (root={ROOT_DIR}, data={DATA_DIR})", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

#!/usr/bin/env bash
# Deploy Pinball Genie Web to PRODUCTION — https://pinball-genie.com
#
# This is the Pinball Genie LLC business host: its OWN DigitalOcean droplet
# (`pinball-genie`, created 2026-07-29), separate from the shared `vegas-app`
# box so a public, ad-funded site never shares a kernel/filesystem with rolo's
# personal projects (Forge health data, Vegas group app).
#
# Differences from deploy.sh (which still targets the nip.io STAGING host on
# the shared droplet — keep both):
#   - own droplet + own SSH key (~/.ssh/your-deploy-key)
#   - Caddy config lives in /etc/caddy/conf.d/pinball-genie.conf and is written
#     as a WHOLE FILE (idempotent). The staging box uses a grep-gated append to
#     a single monolithic Caddyfile, which is why a Vegas redeploy once silently
#     deleted the pinball site (2026-07-21). conf.d makes that impossible.
#   - the systemd unit gets MemoryMax/MemoryHigh (absent on the staging box,
#     which has no swap and can OOM-kill Caddy instead of the offender)
#   - apex + www vhosts, www 301s to the apex (one canonical origin)
#
# Auth model (2026-07-30): the SPA + /data/*.json are PUBLIC on this unit
# (systemd drop-in sets PINBALL_PUBLIC=1 — see step (g)) — anyone can load
# the app and browse the catalog with no account. /login, POST
# /auth/request, and GET /auth/verify stay live and enforced regardless, so
# the achievements tracker is still sign-in-only — but Phase 5 (2026-07-30)
# retired the old fixed 6-user/password model (server/auth.json) entirely:
# sign-in is now real self-serve registration via a passwordless magic-link
# emailed through Resend (server/mail_sender.py) — see pinball_auth.py's
# module docstring for the full security model. /whoami, /api/achievements,
# GET /auth/export, and POST /auth/delete are session-gated no matter what.
# The legal pages (server/legal/) are real, JS-free URLs (/privacy /terms
# /about /contact) for crawlers and ad-network review. See _Business/RUNBOOK.md.
#
# Written but NOT run automatically — review, then run by hand.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DROPLET="${PG_DROPLET:?set PG_DROPLET to your droplet IP}"
KEY="${PG_KEY:-$HOME/.ssh/your-deploy-key}"
SITE_HOST="${PG_SITE_HOST:-pinball-genie.com}"
URL="https://${SITE_HOST}/"
AUTH_PORT=9310

ssh_do() { ssh -i "$KEY" -o BatchMode=yes root@"$DROPLET" "$@"; }
scp_do() { scp -i "$KEY" -o BatchMode=yes "$1" root@"$DROPLET":"$2"; }
scp_do_r() { scp -i "$KEY" -o BatchMode=yes -r "$1" root@"$DROPLET":"$2"; }

# --- (0) preflight -----------------------------------------------------
# server/auth.json is GONE from this list (Phase 5, 2026-07-30) — passwords
# are retired, so there is no credential file to preflight or upload.
# server/mail_sender.py is NEW — it's pinball_auth.py's sibling module (a
# plain `import mail_sender`, resolved via the script's own directory on
# sys.path[0]), so it must land next to pinball_auth.py on the droplet too
# (see step (d)) or the service fails to start.
for f in server/pinball_auth.py server/mail_sender.py server/login.html server/login.css server/login.js \
         server/pinball-auth.service \
         server/legal/legal.css server/legal/privacy.html server/legal/terms.html \
         server/legal/about.html server/legal/contact.html \
         app/public/robots.txt app/public/sitemap.xml; do
  [ -f "$HERE/$f" ] || { echo "FATAL: $HERE/$f missing"; exit 1; }
done
# Sourcemaps must be off (2026-07-30) — see vite.config.ts's comment. Caught
# here, before a 25-minute build, rather than by the post-deploy webroot check.
grep -q 'sourcemap: false' "$HERE/app/vite.config.ts" \
  || { echo "FATAL: app/vite.config.ts must set 'sourcemap: false' — public builds must not publish TypeScript source"; exit 1; }
[ -d "$HERE/data" ] || { echo "FATAL: $HERE/data missing"; exit 1; }
[ -f "$KEY" ] || { echo "FATAL: SSH key $KEY missing"; exit 1; }

echo "→ (0z) preflight: Resend key present on the droplet (D1, 2026-07-30 review)"
# mail_sender.build_sender() is written to swallow a missing/empty key file
# and quietly fall back to DevLogSender so the SITE never goes down for want
# of a Resend account (see that module's docstring) — but that same leniency
# used to mean a PRODUCTION deploy with no key installed sailed through every
# check below anyway: /login is 200 either way, POST /auth/request is the
# same neutral 302 either way, and nothing in this script ever asked the
# droplet whether an email could actually be sent. Green tick, silently dead
# sign-in flow. Gate on it explicitly, here, before the ~25-minute build (h/t
# the sourcemap check above for that ordering), so a missing key fails loudly
# and immediately instead of shipping a study tool nobody can sign into.
# Existence + non-emptiness ONLY — this must never read, echo, or log the key
# itself, so `[ -s ... ]` (remote, over the same BatchMode SSH as everything
# else) is the whole check.
# Distinguish "the key is missing" from "I could not reach the droplet".
# 2026-07-31: this was `ssh_do '[ -s ... ]' || FATAL`, which treats EVERY
# non-zero exit as a missing key — including an ssh that never connected. A
# transient network blip then aborted a deploy with a confident, wrong message
# telling the operator to go reinstall a key that was sitting right there with
# correct ownership. A check that reports the wrong cause is worse than no
# check: it sends you to fix the thing that isn't broken. So: have the REMOTE
# side print a sentinel, and treat "no sentinel at all" as a connectivity
# failure rather than a verdict about the key.
key_probe="$(ssh_do 'if [ -s /etc/pinball-auth/resend_key ]; then echo PG_KEY_OK; else echo PG_KEY_MISSING; fi' 2>/dev/null || true)"
case "$key_probe" in
  *PG_KEY_OK*)
    echo "  resend_key present on droplet (existence/size only — contents never read)" ;;
  *PG_KEY_MISSING*)
    echo "FATAL: /etc/pinball-auth/resend_key is missing or empty on $DROPLET — a production deploy would silently run on DevLogSender (magic links only ever reach the service's own log, never a real inbox). Place the key per _Business/RESEND-SETUP.md Step 6, then re-run. (Key contents are never checked or printed by this script.)"
    exit 1 ;;
  *)
    echo "FATAL: could not reach $DROPLET over SSH to check the Resend key (no answer from the remote probe). This is a CONNECTIVITY failure, not a verdict about the key — do NOT go reinstalling it. Check the network/droplet and re-run:"
    echo "         ssh -i $KEY root@$DROPLET 'echo ok'"
    exit 1 ;;
esac

echo "→ (a0) typecheck + tests (both gate everything below)"
# `vite build` TRANSPILES, it does not typecheck — esbuild strips the types and
# never checks them — and until this step existed nothing in this script ran
# `tsc` or the suites in app/tests/ at all. A type error or a red suite could
# not stop a deploy; the first thing that noticed was production. Both run HERE,
# ahead of the ~25-minute build, for the same reason the sourcemap and Resend
# checks above do: fail in seconds rather than after the expensive part.
# `set -e` is active, so a non-zero exit from either aborts the deploy — that is
# the point. Each runs in its own subshell so no `cd` leaks into the steps below.
# devDependencies are REQUIRED for this gate (tsc, and tesseract/opencv which the
# UNIMPORT dead files still typecheck against) — never install with --omit=dev.
( cd "$HERE/app" && npm run typecheck )
echo "  tsc --noEmit: clean"
( cd "$HERE/app" && npm test )

echo "→ (a) building the app locally"
( cd "$HERE/app" && npm run build )
[ -f "$HERE/app/dist/index.html" ] || { echo "FATAL: build produced no app/dist/index.html"; exit 1; }

echo "→ (a1) verifying Phase 4 guide pages landed in app/dist/machines/"
# Phase 4's per-machine SEO guide pages + their index are generated INTO
# app/dist/machines/** by a separate build step (not this script's concern —
# see app/scripts/) that is supposed to run as part of `npm run build`
# above. Step (b1) below uploads app/dist/* wholesale with a plain
# `scp -r`, so if that generation step silently didn't run (wrong npm
# script wiring, an exception swallowed upstream, catalog.json edited
# without regenerating), (b1) would upload a perfectly normal-looking dist/
# with no /machines/ in it at all — a build that "succeeds" and a deploy
# that "succeeds" while the entire point of Phase 4 quietly never shipped.
# Checked HERE, right after the ~25-minute build (matching the sourcemap
# check above), rather than discovered by (i)'s smoke test after Caddy has
# already been reloaded onto whatever webroot got uploaded.
[ -f "$HERE/app/dist/machines/index.html" ] || { echo "FATAL: app/dist/machines/index.html is missing after the build — the Phase 4 guide-page generator did not run as part of \`npm run build\`. This script does not invoke it separately; check app/package.json's build script / app/scripts/ wiring rather than assuming (b1)'s scp -r covers pages that were never generated."; exit 1; }
expected_machines="$(python3 -c "import json; print(len(json.load(open('$HERE/data/catalog.json'))))")"
actual_machines="$(find "$HERE/app/dist/machines" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
[ "$actual_machines" = "$expected_machines" ] || { echo "FATAL: app/dist/machines/ has $actual_machines machine directories but data/catalog.json lists $expected_machines — guide generation is incomplete, stale, or catalog.json changed without regenerating"; exit 1; }
echo "  app/dist/machines/: index.html + $actual_machines machine directories (matches catalog.json's $expected_machines)"

echo "→ (b) pruning stale build output on the droplet"
# `scp -r` COPIES, it never PRUNES. Vite names every chunk with a content hash,
# so each deploy adds new files and leaves the previous deploy's behind forever.
# That is not merely untidy now that the site is public — it silently kept
# serving artifacts we thought we had removed:
#
#   * 2026-07-30: `sourcemap: false` in vite.config.ts stopped NEW .map files
#     being built, but four .map files from the 03:58 deploy (~320 KB of
#     original TypeScript, incl. ui/adslot.ts's whole invalid-traffic design)
#     stayed in the webroot and stayed publicly fetchable. Removing them
#     locally did nothing.
#   * The same deploy removed app/public/vendor/ (15 MB of dead Tesseract OCR
#     assets, referenced by nothing since the AR removal) — and 16 MB of it
#     was still sitting in the public webroot afterwards.
#
# `assets/` is wholly reproduced by dist/assets on every build, so deleting it
# first is safe and makes the upload authoritative. data/, legal/ and the
# login.* files are uploaded by their own steps below and are NOT touched here.
ssh_do 'set -euo pipefail
  mkdir -p /var/www/pinballgenie/data
  rm -rf /var/www/pinballgenie/assets
  rm -rf /var/www/pinballgenie/vendor
  find /var/www/pinballgenie -maxdepth 2 -name "*.map" -delete
  echo "  pruned assets/, vendor/, and any stray *.map"'

echo "→ (b1) uploading app/dist/* + login assets → droplet:/var/www/pinballgenie/"
scp_do_r "$HERE/app/dist/." /var/www/pinballgenie/
scp -i "$KEY" -o BatchMode=yes "$HERE/server/login.html" "$HERE/server/login.css" \
    "$HERE/server/login.js" root@"$DROPLET":/var/www/pinballgenie/

echo "→ (b2) uploading legal pages → droplet:/var/www/pinballgenie/legal/"
# pinball_auth.py serves these from <root>/legal/ regardless of session or
# PUBLIC_MODE (LEGAL_ASSETS map) — see that script's docstring.
ssh_do 'mkdir -p /var/www/pinballgenie/legal'
scp_do_r "$HERE/server/legal/." /var/www/pinballgenie/legal/

# PG-12 (2026-07-31 review): data/ is simultaneously the published dataset AND
# a place people drop build inputs, and step (c) below uploads data/*.json
# WHOLESALE into a directory the server serves to the public with no session.
# That is how `secrets-pass.json` — a research working file — ended up live at
# https://pinball-genie.com/data/secrets-pass.json. Allowlist what may be
# published, and fail the deploy on anything unexpected rather than shipping it.
unexpected_data=""
for f in "$HERE"/data/*.json; do
  b="$(basename "$f")"
  case "$b" in
    # library.json (P6, 2026-08-14) — the Machine Library's build-time browse
    # index, generated by app/scripts/gen-library.mjs as part of `npm run
    # build`'s prebuild chain.
    #
    # EXACT FILENAME, not a glob. `library*.json` or `lib*.json` would widen
    # this gate to anything anyone drops in data/ with a matching prefix, which
    # is the precise failure PG-12 exists to prevent (secrets-pass.json reached
    # production that way). The one glob here is the pre-existing `*_goals.json`
    # dataset family. Deny-by-default is intact: the NEXT new data file still
    # FATALs until somebody names it here on purpose.
    #
    # TRUST-THE-ARTIFACT, DELIBERATE: this step verifies only that the FILE is
    # meant to be published, never its contents. What keeps prose out of
    # library.json is gen-library.mjs's own generation-time validation — the
    # per-level LIBRARY_SHAPE key gate and the PROVENANCE_TERMS scan over the
    # serialized bytes, both of which refuse to WRITE a bad file — plus
    # app/tests/gen-library.test.mjs, which fails the (a0) gate above if the
    # committed file has drifted from what the generator produces. Re-parsing
    # and re-validating JSON here in shell would be a second, weaker copy of a
    # check that already ran, in the language least suited to it.
    catalog.json|glossary.json|guides.json|library.json|*_goals.json) ;;
    *) unexpected_data="$unexpected_data $b" ;;
  esac
done
if [ -n "$unexpected_data" ]; then
  echo "FATAL: data/ holds file(s) that are NOT part of the published dataset:$unexpected_data"
  echo "       data/ is served publicly and uploaded wholesale — a build input left here gets published."
  echo "       Move authoring sources to app/scripts/sources/ (see merge-extra-goals.py) and re-run."
  exit 1
fi

# Dotfiles must never reach the webroot either — an internal note shipped as
# /.vendor-removed.md this way (app/public/ is copied verbatim by Vite).
if compgen -G "$HERE/app/dist/.*" > /dev/null 2>&1; then
  for f in "$HERE"/app/dist/.*; do
    b="$(basename "$f")"
    [ "$b" = "." ] || [ "$b" = ".." ] && continue
    echo "FATAL: app/dist/$b is a dotfile in the published webroot — move it out of app/public/"
    exit 1
  done
fi

echo "→ (c) uploading data/*.json → droplet:/var/www/pinballgenie/data/"
scp -i "$KEY" -o BatchMode=yes "$HERE/data/"*.json root@"$DROPLET":/var/www/pinballgenie/data/

echo "→ (d) uploading pinball_auth.py + mail_sender.py → droplet:/opt/pinball-auth/"
ssh_do 'mkdir -p /opt/pinball-auth'
scp_do "$HERE/server/pinball_auth.py" /opt/pinball-auth/pinball_auth.py
scp_do "$HERE/server/mail_sender.py" /opt/pinball-auth/mail_sender.py

# (e) — auth.json upload REMOVED (Phase 5, 2026-07-30). Passwords are retired;
# there is no credential file to ship. The Resend API key that replaces it
# (/etc/pinball-auth/resend_key) is deliberately NEVER uploaded by this
# script — it went onto the droplet once, by hand, over a direct SSH pipe
# per `_Business/RESEND-SETUP.md` Step 6, specifically so the plaintext key
# never touches a local file, shell history, this repo, or a deploy log.
# UPDATE (2026-07-30): rolo's Resend account and the `send.pinball-genie.com`
# sending domain are now live and verified (see RESEND-SETUP.md's summary
# table) and the key IS installed at /etc/pinball-auth/resend_key — so as of
# this deploy the service runs ResendSender for real, not DevLogSender. That
# is no longer optional: preflight step (0z) above now FAILS the deploy if
# this file is missing or empty, precisely so a future key rotation or a
# fat-fingered `rm` on the droplet can't silently regress production back to
# logging live sign-in links instead of emailing them. If the key ever needs
# replacing: revoke + reissue in the Resend dashboard, then repeat the same
# manual `scp`/pipe step — never add an upload path for it here.

echo "→ (f) system user, session secret, permissions"
ssh_do bash -s <<'REMOTE'
set -euo pipefail
id -u pinball-auth >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin pinball-auth
if [ ! -s /etc/pinball-auth/secret ]; then
  ( umask 077; python3 -c "import secrets;print(secrets.token_hex(32))" > /etc/pinball-auth/secret )
  echo "  generated new /etc/pinball-auth/secret"
fi
chown -R root:pinball-auth /etc/pinball-auth
chmod 750 /etc/pinball-auth
chmod 640 /etc/pinball-auth/secret
# Preflight step (0z) already proved this file exists and is non-empty before
# we ever got here; the `if` below is just defensive (belt over that belt —
# cheap insurance against the file vanishing in the seconds between an SSH
# round trip and this one) rather than something this step depends on.
if [ -f /etc/pinball-auth/resend_key ]; then
  chown root:pinball-auth /etc/pinball-auth/resend_key
  chmod 640 /etc/pinball-auth/resend_key
fi
# D15 (2026-07-30 adversarial review, ACCESS.md): Phase 5 retired the
# password model entirely, but no deploy ever removed the OLD credential
# file this script used to upload — auth.json (PBKDF2-SHA256 hashes, 600k
# iterations, for the 6 retired demo accounts) was still sitting on disk at
# /etc/pinball-auth/auth.json, unread by pinball_auth.py but not gone. A
# hash the service never opens again is still password-derived material at
# rest, which is exactly what "passwords are retired" is supposed to mean.
# `rm -f` is idempotent — a no-op once this has run the first time.
rm -f /etc/pinball-auth/auth.json
# The Python service (User=pinball-auth) is the ONLY reader of the webroot —
# Caddy reverse-proxies to it and never touches these files.
chown -R pinball-auth:pinball-auth /var/www/pinballgenie
find /var/www/pinballgenie -type d -exec chmod 750 {} \;
find /var/www/pinballgenie -type f -exec chmod 640 {} \;
REMOTE

echo "→ (g) systemd unit (+ memory caps, public mode) and loopback health checks"
# Take the repo's hardened unit and add memory ceilings + PINBALL_PUBLIC=1.
# Both live in drop-ins, NOT in server/pinball-auth.service itself, so the
# shared unit file deploy.sh installs on the staging box is untouched and
# stays fully gated (PINBALL_PUBLIC unset -> "0" default there).
ssh_do 'mkdir -p /etc/systemd/system/pinball-auth.service.d'
scp_do "$HERE/server/pinball-auth.service" /etc/systemd/system/pinball-auth.service
ssh_do bash -s <<'REMOTE'
set -euo pipefail
cat > /etc/systemd/system/pinball-auth.service.d/10-memory.conf <<'CONF'
# Memory ceilings (production only). The shared staging box has none, which on
# a no-swap host means the kernel OOM-killer may pick Caddy instead of the
# service that actually misbehaved.
[Service]
MemoryHigh=192M
MemoryMax=256M
CONF
cat > /etc/systemd/system/pinball-auth.service.d/20-public.conf <<'CONF'
# Public launch (2026-07-30, production only): the SPA + /data/*.json need no
# session. /login, POST /auth/request, GET /auth/verify, /whoami, and
# /api/achievements are UNCHANGED by this flag — see pinball_auth.py's
# docstring ACCESS section.
[Service]
Environment=PINBALL_PUBLIC=1
CONF
systemctl daemon-reload
if systemctl is-active --quiet pinball-auth; then systemctl restart pinball-auth; else systemctl enable --now pinball-auth; fi
sleep 2
fail=0
code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9310/health)"
[ "$code" = "200" ] || { echo "FATAL: loopback /health = $code (want 200)"; fail=1; }
echo "  loopback /health: $code"
rcode="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9310/)"
[ "$rcode" = "200" ] || { echo "FATAL: loopback unauth / = $rcode (want 200 — PUBLIC_MODE not active?)"; fail=1; }
echo "  loopback unauth /: $rcode"
lcode="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9310/login)"
[ "$lcode" = "200" ] || { echo "FATAL: loopback /login = $lcode (want 200)"; fail=1; }
echo "  loopback /login: $lcode"
# Phase 5 (2026-07-30): there is no username/password to smoke-test anymore.
# POST /auth/request ALWAYS returns the same neutral 302 (see
# pinball_auth.py's ENUMERATION note).
#
# D11 (2026-07-30 adversarial review): this used to smoke-test with
# smoke-test@example.com on the theory that RFC 2606 reserves example.com so
# nothing real is ever hit. But normalize_email()/EMAIL_RE don't know or care
# about RFC 2606 — that address is syntactically valid, so it used to run the
# FULL path: USERS.find_or_create() (a permanent row in users.json, every
# deploy, forever), REQUEST_LIMIT_EMAIL's per-email counter (reproducibly
# ABORTED the 4th deploy inside 15 minutes with a 429 here), and — now that
# ResendSender is actually selected (see step (0z)) — SENDER.send() to an
# address whose domain has no MX, i.e. a guaranteed hard bounce charged
# against send.pinball-genie.com's own sender reputation, the exact thing
# that dedicated subdomain exists to protect (see mail_sender.py's docstring).
# A DELIBERATELY MALFORMED address (no "@") fails normalize_email() before
# any of that: _do_auth_request()'s `else` branch just logs and 302s, with no
# find_or_create, no TOKENS.issue, no SENDER.send, and no per-email
# rate-limiter key ever touched. Same assertion, zero side effects, every run.
rcode="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:9310/auth/request -d 'email=deploy-smoketest-malformed')"
[ "$rcode" = "302" ] || { echo "FATAL: loopback POST /auth/request = $rcode (want 302 — neutral response)"; fail=1; }
echo "  loopback POST /auth/request: $rcode"
vcode="$(curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:9310/auth/verify?token=bogus-selector.bogus-verifier')"
[ "$vcode" = "401" ] || { echo "FATAL: loopback bogus /auth/verify = $vcode (want 401 — fail2ban jail depends on this)"; fail=1; }
echo "  loopback bogus /auth/verify: $vcode"
acode="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9310/api/achievements)"
[ "$acode" = "401" ] || { echo "FATAL: loopback unauth /api/achievements = $acode (want 401 — must stay gated in public mode)"; fail=1; }
echo "  loopback unauth /api/achievements: $acode"
# All four legal routes + the shared stylesheet, not just /privacy. These are
# served from individual files via the LEGAL_ASSETS map, so a single missing or
# mis-uploaded file 404s ON ITS OWN, silently, by design (the map 404s rather
# than erroring so pages can be deployed incrementally). Checking only one of
# them would let the other three ship broken — and they are the pages an ad
# network's reviewer and every crawler are pointed at.
for lp in privacy terms about contact legal/legal.css; do
  lpcode="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:9310/${lp}")"
  [ "$lpcode" = "200" ] || { echo "FATAL: loopback /${lp} = $lpcode (want 200)"; fail=1; }
  echo "  loopback /${lp}: $lpcode"
done
# Phase 4 SEO guide pages (2026-07-30): public with no session in BOTH
# PINBALL_PUBLIC modes (see pinball_auth.py's Handler._serve_machine_guide) —
# this loopback block only ever runs against THIS unit's actual config
# (PINBALL_PUBLIC=1, step g above), so it can only prove the public-mode
# half; the PINBALL_PUBLIC=0 half is proven by
# server/tests/test_magic_link_auth.py's Phase 4 section against a
# dedicated fixture server, not here.
mcode="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9310/machines)"
[ "$mcode" = "200" ] || { echo "FATAL: loopback /machines = $mcode (want 200)"; fail=1; }
echo "  loopback /machines: $mcode"
for slug in jaws godzilla; do
  gcode="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:9310/machines/${slug}")"
  [ "$gcode" = "200" ] || { echo "FATAL: loopback /machines/${slug} = $gcode (want 200)"; fail=1; }
  echo "  loopback /machines/${slug}: $gcode"
done
# robots.txt and sitemap.xml ship from app/public/ (Vite copies public/ into
# dist/ verbatim). Both MUST be reachable: robots.txt carries the Sitemap:
# line and the explicit "never block Mediapartners-Google" rule, and a 404
# sitemap is a Search Console error rather than a silent no-op.
for sf in robots.txt sitemap.xml; do
  sfcode="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:9310/${sf}")"
  [ "$sfcode" = "200" ] || { echo "FATAL: loopback /${sf} = $sfcode (want 200)"; fail=1; }
  echo "  loopback /${sf}: $sfcode"
done
# Regression guard (2026-07-30): sourcemaps must never ship again. While the app
# was login-gated they were a harmless debugging aid; public mode turned them
# into ~84KB of published TypeScript incl. the ad-guard design. vite.config.ts
# sets sourcemap:false — this proves it stayed false.
if ls /var/www/pinballgenie/assets/*.map >/dev/null 2>&1; then
  echo "FATAL: .map files present in the webroot — vite.config.ts sourcemap must be false"; fail=1
else
  echo "  no sourcemaps in webroot: ok"
fi
if [ "$fail" != "0" ]; then systemctl status pinball-auth --no-pager -l || true; journalctl -u pinball-auth -n 40 --no-pager || true; exit 1; fi
echo "  memory: $(systemctl show pinball-auth -p MemoryCurrent --value | awk '{printf "%.1fM", $1/1048576}') / max 256M"
REMOTE

echo "→ (h) Caddy site config (whole-file, idempotent) + reload"
ssh_do bash -s <<'REMOTE'
set -euo pipefail
mkdir -p /etc/caddy/conf.d /var/log/caddy
cat > /etc/caddy/conf.d/pinball-genie.conf <<'SITE'
# pinball-genie.com — Pinball Genie LLC production site.
# Written in full by deploy-prod.sh (idempotent). TLS is automatic via the ACME
# settings in the global block of /etc/caddy/Caddyfile.

# One canonical origin: www 301s to the apex, preserving path + query.
www.pinball-genie.com {
	# PG-13 (2026-07-31 review): the redirect itself must carry HSTS. Without
	# it, a visitor whose first ever contact is http://www.pinball-genie.com
	# (a typed address, a printed sticker, a QR code) can be stripped on a
	# hostile network before they ever reach the apex that does set it. Same
	# max-age + includeSubDomains as the apex so the two agree.
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
	redir https://pinball-genie.com{uri} permanent
}

pinball-genie.com {
	encode gzip zstd

	# The Python auth service serves the built app and /data/*.json, and gates
	# them behind a signed session cookie. Caddy never reads the webroot.
	reverse_proxy 127.0.0.1:9310 {
		# PG-02 (HIGH, 2026-07-31 webapp pentest) — SLOW-BODY DoS.
		#
		# The backend is a threaded Python server with a hard cap of 100
		# concurrent slots. Without this, Caddy STREAMS request bodies, so a
		# client that declares Content-Length and then trickles holds a real
		# backend worker for the whole read. Measured pre-fix: one connection
		# sending ONE BYTE of a declared 2000 pinned a worker 14.97s, and ~100
		# of them took the site down — real visitors through this exact config
		# got HTTP 502 Bad Gateway.
		#
		# request_buffers makes Caddy read the body into memory FIRST and only
		# then talk to the backend, so the slow client is absorbed by Go
		# (cheap goroutines, no fixed slot cap) instead of by one of 100 Python
		# threads. Verified against Caddy 2.11.4 with this config: with the
		# same 100-connection attack held open, legitimate requests went from
		# 502 to 200 in 0.00s.
		#
		# This is the EDGE half of the fix. The backend also bounds its own
		# body reads against a wall-clock budget and answers 408
		# (BODY_READ_TIMEOUT / _read_body_bounded in pinball_auth.py), so the
		# service is not dependent on this directive being present — but with
		# it, the pathological client never reaches Python at all.
		#
		# 256KiB comfortably exceeds the largest legitimate body this service
		# accepts (ACHIEVEMENTS_MAX_BODY is 128KB; the sign-in form is ~2KB).
		# Anything larger is already rejected by the backend with 413.
		request_buffers 256KiB
	}

	log {
		output file /var/log/caddy/pinball-genie-access.log {
			roll_size 10MiB
			roll_keep 10
		}
		# D10 (2026-07-30 adversarial review): plain `format json` logs
		# request.uri VERBATIM, query string and all — so every magic-link
		# verification (GET /auth/verify?token=<selector>.<verifier>) wrote a
		# live, still-valid, still-usable token straight into a file this
		# site rolls but never deletes (10 x 10MiB = up to ~100MiB of retained
		# tokens), directly contradicting privacy.html's promise that tokens
		# are never logged. `filter` wraps the same json encoder and lets a
		# named field be rewritten before the line is ever written: `request>uri`
		# is the full path+query Caddy would otherwise log, and its `query`
		# sub-filter can target one parameter by name. This replaces the
		# `token` VALUE with a fixed string — the line still shows a verify
		# attempt happened (status code, timing, IP — all still useful to
		# fail2ban and to ops) but the actual token substance never touches
		# disk. No other route on this site ever sets a `token` query param,
		# so this is a complete no-op for every request except /auth/verify.
		format filter {
			wrap json
			fields {
				request>uri query {
					replace token REDACTED
				}
			}
		}
	}

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "no-referrer"
		# No camera/mic/geo: AR was removed from the web app 2026-07-29.
		Permissions-Policy "geolocation=(), microphone=(), camera=()"
		Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; manifest-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'"
		-Server
	}
}
SITE
caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || { echo "FATAL: Caddyfile invalid"; caddy validate --config /etc/caddy/Caddyfile; exit 1; }
# `caddy validate` runs as root and can pre-create the log file root-owned;
# the reload then runs as `caddy` and gets EACCES. Fix ownership in between.
touch /var/log/caddy/pinball-genie-access.log
chown caddy:caddy /var/log/caddy /var/log/caddy/pinball-genie-access.log
systemctl reload caddy
echo "  caddy reloaded (config valid)"
REMOTE

echo "→ (h2) fail2ban filter + jail (whole-file, idempotent)"
# PG-10 (MEDIUM, 2026-07-31 adversarial review) — THE JAIL COULD BE AIMED AT AN
# INNOCENT VISITOR, and it lived only on the droplet with no copy in the repo.
#
# The filter was `"remote_ip":"<HOST>".*"status":401` — PATH-AGNOSTIC. But
# several routes answer 401 with no credential involved at all: GET
# /api/achievements, GET /auth/export, POST /auth/delete,
# POST /auth/revoke-sessions all 401 simply because there is no session cookie.
# A hostile web page can make ANY visitor's browser emit those as ordinary
# cross-origin GETs, so twelve of them ban that visitor's IP from
# pinball-genie.com for an hour. At DEF CON, behind one venue NAT, that bans
# everybody sharing the address — the app's own abuse control turned into a
# denial-of-service delivered BY the app AGAINST its users.
#
# It is also the jail's ONLY reachable behaviour. On the two routes where a 401
# genuinely means "you presented a credential and it was wrong"
# (GET /auth/verify, POST /auth/request), the in-process RateLimiter already
# blocks after RATE_LIMIT_MAX_FAILS=5 in 5 minutes and then answers 429 — so
# those can never reach maxretry=12. Every ban this jail could ever issue would
# have come from the credential-free routes.
#
# Scoping the failregex to the credential-verdict routes removes the weapon and
# leaves the real control (the in-process limiter) untouched. Caddy's JSON log
# puts `uri` before `status` on the same line, which is what makes this
# expressible. NOTE the ordering hazard: request HEADERS are logged BETWEEN uri
# and status, so a client can put the literal text of this pattern in a header
# — that only ever lets an attacker match their OWN request, i.e. ban
# themselves, never a third party.
ssh_do bash -s <<'REMOTE'
set -euo pipefail
mkdir -p /etc/fail2ban/filter.d /etc/fail2ban/jail.d
cat > /etc/fail2ban/filter.d/caddy-pinball.conf <<'FILTER'
# Written by deploy-prod.sh (PG-10). Do not hand-edit on the droplet.
[Definition]
# Only count a 401 on the routes where it is a real credential verdict.
# /api/achievements, /auth/export, /auth/delete and /auth/revoke-sessions all
# answer 401 for a merely-absent cookie, which any third-party page can force a
# visitor's browser to send — counting those let a stranger ban that visitor.
failregex = "remote_ip":"<HOST>".*"uri":"/auth/(?:verify|request)[^"]*".*"status":401
ignoreregex =
datepattern = {EPOCH}
FILTER
cat > /etc/fail2ban/jail.d/caddy-pinball.local <<'JAIL'
# Written by deploy-prod.sh. Do not hand-edit on the droplet.
#
# PG-03 (2026-07-31): jail.d/defaults-debian.conf sets `backend = systemd` in
# [DEFAULT]. A systemd-backend jail reads the JOURNAL and ignores `logpath`
# entirely, so this filter was never applied to anything — the jail showed
# "Journal matches:" empty and Total failed: 0 while the log it names already
# held 107 x "status":401. Pinning `backend = polling` reads the FILE. Polling
# rather than auto because Caddy's log rotation replaces the inode, which
# inotify follows less reliably; this log is low-volume so polling costs
# nothing.
[caddy-pinball]
enabled  = true
backend  = polling
filter   = caddy-pinball
logpath  = /var/log/caddy/pinball-genie-access.log
maxretry = 12
findtime = 600
bantime  = 3600
port     = http,https
# Debian ships `ignoreip = 127.0.0.1/8 ::1` in jail.conf but this host had NO
# ignoreip on any jail. Harmless today (the loopback smoke checks hit the
# backend on :9310 and never touch Caddy's log) but a future localhost health
# check that 401s would ban 127.0.0.1 and take the site down from the inside.
ignoreip = 127.0.0.1/8 ::1
JAIL
fail2ban-client --test >/dev/null 2>&1 || { echo "FATAL: fail2ban config invalid"; fail2ban-client --test; exit 1; }
systemctl restart fail2ban
sleep 3
systemctl is-active --quiet fail2ban || { echo "FATAL: fail2ban did not come back up"; exit 1; }
fail2ban-client status caddy-pinball | grep -q "File list" || { echo "FATAL: jail is not reading the log FILE (backend regression — see PG-03)"; fail2ban-client status caddy-pinball; exit 1; }
echo "  fail2ban reloaded; jail reading the access log"
REMOTE

echo "→ (i) end-to-end smoke test from this Mac"
fail=0
# The site is PUBLIC now (PINBALL_PUBLIC=1 on this unit, step g) — unauth GET
# / serves the app directly instead of redirecting to /login.
# ---------------------------------------------------------------------------
# PG-03 (2026-07-31 webapp pentest) — DON'T LET THE DEPLOY BAN THE DEPLOYER.
#
# Until this pentest the caddy-pinball fail2ban jail had never counted a single
# event: `backend = systemd` inherited from jail.d/defaults-debian.conf made a
# systemd-journal jail out of a config that names a logpath, so its filter was
# never applied to anything (107 x 401 sat unnoticed in the log it watches).
# That is now fixed — which means, for the first time, THIS SCRIPT's own smoke
# tests count.
#
# The smoke section below deliberately asserts 401 on five routes (bogus
# /auth/verify, /api/achievements twice, /auth/export, POST /auth/delete).
# Five is under maxretry=12, so one deploy is safe — but findtime is 600s, and
# re-running a deploy two or three times inside ten minutes (routine when
# chasing a failing gate) crosses 12 and bans the operator's own IP from
# http/https for bantime=3600. The site would be up and rolo simply could not
# reach it, with the cause looking exactly like an outage.
#
# So the deploying IP is whitelisted for the duration of the smoke run and
# removed immediately after, via a trap so it is removed even if a gate exits
# early. This is scoped to this one jail and this one IP: sshd's jail is
# untouched, and nothing is left permanently ignored.
# PG-16 (2026-07-31 review) — MY OWN BUG FROM EARLIER TODAY. This value comes
# from an UNAUTHENTICATED THIRD PARTY (api.ipify.org) and was spliced unquoted
# into a command run as root on the droplet AND into a `trap` string. A hostile
# or compromised response containing a quote, semicolon, backtick or newline
# would have executed as root. Validate it is literally an IPv4/IPv6 address
# before it goes anywhere near a shell, and cap the response size.
DEPLOY_IP="$(curl -sS --fail --max-filesize 128 --max-time 10 https://api.ipify.org 2>/dev/null || true)"
DEPLOY_IP="$(printf '%s' "$DEPLOY_IP" | tr -d '[:space:]')"
if ! printf '%s' "$DEPLOY_IP" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$|^[0-9a-fA-F:]{2,45}$'; then
  [ -n "$DEPLOY_IP" ] && echo "  note: ipify returned something that is not an IP address — ignoring it"
  DEPLOY_IP=""
fi
if [ -n "$DEPLOY_IP" ]; then
  ssh_do "fail2ban-client set caddy-pinball addignoreip $DEPLOY_IP" >/dev/null 2>&1 || true
  # shellcheck disable=SC2064  # expand DEPLOY_IP now, on purpose
  trap "ssh -i '$KEY' -o BatchMode=yes root@'$DROPLET' 'fail2ban-client set caddy-pinball delignoreip $DEPLOY_IP' >/dev/null 2>&1 || true" EXIT
  echo "  fail2ban: $DEPLOY_IP temporarily ignored for the smoke run (removed on exit)"
else
  echo "  note: could not determine this machine's public IP — smoke-test 401s will count toward the fail2ban jail (12/600s)"
fi

unauth="$(curl -s -o /dev/null -w '%{http_code}' "$URL")"
[ "$unauth" = "200" ] || { echo "FATAL: unauth GET / = $unauth (want 200 — public launch)"; fail=1; }
login_body="$(curl -s -L "${URL}login")"
login_code="$(curl -s -o /dev/null -w '%{http_code}' -L "${URL}login")"
[ "$login_code" = "200" ] || { echo "FATAL: GET /login = $login_code (want 200 — must stay live in public mode)"; fail=1; }
grep -q 'Pinball Genie' <<<"$login_body" || { echo "FATAL: /login doesn't look like the sign-in page"; fail=1; }
grep -q 'class="card is-sent"' <<<"$login_body" && { echo "FATAL: 'check your inbox' state visible on a clean /login (marker-substitution regression — see login.html/login.css header comments)"; fail=1; }
# Phase 5 (2026-07-30): no username/password to smoke-test. POST
# /auth/request ALWAYS 302s to the neutral confirmation page. D11 (2026-07-30
# review): same fix as the loopback check in step (g) above — a deliberately
# MALFORMED address (no "@") short-circuits in normalize_email() before
# USERS.find_or_create/TOKENS.issue/SENDER.send ever run, so this creates no
# permanent account row, sends no mail, and consumes no per-email rate-limit
# slot on every deploy. See step (g)'s comment for the full incident: the old
# smoke-test@example.com reproducibly ABORTED the 4th deploy inside 15
# minutes (per-email cap) and, now that ResendSender is live, would hard-
# bounce against send.pinball-genie.com's own sending reputation.
req="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${URL}auth/request" -d 'email=deploy-smoketest-malformed')"
[ "$req" = "302" ] || { echo "FATAL: POST /auth/request = $req (want 302 — neutral response)"; fail=1; }
bad="$(curl -s -o /dev/null -w '%{http_code}' "${URL}auth/verify?token=bogus-selector.bogus-verifier")"
[ "$bad" = "401" ] || { echo "FATAL: bogus /auth/verify = $bad (want 401 — fail2ban jail depends on this)"; fail=1; }
# Catalog data is public now too.
data="$(curl -s -o /dev/null -w '%{http_code}' "${URL}data/catalog.json")"
[ "$data" = "200" ] || { echo "FATAL: unauth /data/catalog.json = $data (want 200 — public launch)"; fail=1; }
# The achievements tracker stays account-gated regardless of public mode.
# /whoami is a PROBE, not a gated resource, since the D6 fix (2026-07-30
# second security review). It used to 401 when signed out — and the client
# calls it on every Achievements-tab open alongside /api/achievements, so a
# signed-out visitor emitted TWO 401s per open, while the fail2ban jail bans
# on 12 x 401 in 10 minutes. Six tab opens got a whole household behind one
# NAT banned from the site for an hour. It now answers 200 {"user":null} for
# a signed-out visitor: no secret is disclosed (the answer is literally "you
# are nobody"), and the jail keeps its signal because real auth failures on
# /auth/verify and /auth/request still 401.
#
# So assert BOTH halves: the status is 200, AND the body really does report a
# null user. A 200 carrying someone's uid would be the actual catastrophe this
# check exists to catch, and only checking the status code would miss it.
whoami_code="$(curl -s -o /dev/null -w '%{http_code}' "${URL}whoami")"
whoami_body="$(curl -s "${URL}whoami")"
[ "$whoami_code" = "200" ] || { echo "FATAL: unauth /whoami = $whoami_code (want 200 since the D6 fix)"; fail=1; }
case "$whoami_body" in
  *'"user"'*null*) : ;;
  *) echo "FATAL: unauth /whoami body did not report a null user: $whoami_body"; fail=1 ;;
esac
# The genuinely session-gated per-user routes must still be 401 with no cookie.
for gated in api/achievements auth/export; do
  gcode="$(curl -s -o /dev/null -w '%{http_code}' "${URL}${gated}")"
  [ "$gcode" = "401" ] || { echo "FATAL: unauth /${gated} = $gcode (want 401 — must stay gated)"; fail=1; }
done
delcode="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${URL}auth/delete")"
[ "$delcode" = "401" ] || { echo "FATAL: unauth POST /auth/delete = $delcode (want 401)"; fail=1; }
ach_code="$(curl -s -o /dev/null -w '%{http_code}' "${URL}api/achievements")"
[ "$ach_code" = "401" ] || { echo "FATAL: unauth /api/achievements = $ach_code (want 401 — must stay gated)"; fail=1; }
# Legal pages: real, JS-free URLs for crawlers / ad-network review. Check all
# four plus the shared stylesheet over real HTTPS — the LEGAL_ASSETS map 404s a
# missing file individually and silently, so one probe cannot cover four pages.
legal_ok=1
for lp in privacy terms about contact legal/legal.css; do
  lc="$(curl -s -o /dev/null -w '%{http_code}' "${URL}${lp}")"
  [ "$lc" = "200" ] || { echo "FATAL: unauth /${lp} = $lc (want 200)"; fail=1; legal_ok=0; }
done
privacy="$(curl -s -o /dev/null -w '%{http_code}' "${URL}privacy")"
# Phase 4 SEO guide pages (2026-07-30): the whole point of this phase is that
# these are real, unauthenticated, JS-free URLs a search crawler or an
# ad-network reviewer can load directly — same treatment as the legal pages
# just above, over real HTTPS this time rather than loopback HTTP.
mach_index="$(curl -s -o /dev/null -w '%{http_code}' "${URL}machines")"
[ "$mach_index" = "200" ] || { echo "FATAL: unauth GET /machines = $mach_index (want 200)"; fail=1; }
guides_ok=1
for slug in jaws godzilla; do
  gbody="$(curl -s "${URL}machines/${slug}")"
  gcode="$(curl -s -o /dev/null -w '%{http_code}' "${URL}machines/${slug}")"
  [ "$gcode" = "200" ] || { echo "FATAL: unauth GET /machines/${slug} = $gcode (want 200)"; fail=1; guides_ok=0; }
  # Content, not just a status code: a 200 with an empty or near-empty body
  # (a template that rendered with no prose, or the SPA's own index.html
  # served by mistake by a routing regression) would pass a bare status
  # check while shipping none of what Phase 4 exists to publish. Neither
  # signal alone is proof; both together are cheap and specific.
  gbytes="$(printf '%s' "$gbody" | wc -c | tr -d ' ')"
  [ "$gbytes" -gt 500 ] || { echo "FATAL: /machines/${slug} body is only ${gbytes} bytes — looks empty, not a real guide page"; fail=1; guides_ok=0; }
  printf '%s' "$gbody" | grep -qi "$slug" || echo "  note: /machines/${slug} body doesn't contain '${slug}' literally (slug vs. display-name casing/formatting — not necessarily a failure)"
done
# Trailing-slash MUST redirect to the canonical no-slash form (301), never
# 404 and never silently serve the same page under a second URL — see
# pinball_auth.py's Handler._serve_machine_guide docstring for why duplicate
# URLs for identical content are a real SEO defect, not a style nit.
slash_redirect="$(curl -s -o /dev/null -w '%{redirect_url}' "${URL}machines/jaws/")"
[[ "$slash_redirect" == "https://${SITE_HOST}/machines/jaws"* ]] || { echo "FATAL: /machines/jaws/ did not redirect to the canonical no-slash form (got '$slash_redirect')"; fail=1; }
slash_status="$(curl -s -o /dev/null -w '%{http_code}' "${URL}machines/jaws/")"
[ "$slash_status" = "301" ] || { echo "FATAL: /machines/jaws/ -> $slash_status (want 301, permanent — not a 302)"; fail=1; }

# PG-01 (CRITICAL, 2026-07-31 webapp pentest) — RESPONSE-HEADER INJECTION.
# That same trailing-slash redirect built its Location from the PERCENT-DECODED
# request path, and CPython's send_header does no CR/LF filtering, so %0d%0a in
# the path emitted attacker-chosen response headers. Confirmed against the LIVE
# site: an injected header came back in a real pinball-genie.com response. The
# Set-Cookie form is one-click session fixation onto the attacker's account.
#
# This gate is deliberately at the DEPLOY boundary and not only in the unit
# tests: the bug's whole character was that it depended on what reached the
# wire THROUGH Caddy, and this is the only check that exercises the real edge.
# curl would re-encode the payload, so --path-as-is keeps it verbatim.
inj_hdrs="$(curl -s --path-as-is -D - -o /dev/null --max-time 15 \
  "${URL}machines/%0d%0aX-Deploy-Injection-Probe:%20present/" || true)"
if printf '%s' "$inj_hdrs" | grep -qi 'X-Deploy-Injection-Probe'; then
  echo "FATAL: PG-01 REGRESSION — a CR/LF in the request path injected a response header."
  echo "       An attacker can set arbitrary headers (incl. Set-Cookie -> session fixation)"
  echo "       on https://${SITE_HOST} via one crafted link. See pinball_auth.py's"
  echo "       Handler.parse_request and test section 17."
  fail=1
fi
inj_status="$(curl -s --path-as-is -o /dev/null -w '%{http_code}' --max-time 15 \
  "${URL}machines/%0d%0aX-Deploy-Injection-Probe:%20present/" || true)"
[ "$inj_status" = "400" ] || { echo "FATAL: a control character in the request target returned $inj_status (want 400) — the PG-01 guard is not active on this deploy"; fail=1; }

# PG-02 (HIGH, same pentest) — the edge half of the slow-body DoS fix must
# actually be in the running config. Checked by reading it back from the box
# rather than trusting that section (h) wrote what we think it wrote.
if ! ssh_do 'grep -q "request_buffers" /etc/caddy/conf.d/pinball-genie.conf'; then
  echo "FATAL: PG-02 REGRESSION — reverse_proxy has no request_buffers, so Caddy streams request"
  echo "       bodies straight into the 100-slot Python backend. ~100 trickled connections"
  echo "       returned 502 Bad Gateway to real visitors pre-fix."
  fail=1
fi
# Canonical tag on a real guide page — same retry pattern as /privacy below
# (that block's comment explains the two spurious 2026-07-31 misses this
# guards against; identical class of transient miss, identical treatment).
machine_canon_ok=0
for attempt in 1 2 3; do
  machine_canon_body="$(curl -s --max-time 15 "${URL}machines/jaws" || true)"
  if printf '%s' "$machine_canon_body" | grep -q 'rel="canonical" href="https://pinball-genie.com/machines/jaws"'; then
    machine_canon_ok=1
    [ "$attempt" = "1" ] || echo "  note: /machines/jaws canonical matched on attempt $attempt (attempt 1 missed)"
    break
  fi
  sleep 1
done
if [ "$machine_canon_ok" != "1" ]; then
  echo "FATAL: /machines/jaws is missing its self-referencing canonical link after 3 attempts."
  echo "  bytes received on the last attempt: $(printf '%s' "$machine_canon_body" | wc -c | tr -d ' ')"
  fail=1
fi
# Crawler/SEO surface. Also assert robots.txt actually names the sitemap and
# does NOT block the AdSense crawler — a robots.txt that 200s while quietly
# disallowing Mediapartners-Google is the failure this catches.
for sf in robots.txt sitemap.xml; do
  sc="$(curl -s -o /dev/null -w '%{http_code}' "${URL}${sf}")"
  [ "$sc" = "200" ] || { echo "FATAL: unauth /${sf} = $sc (want 200)"; fail=1; }
done
robots_body="$(curl -s "${URL}robots.txt")"
printf '%s' "$robots_body" | grep -qi "^Sitemap: https://${SITE_HOST}/sitemap.xml" \
  || { echo "FATAL: robots.txt does not advertise https://${SITE_HOST}/sitemap.xml"; fail=1; }
if printf '%s' "$robots_body" | awk 'BEGIN{IGNORECASE=1} /^User-agent:[[:space:]]*Mediapartners-Google/{f=1;next} /^User-agent:/{f=0} f && /^Disallow:[[:space:]]*\//{found=1} END{exit !found}'; then
  echo "FATAL: robots.txt disallows Mediapartners-Google (the AdSense crawler) — never block it"; fail=1
fi
# Canonical tags must be present so /privacy and /legal/privacy.html (same
# bytes, two URLs in public mode) don't compete as duplicates.
# Canonical tag. RETRIED, and it reports what it actually received on failure.
#
# This check failed spuriously on two separate deploys (2026-07-31) while the
# tag was demonstrably present — hand-checking the same URL immediately
# afterwards matched every time, across repeated requests and repeated Caddy
# reloads. The cause was never reproduced, which is exactly why this is now
# three attempts rather than one: a single unexplained curl/grep miss should
# not abort a deploy that is otherwise green, but it must also never be
# silently swallowed. If all three attempts miss, that IS a real failure, and
# the diagnostic below prints the bytes we got so the next person does not have
# to reconstruct this from scratch.
canon_ok=0
for attempt in 1 2 3; do
  canon_body="$(curl -s --max-time 15 "${URL}privacy" || true)"
  if printf '%s' "$canon_body" | grep -q 'rel="canonical" href="https://pinball-genie.com/privacy"'; then
    canon_ok=1
    [ "$attempt" = "1" ] || echo "  note: canonical matched on attempt $attempt (attempt 1 missed — see this block's comment)"
    break
  fi
  sleep 1
done
if [ "$canon_ok" != "1" ]; then
  echo "FATAL: /privacy is missing its canonical link after 3 attempts."
  echo "  bytes received on the last attempt: $(printf '%s' "$canon_body" | wc -c | tr -d ' ')"
  echo "  <head> as served:"
  printf '%s' "$canon_body" | sed -n '1,20p' | sed 's/^/    /'
  fail=1
fi
# Sourcemap regression guard over real HTTPS (belt to the webroot check above).
mapcode="$(curl -s -o /dev/null -w '%{http_code}' "${URL}assets/index.js.map")"
[ "$mapcode" = "404" ] || echo "  note: /assets/index.js.map -> $mapcode (expected 404; hashed names mean this probe is indicative only)"
wwwr="$(curl -s -o /dev/null -w '%{redirect_url}' "https://www.${SITE_HOST}/")"
[[ "$wwwr" == "https://${SITE_HOST}/"* ]] || { echo "FATAL: www did not redirect to the apex (got '$wwwr')"; fail=1; }
[ "$fail" = "0" ] || exit 1

echo
echo "✓ Pinball Genie LIVE (public; achievements tracker still account-gated): $URL"
echo "✓   unauth GET /            -> $unauth (public)"
echo "✓   GET /login              -> $login_code, 'check your inbox' state hidden on a clean load, still live"
echo "✓   POST /auth/request      -> $req (neutral 302, same for any address)"
echo "✓   bogus GET /auth/verify  -> $bad (401 — fail2ban signal intact)"
echo "✓   unauth GET /data/*.json -> $data (public)"
echo "✓   unauth GET /whoami     -> $whoami_code $whoami_body (probe, not gated — see D6)"
echo "✓   unauth /api/achievements, /auth/export, POST /auth/delete -> 401 (gated)"
echo "✓   unauth GET /api/achievements -> $ach_code (gated)"
echo "✓   unauth GET /privacy    -> $privacy (all 4 legal pages + legal.css: $([ "$legal_ok" = "1" ] && echo 200 || echo FAILED))"
echo "✓   unauth GET /machines, /machines/{jaws,godzilla} -> 200 with real content: $([ "$guides_ok" = "1" ] && echo ok || echo FAILED)"
echo "✓   /machines/jaws/ (trailing slash) -> 301 -> canonical no-slash form"
echo "✓   canonical on /machines/jaws -> present"
echo "✓   robots.txt + sitemap.xml -> 200, sitemap advertised, AdSense crawler allowed"
echo "✓   canonical on /privacy   -> present"
echo "✓   www                     -> 301 -> apex"
echo
echo "Accounts: self-serve, passwordless magic-link sign-in (Phase 5, 2026-07-30)."
echo "No shared credentials to distribute — CREDENTIALS.md (6 fixed users, PBKDF2)"
echo "is RETIRED along with server/auth.json; archive/remove the LOCAL copies by hand"
echo "(the droplet's /etc/pinball-auth/auth.json is now removed automatically, step (f))."
echo "Resend key: /etc/pinball-auth/resend_key — REQUIRED, gated at preflight (0z):"
echo "  this deploy would already have FAILED above if it were missing or empty, so"
echo "  ResendSender is active, not DevLogSender. See mail_sender.py /"
echo "  \`journalctl -u pinball-auth\` to confirm which sender actually started."

#!/usr/bin/env python3
"""server/tests/test_magic_link_auth.py — Phase 5 magic-link auth (server/
pinball_auth.py + server/mail_sender.py).

PATTERN: mirrors app/tests/*.test.mjs (section()/test()/assert(), PASS/FAIL
per assertion, a summary line, non-zero exit on any failure) — see e.g.
adslot-gate.test.mjs's header. Those suites bundle the real TypeScript
source with esbuild and drive it directly; the equivalent move for a stdlib
HTTP server is to run the REAL pinball_auth.py as a live subprocess on a
spare port with --dev and drive it with plain HTTP requests (http.client —
stdlib's curl-equivalent), which is exactly what this file does. No vitest/
jest/pytest — none of those exist in this repo and this file doesn't need
one.

Every functional (non-rate-limit) test below is assigned its OWN fake source
IP (via X-Forwarded-For, which pinball_auth.py's _client_ip() trusts because
the TCP peer of a subprocess bound to 127.0.0.1 is loopback — see that
method's own comment) and its OWN unique email address. This is not
decorative: it keeps every test's rate-limit bucket (both the failure-only
RateLimiter and the three SlidingWindowLimiter instances) fully independent
of every other test's, so this file can add/remove/reorder tests without
one test's failures silently exhausting another's budget. The three
rate-limit-TRIPPING tests deliberately violate this isolation on purpose, on
their own dedicated freshly-spawned server processes — see that section.

Run:
  python3 server/tests/test_magic_link_auth.py
or from server/:
  python3 tests/test_magic_link_auth.py
Exits non-zero if any assertion fails.
"""

from __future__ import annotations

import http.client
import json
import os
import secrets
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.dirname(TESTS_DIR)
REPO_ROOT = os.path.dirname(SERVER_DIR)
PINBALL_AUTH = os.path.join(SERVER_DIR, "pinball_auth.py")
LOGIN_HTML = os.path.join(SERVER_DIR, "login.html")
APP_ROOT = os.path.join(REPO_ROOT, "app", "dist")
DATA_DIR = os.path.join(REPO_ROOT, "data")

assert os.path.isfile(PINBALL_AUTH), f"expected {PINBALL_AUTH} to exist"
assert os.path.isfile(LOGIN_HTML), f"expected {LOGIN_HTML} to exist"
assert os.path.isdir(APP_ROOT), (
    f"expected {APP_ROOT} to exist — run `npm run build` in app/ first. "
    "(This test only needs --root to be A valid built directory; it points "
    "PINBALL_AUTH_LOGIN directly at server/login.html so it always exercises "
    "the freshest login page regardless of what's cached in app/dist.)"
)
assert os.path.isdir(DATA_DIR), f"expected {DATA_DIR} to exist"

sys.path.insert(0, SERVER_DIR)  # so `import mail_sender`/`import pinball_auth`
# below resolve the REAL sibling modules. Importing pinball_auth directly
# (as opposed to only ever running it as a subprocess, which the rest of
# this file does) is safe: everything at its module level is a constant/
# class definition with no side effects — main() (the only place that
# prints, binds a socket, or touches the filesystem) is guarded by
# `if __name__ == "__main__"` and is never called here. This lets a few
# small, pure-function regression tests (normalize_email, validate_public_
# origin, subnet_key) run in-process instead of needing a whole subprocess
# spin-up just to exercise one function.
import pinball_auth  # noqa: E402 - see the comment above for why this
# import is safe and deliberately placed after sys.path is set up

# ---------------------------------------------------------------------------
# Minimal test harness — mirrors app/tests/*.test.mjs's section()/test()/
# assert() shape, in Python.
# ---------------------------------------------------------------------------
_results = []
_current_section = ""


def section(name):
    global _current_section
    _current_section = name
    print(f"\n=== {name} ===")


def test(name, fn):
    full = f"{_current_section} :: {name}"
    try:
        evidence = fn()
        _results.append((full, "pass"))
        print(f"  PASS  {name}" + (f"\n          {evidence}" if evidence else ""))
    except Exception as e:  # noqa: BLE001 - test harness: catch ANY failure
        _results.append((full, "fail"))
        print(f"  FAIL  {name}\n          {type(e).__name__}: {e}")


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


# ---------------------------------------------------------------------------
# HTTP helper — http.client is stdlib's low-level equivalent of curl: full
# control over headers (needed for X-Forwarded-For, Origin, Sec-Fetch-Site,
# Cookie), no automatic redirect-following (needed to inspect a bare 302).
# ---------------------------------------------------------------------------


def http_request(port, method, path, form=None, headers=None):
    """Returns (status, header_list, body_bytes). A fresh connection per
    call, closed immediately after — simplest thing that can't leak a
    dangling keep-alive socket across a 150+-request test run."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    hdrs = dict(headers or {})
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/x-www-form-urlencoded")
    hdrs.setdefault("Connection", "close")
    try:
        conn.request(method, path, body=data, headers=hdrs)
        resp = conn.getresponse()
        body = resp.read()
        return resp.status, resp.getheaders(), body
    finally:
        conn.close()


def header(headers_list, name):
    name = name.lower()
    for k, v in headers_list:
        if k.lower() == name:
            return v
    return None


def session_cookie(headers_list):
    for k, v in headers_list:
        if k.lower() == "set-cookie" and v.startswith("pinball_session="):
            return v.split(";", 1)[0].split("=", 1)[1]
    return None


_ip_counter = [0]


def next_fake_ip():
    """A fresh, never-repeated source IP for X-Forwarded-For, so each test
    that requests one gets its own independent RateLimiter/
    SlidingWindowLimiter bucket on the shared main server — see this file's
    header comment.

    The THIRD octet advances on EVERY call, not just the fourth (D5,
    2026-07-30 review): REQUEST_LIMIT_SUBNET buckets by containing /24, so
    the OLD formula here — which only advanced the fourth octet on every
    call and only rolled the third over every 250 calls — silently put the
    first 250 "independent" test IPs from this function into the SAME /24,
    all sharing one subnet bucket. That's exactly the cross-test-isolation
    bug this file's own header comment warns against, just one limiter
    later than it originally anticipated. Advancing the third octet every
    call means no two calls share a /24 until well past 60,000 calls,
    comfortably beyond anything a single test run needs.
    """
    _ip_counter[0] += 1
    n = _ip_counter[0]
    return f"10.{50 + (n // 62500) % 100}.{n % 250}.{(n // 250) % 250 + 1}"


_email_counter = [0]


def next_email(prefix="user"):
    _email_counter[0] += 1
    return f"{prefix}-{_email_counter[0]}-{secrets.token_hex(4)}@example.com"


# ---------------------------------------------------------------------------
# Server process management
# ---------------------------------------------------------------------------


def free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class ServerProc:
    def __init__(self, env_overrides=None, label="server", dev=True, root=None):
        self.label = label
        self.dev = dev
        self.root = root or APP_ROOT  # Phase 4 tests point this at a small
        # synthetic fixture (see section 13) rather than the real app/dist,
        # so those tests exercise pinball_auth.py's ROUTING regardless of
        # whether/when the separate guide-generation build step has run in
        # this checkout — every other caller keeps the original behavior of
        # always using the real built app.
        self.port = free_port()
        self.state_dir = tempfile.mkdtemp(prefix=f"pg-auth-{label}-")
        env = os.environ.copy()
        env["PINBALL_AUTH_LOGIN"] = LOGIN_HTML
        env["PINBALL_STATE_DIR"] = self.state_dir
        # No Resend key anywhere near this path -> mail_sender.build_sender
        # falls back to DevLogSender. This is the default for every server
        # this file spawns: zero risk of a real network send during a test
        # run, and it is itself the thing the STARTUP section proves.
        env.setdefault("PINBALL_RESEND_KEY_FILE", os.path.join(self.state_dir, "no-such-key"))
        if not dev:
            # D2 (2026-07-30 review): main() now refuses to start outside
            # --dev without BOTH a real session secret file and a validated
            # PINBALL_PUBLIC_ORIGIN — provide sane defaults for the (rare)
            # test that specifically wants non-dev startup behavior; either
            # can still be overridden via env_overrides below.
            secret_path = os.path.join(self.state_dir, "secret")
            with open(secret_path, "w", encoding="utf-8") as f:
                f.write(secrets.token_hex(32))
            env.setdefault("PINBALL_AUTH_SECRET_FILE", secret_path)
            env.setdefault("PINBALL_PUBLIC_ORIGIN", "https://pinball-genie.com")
        if env_overrides:
            env.update(env_overrides)
        args = [sys.executable, PINBALL_AUTH, "--port", str(self.port),
                "--root", self.root, "--data", DATA_DIR, "--state-dir", self.state_dir]
        if dev:
            args.append("--dev")
        self.proc = subprocess.Popen(
            args,
            cwd=SERVER_DIR,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        self.log_lines = []
        self._lock = threading.Lock()
        self._reader = threading.Thread(target=self._drain, daemon=True)
        self._reader.start()
        self._wait_ready()

    def _drain(self):
        try:
            for line in self.proc.stdout:
                with self._lock:
                    self.log_lines.append(line.rstrip("\n"))
        except ValueError:
            pass  # pipe closed under us during shutdown

    def _wait_ready(self, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(
                    f"[{self.label}] server exited early (code {self.proc.returncode}); log:\n{self.log_text()}"
                )
            try:
                status, _, _ = http_request(self.port, "GET", "/health")
                if status == 200:
                    return
            except OSError:
                pass
            time.sleep(0.05)
        raise RuntimeError(f"[{self.label}] server did not become healthy within {timeout}s")

    def log_text(self):
        with self._lock:
            return "\n".join(self.log_lines)

    def link_for(self, email):
        """Reads DevLogSender's dev_magic_links.jsonl file under this
        server's STATE_DIR for the most recent link issued to `email`.

        D4 (2026-07-30 security review): this used to scrape a `DEV MAGIC
        LINK for <email>: <link>` line straight off the server's stdout —
        which was exactly the bug being fixed (a live token plus the
        recipient's address, sitting in this service's own log). DevLogSender
        now prints only a fully redacted marker and writes the real
        email/link pair to a dedicated 0600 file instead (see that class's
        docstring) — reading it back here is the new "deliberately open the
        file a developer/test is meant to open" path, not a log-scrape."""
        path = os.path.join(self.state_dir, "dev_magic_links.jsonl")
        try:
            with open(path, "r", encoding="utf-8") as f:
                lines = f.readlines()
        except OSError:
            return None
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("email") == email:
                return rec.get("link")
        return None

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)
        shutil.rmtree(self.state_dir, ignore_errors=True)


# PG-06 (2026-07-31 webapp pentest): POST /auth/request now hands the
# REQUESTING browser a `pinball_link` nonce cookie, and GET /auth/verify only
# signs in silently when the click carries it back — otherwise it renders a
# confirmation page instead of minting a session (see _verify_confirm_page).
#
# Every pre-existing test in this file models a real user who asked for a link
# and then clicked it in the SAME browser, so the nonce is recorded here at
# request time and replayed automatically by verify() below. That keeps those
# tests testing what they were written to test rather than incidentally
# exercising the new cross-device path. Tests that specifically want a
# DIFFERENT browser pass `nonce=False`.
_link_nonces = {}  # token -> nonce handed to the requesting browser


def link_nonce(headers_list):
    for k, v in headers_list:
        if k.lower() == "set-cookie" and v.startswith("pinball_link="):
            return v.split(";", 1)[0].split("=", 1)[1]
    return None


def request_link(srv, email, ip):
    """POST /auth/request then pull the resulting link off the log."""
    status, headers_list, _body = http_request(
        srv.port, "POST", "/auth/request", form={"email": email},
        headers={"X-Forwarded-For": ip},
    )
    check(status == 302, f"POST /auth/request for {email} -> {status}, want 302")
    check(header(headers_list, "Location") == "/login?sent=1", "expected redirect to /login?sent=1")
    link = srv.link_for(email)
    check(link is not None, f"no DEV MAGIC LINK logged for {email}")
    nonce = link_nonce(headers_list)
    if nonce:
        _link_nonces[token_from_link(link)] = nonce
    return link


def token_from_link(link):
    return urllib.parse.parse_qs(urllib.parse.urlsplit(link).query)["token"][0]


def verify(srv, token, ip=None, nonce=None):
    """GET /auth/verify. By default replays the nonce cookie this token was
    issued with (PG-06 same-browser path). Pass nonce=False to simulate a click
    from a DIFFERENT browser, which is what the confirmation page exists for."""
    headers = {"X-Forwarded-For": ip} if ip else {}
    if nonce is None:
        nonce = _link_nonces.get(token)
    if nonce:
        headers["Cookie"] = f"pinball_link={nonce}"
    return http_request(srv.port, "GET", f"/auth/verify?token={urllib.parse.quote(token)}", headers=headers)


def sign_in(srv, email, ip):
    """Full happy-path helper: request a link, verify it, return the
    session cookie. Used by tests that need a signed-in user as setup
    rather than as the thing under test."""
    link = request_link(srv, email, ip)
    status, headers_list, _body = verify(srv, token_from_link(link), ip)
    check(status == 302, f"verify() for {email} -> {status}, want 302")
    cookie = session_cookie(headers_list)
    check(cookie is not None, "expected a session cookie from a valid verify")
    return cookie


# ===========================================================================
# Main server — every functional (non-rate-limit-tripping) test runs here.
# ===========================================================================
main_srv = ServerProc(label="main")
print(f"main server: 127.0.0.1:{main_srv.port}  (state_dir={main_srv.state_dir})")

try:
    # =======================================================================
    section("0. Startup — no auth.json, no Resend key, still serves cleanly")
    # =======================================================================

    def t_no_authjson_mentioned():
        check("auth.json" not in main_srv.log_text(), "expected zero mention of auth.json in a clean startup log")

    test("clean startup log never mentions auth.json", t_no_authjson_mentioned)

    def t_devlog_warning():
        log = main_srv.log_text()
        check("WARNING: no Resend API key" in log, "expected the DevLogSender startup warning")
        check("DevLogSender" in log, "expected the warning to name DevLogSender")

    test("DevLogSender warning printed once at startup (no Resend key present)", t_devlog_warning)

    def t_health_ok():
        status, _h, _b = http_request(main_srv.port, "GET", "/health")
        check(status == 200, f"/health -> {status}, want 200")

    test("/health is 200 with no session, no auth.json, no Resend key", t_health_ok)

    def t_source_never_opens_authjson():
        src = open(PINBALL_AUTH, "r", encoding="utf-8").read()
        # The module docstring (and several migration-history comments below
        # it) narrate the RETIREMENT of auth.json in plain prose on purpose —
        # this codebase documents its own past incidents inline, and that's
        # deliberate, not a leftover. What must be ZERO is an actual QUOTED
        # STRING LITERAL naming the file — i.e. functioning code that could
        # construct a path to it or open it — as opposed to the bare word
        # appearing in a comment's sentence.
        check('"auth.json"' not in src, 'expected zero string-literal `"auth.json"` in the source (prose mentions of the retired file are fine; a quoted literal would mean code still references it)')
        check("'auth.json'" not in src, "expected zero string-literal 'auth.json' in the source")

    test("running module's own source never constructs a path to auth.json", t_source_never_opens_authjson)

    def t_retired_password_machinery_gone():
        src = open(PINBALL_AUTH, "r", encoding="utf-8").read()
        # Precise DEFINITION patterns, not bare substrings — the module
        # docstring's migration narrative legitimately says "auth.json,
        # PBKDF2 hashes", "USERNAME_RE/HASH_RE", "the fake-salt ... dance"
        # in prose (see its MAGIC-LINK SECURITY MODEL intro), and a bare
        # substring check would false-positive on that prose instead of
        # testing for an actual leftover definition.
        for needle, why in [
            ("class AuthStore", "AuthStore must be fully removed"),
            ("def verify_password", "verify_password must be fully removed"),
            ("USERNAME_RE = re.compile", "USERNAME_RE must be fully removed (replaced by UID_RE)"),
            ("HASH_RE = re.compile", "the old password-hash HASH_RE must be fully removed"),
            ("FAKE_SALT = b", "FAKE_SALT must be fully removed"),
            ("FAKE_ITERATIONS = ", "FAKE_ITERATIONS must be fully removed"),
            ("pbkdf2_hmac", "no PBKDF2 derivation of any kind may remain"),
        ]:
            check(needle not in src, why)

    test("source no longer defines the retired password machinery", t_retired_password_machinery_gone)

    def t_token_uses_compare_digest():
        src = open(PINBALL_AUTH, "r", encoding="utf-8").read()
        check(
            'hmac.compare_digest(expected, rec["verifier_hash"])' in src,
            "expected the magic-link verifier comparison to use hmac.compare_digest, not ==",
        )

    test("source-level: token verifier is compared with hmac.compare_digest", t_token_uses_compare_digest)

    def t_session_names_uid_not_email():
        src = open(PINBALL_AUTH, "r", encoding="utf-8").read()
        # D-EPOCH (2026-07-31): sign() gained a third `epoch` parameter (see
        # UserStore.bump_epoch/POST /auth/revoke-sessions) — this check is
        # updated to match that signature, not relaxed; the property it
        # guards (uid, never email, is what gets signed) is unchanged.
        check(
            "def sign(uid: str, exp: int, epoch: int)" in src,
            "expected sign()'s first param to still be named uid, not user/email",
        )
        check("sign(email" not in src, "the session signature must never be computed over the email")

    test("source-level: session signature is over uid, never email", t_session_names_uid_not_email)

    # =======================================================================
    section("1. mail_sender.py — sender selection + email content (direct import)")
    # =======================================================================
    import mail_sender  # the REAL sibling module, not a copy

    def t_build_sender_devlog_when_missing():
        missing_path = os.path.join(main_srv.state_dir, "definitely-does-not-exist")
        sender = mail_sender.build_sender(missing_path)
        check(isinstance(sender, mail_sender.DevLogSender), f"expected DevLogSender, got {type(sender)}")

    test("build_sender() -> DevLogSender when the key file is absent", t_build_sender_devlog_when_missing)

    def t_build_sender_devlog_when_empty():
        empty_path = os.path.join(main_srv.state_dir, "empty-key")
        open(empty_path, "w").close()
        sender = mail_sender.build_sender(empty_path)
        check(isinstance(sender, mail_sender.DevLogSender), f"expected DevLogSender, got {type(sender)}")

    test("build_sender() -> DevLogSender when the key file is empty", t_build_sender_devlog_when_empty)

    def t_build_sender_resend_when_present():
        key_path = os.path.join(main_srv.state_dir, "fake-resend-key")
        with open(key_path, "w") as f:
            f.write("re_fake_test_key_1234567890\n")
        sender = mail_sender.build_sender(key_path)
        check(isinstance(sender, mail_sender.ResendSender), f"expected ResendSender, got {type(sender)}")

    test("build_sender() -> ResendSender when a non-empty key file is present", t_build_sender_resend_when_present)

    def t_email_content_required_disclosures():
        text, html_body = mail_sender.render_magic_link_email("https://pinball-genie.com/auth/verify?token=abc.def")
        for needle in ["15 minutes", "didn't request this", "https://pinball-genie.com/auth/verify?token=abc.def"]:
            check(needle in text, f"plain-text body missing required content: {needle!r}")
        check("https://pinball-genie.com/auth/verify?token=abc.def" in html_body, "HTML body missing the link")
        check("15 minutes" in html_body, "HTML body missing the 15-minute expiry disclosure")

    test("magic-link email has text+HTML parts with the required disclosures", t_email_content_required_disclosures)

    def t_email_from_and_reply_to():
        check(mail_sender.FROM_ADDR.endswith("@send.pinball-genie.com>"), "From must be on send.pinball-genie.com")
        check(mail_sender.REPLY_TO == "admin@pinball-genie.com", "Reply-To must be admin@pinball-genie.com")

    test("sends from send.pinball-genie.com with Reply-To admin@pinball-genie.com", t_email_from_and_reply_to)

    def t_devlogsender_redacts_stdout_and_writes_0600_file():
        """D4 regression (2026-07-30 security review): DevLogSender used to
        print `DEV MAGIC LINK for <email>: <link>` — a live 15-minute bearer
        credential PLUS the recipient's address — straight to this
        service's own stdout. It must now print nothing identifying at all,
        and the real link must land only in a 0600 file under STATE_DIR."""
        import contextlib
        import io

        tmp = tempfile.mkdtemp(prefix="pg-devlog-unit-")
        try:
            sender = mail_sender.DevLogSender(tmp)
            buf = io.StringIO()
            token = "SELECTOR123.VERIFIERSECRETVALUE456"
            link = f"https://pinball-genie.com/auth/verify?token={token}"
            with contextlib.redirect_stdout(buf):
                sender.send("victim-d4@example.com", link)
            out = buf.getvalue()
            check("victim-d4@example.com" not in out, "the recipient email must never appear in stdout")
            check(token not in out, "the token must never appear in stdout")
            check("auth/verify?token=" not in out, "no full magic-link URL should ever appear in stdout")

            path = os.path.join(tmp, "dev_magic_links.jsonl")
            check(os.path.exists(path), "expected the dev magic-link file to have been written")
            mode = os.stat(path).st_mode & 0o777
            check(mode == 0o600, f"expected the dev magic-link file to be 0600, got {oct(mode)}")
            with open(path, "r", encoding="utf-8") as f:
                rec = json.loads(f.readline())
            check(rec["email"] == "victim-d4@example.com", "expected the FILE (not stdout) to hold the real email")
            check(rec["link"] == link, "expected the FILE (not stdout) to hold the real link")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    test("D4: DevLogSender redacts stdout and writes the real link to a 0600 file instead", t_devlogsender_redacts_stdout_and_writes_0600_file)

    # =======================================================================
    section("2. Enumeration resistance — unknown vs known email must be identical")
    # =======================================================================
    _known_email = next_email("already-registered")
    # D7 (2026-07-30 review): POST /auth/request no longer touches UserStore
    # at all (see the module docstring's "DEFERRED ACCOUNT CREATION"
    # section), so a real user row only exists after an actual verify —
    # sign_in() (request + verify) is what makes `_known_email` genuinely
    # "already registered" rather than merely "has a token on file".
    sign_in(main_srv, _known_email, next_fake_ip())

    def t_unknown_gets_neutral_302():
        status, headers_list, body = http_request(
            main_srv.port, "POST", "/auth/request", form={"email": next_email("never-seen")},
            headers={"X-Forwarded-For": next_fake_ip()},
        )
        check(status == 302, f"got {status}")
        check(header(headers_list, "Location") == "/login?sent=1", "expected /login?sent=1")

    test("unknown address gets 302 -> /login?sent=1", t_unknown_gets_neutral_302)

    def t_known_and_unknown_are_byte_identical():
        s_unk, h_unk, b_unk = http_request(
            main_srv.port, "POST", "/auth/request", form={"email": next_email("unknown2")},
            headers={"X-Forwarded-For": next_fake_ip()},
        )
        s_known, h_known, b_known = http_request(
            main_srv.port, "POST", "/auth/request", form={"email": _known_email},
            headers={"X-Forwarded-For": next_fake_ip()},
        )
        check(s_unk == s_known, f"status differs: unknown={s_unk} known={s_known}")
        check(header(h_unk, "Location") == header(h_known, "Location"), "Location differs")
        check(header(h_unk, "Content-Length") == header(h_known, "Content-Length"), "Content-Length differs")
        check(b_unk == b_known == b"", "expected an empty body on both")

    test("known (already-registered) address gets the IDENTICAL response shape", t_known_and_unknown_are_byte_identical)

    def t_malformed_email_still_neutral():
        status, headers_list, _body = http_request(
            main_srv.port, "POST", "/auth/request", form={"email": "not-an-email-at-all"},
            headers={"X-Forwarded-For": next_fake_ip()},
        )
        check(status == 302, f"got {status}")
        check(header(headers_list, "Location") == "/login?sent=1", "expected /login?sent=1")

    test("malformed (non-email) input still gets the same neutral 302", t_malformed_email_still_neutral)

    def t_timing_class_known_vs_unknown():
        """D7 (2026-07-30 review) note: POST /auth/request no longer calls
        UserStore.find_or_create() at all — the only disk write on this
        path is TokenStore.issue() (always exactly one write, whether or
        not this email had prior tokens; see that method's own comment),
        for a known and an unknown address alike. This test is a coarse
        sanity check that removing the old find_or_create()-based
        asymmetry didn't introduce a NEW one; it is not a rigorous
        side-channel proof either way."""

        def timed_samples(email_fn, n):
            times = []
            for _ in range(n):
                t0 = time.perf_counter()
                http_request(
                    main_srv.port, "POST", "/auth/request", form={"email": email_fn()},
                    headers={"X-Forwarded-For": next_fake_ip()},
                )
                times.append(time.perf_counter() - t0)
            return times

        samples_unknown = timed_samples(lambda: next_email("timing-unknown"), 8)
        samples_known = timed_samples(lambda: _known_email, 8)
        avg_unknown = sum(samples_unknown) / len(samples_unknown)
        avg_known = sum(samples_known) / len(samples_known)
        median_unknown = statistics.median(samples_unknown)
        median_known = statistics.median(samples_known)
        check(avg_unknown > 0 and avg_known > 0, "expected nonzero timings")
        ratio = median_known / median_unknown if median_unknown > 0 else float("inf")
        check(0.15 <= ratio <= 6.0, f"median_known={median_known * 1000:.3f}ms median_unknown={median_unknown * 1000:.3f}ms "
                                     f"ratio={ratio:.2f} outside the generous [0.15, 6.0] sanity band")
        return (f"median unknown={median_unknown * 1000:.3f}ms median known={median_known * 1000:.3f}ms "
                f"(ratio {ratio:.2f}); avg unknown={avg_unknown * 1000:.3f}ms avg known={avg_known * 1000:.3f}ms — "
                "a coarse sanity check, not a rigorous side-channel proof")

    test("coarse timing class: known vs unknown address latency within the same order of magnitude", t_timing_class_known_vs_unknown)

    # =======================================================================
    section("3. Magic-link verify — happy path, single-use, tamper, malformed")
    # =======================================================================
    _su_email = next_email("single-use")
    _su_ip = next_fake_ip()
    _su_link = request_link(main_srv, _su_email, _su_ip)
    _su_token = token_from_link(_su_link)
    _su_state = {}  # carries the cookie from the first (valid) verify to the next test

    def t_valid_token_signs_in():
        status, headers_list, _body = verify(main_srv, _su_token, next_fake_ip())
        check(status == 302, f"expected 302, got {status}")
        check(header(headers_list, "Location") == "/", f"expected redirect to /, got {header(headers_list, 'Location')!r}")
        cookie = session_cookie(headers_list)
        check(cookie is not None, "expected a pinball_session cookie")
        _su_state["cookie"] = cookie
        return f"uid (from cookie) starts with: {cookie.split('.')[0][:8]}…"

    test("valid token -> 302 -> / with a session cookie", t_valid_token_signs_in)

    def t_whoami_and_achievements_work_after_verify():
        cookie = _su_state["cookie"]
        s1, _h1, b1 = http_request(main_srv.port, "GET", "/whoami", headers={"Cookie": f"pinball_session={cookie}"})
        check(s1 == 200, f"/whoami -> {s1}, want 200")
        check(b1.startswith(b'{"user":'), f"unexpected /whoami body: {b1!r}")
        s2, _h2, b2 = http_request(main_srv.port, "GET", "/api/achievements", headers={"Cookie": f"pinball_session={cookie}"})
        check(s2 == 200, f"/api/achievements -> {s2}, want 200")
        check(b2 == b"{}", f"expected an empty progress blob for a brand-new user, got {b2!r}")

    test("session issued by verify works for /whoami and /api/achievements", t_whoami_and_achievements_work_after_verify)

    def t_second_verify_of_same_token_fails_used():
        # D6 fix (2026-07-30 security review): "used" now renders as 410
        # Gone, not 401 — a replayed link is completely routine (double-
        # click, re-opened email) and must NOT feed the fail2ban jail that
        # watches this service's 401s. See the module docstring's D6 note.
        status, _headers_list, body = verify(main_srv, _su_token, next_fake_ip())
        check(status == 410, f"expected 410 on replay, got {status}")
        check(b"already been used" in body or b"already-used" in body or b"used" in body.lower(),
              "expected the friendly 'already used' page")
        check(b"Traceback" not in body, "must never be a stack trace")

    test("re-using the SAME token a second time (double-click / replay) fails as 'used' -> 410", t_second_verify_of_same_token_fails_used)

    def t_tampered_verifier_rejected_original_still_intact():
        # Issue a FRESH token so this test doesn't depend on _su_token already
        # being consumed by the test above.
        email = next_email("tamper")
        ip = next_fake_ip()
        link = request_link(main_srv, email, ip)
        token = token_from_link(link)
        selector, verifier = token.split(".", 1)
        # Flip one character in the verifier — same length, same alphabet
        # position, definitely a different value.
        flipped_char = "A" if verifier[0] != "A" else "B"
        tampered = selector + "." + flipped_char + verifier[1:]
        status, _headers_list, body = verify(main_srv, tampered, next_fake_ip())
        check(status == 401, f"expected 401 for a tampered verifier, got {status}")
        check(b"Traceback" not in body, "must never be a stack trace")
        # The ORIGINAL, un-tampered token must still work — tampering must
        # not have corrupted or consumed the real stored record.
        status2, headers2, _body2 = verify(main_srv, token, next_fake_ip())
        check(status2 == 302, f"original token should still verify after a tampered sibling attempt, got {status2}")
        check(session_cookie(headers2) is not None, "expected a session cookie from the still-valid original token")

    test("tampered verifier is rejected; the real token is unaffected", t_tampered_verifier_rejected_original_still_intact)

    def t_malformed_tokens_get_friendly_401_not_crash():
        for bad_token, why in [
            ("", "empty token"),
            ("no-dot-at-all", "missing the selector.verifier separator"),
            ("sel.", "empty verifier"),
            (".ver", "empty selector"),
            ("x" * 400, "absurdly long garbage"),
            ("unknown-selector-xyz.someverifierthatdoesnotexist", "well-formed but unknown selector"),
        ]:
            status, _headers_list, body = verify(main_srv, bad_token, next_fake_ip())
            check(status == 401, f"[{why}] expected 401, got {status} for token={bad_token!r}")
            check(b"Traceback" not in body, f"[{why}] must never be a stack trace")
            check(len(body) > 0, f"[{why}] must never be a bare/empty 401 body")

    test("malformed/unknown tokens all get a friendly 401 page, never a crash or bare body", t_malformed_tokens_get_friendly_401_not_crash)

    def t_expired_reason_distinct_from_invalid():
        # Covered fully (with a real, short-TTL server) in section 6 below;
        # here we just confirm the /auth/verify route recognizes an
        # explicit "?token=" with a dot but zero real record as "invalid"
        # copy, not "expired" copy — i.e. the two friendly pages are
        # actually different text, not the same page duplicated.
        _status_i, _h_i, body_invalid = verify(main_srv, "nonexistent.selector-verifier-pair", next_fake_ip())
        check(b"valid" in body_invalid.lower(), "expected the 'invalid' copy (title contains 'valid')")
        check(b"expired" not in body_invalid.lower(), "an unknown selector must render as 'invalid', not 'expired'")

    test("'invalid' and 'expired' render visibly different copy (not the same page reused)", t_expired_reason_distinct_from_invalid)

    # =======================================================================
    section("4. CSRF — cross-origin POST /auth/request and PUT /api/achievements rejected")
    # =======================================================================

    def t_cross_origin_auth_request_rejected():
        status, _headers_list, _body = http_request(
            main_srv.port, "POST", "/auth/request",
            form={"email": next_email("csrf")},
            headers={"X-Forwarded-For": next_fake_ip(), "Sec-Fetch-Site": "cross-site"},
        )
        check(status == 401, f"expected 401 for a cross-site POST /auth/request, got {status}")

    test("POST /auth/request with Sec-Fetch-Site: cross-site -> 401 (fail2ban signal preserved)", t_cross_origin_auth_request_rejected)

    def t_cross_origin_origin_header_mismatch_rejected():
        status, _headers_list, _body = http_request(
            main_srv.port, "POST", "/auth/request",
            form={"email": next_email("csrf2")},
            headers={"X-Forwarded-For": next_fake_ip(), "Origin": "https://evil.example", "Host": "pinball-genie.com"},
        )
        check(status == 401, f"expected 401 for an Origin/Host mismatch, got {status}")

    test("POST /auth/request with a mismatched Origin header -> 401", t_cross_origin_origin_header_mismatch_rejected)

    def t_same_origin_auth_request_still_works():
        status, _headers_list, _body = http_request(
            main_srv.port, "POST", "/auth/request",
            form={"email": next_email("notcsrf")},
            headers={"X-Forwarded-For": next_fake_ip(), "Sec-Fetch-Site": "same-origin"},
        )
        check(status == 302, f"expected 302 for a same-origin request, got {status}")

    test("POST /auth/request with Sec-Fetch-Site: same-origin still gets the neutral 302", t_same_origin_auth_request_still_works)

    def t_cross_origin_achievements_put_rejected():
        email = next_email("csrf-put")
        ip = next_fake_ip()
        cookie = sign_in(main_srv, email, ip)
        status, _headers_list, _body = http_request(
            main_srv.port, "PUT", "/api/achievements",
            headers={
                "Cookie": f"pinball_session={cookie}",
                "Sec-Fetch-Site": "cross-site",
                "Content-Type": "application/json",
                "Content-Length": "2",
            },
        )
        check(status == 403, f"expected 403 for a cross-site PUT /api/achievements, got {status}")

    test("PUT /api/achievements from a cross-site context -> 403", t_cross_origin_achievements_put_rejected)

    # =======================================================================
    section("5. Two users isolated; deletion actually deletes; export contents")
    # =======================================================================

    def put_achievements(cookie, doc):
        """Raw http.client PUT with a real JSON body — http_request()'s
        `form=` only knows how to urlencode a dict as
        application/x-www-form-urlencoded, which /api/achievements does not
        accept (it expects a JSON body — see _put_achievements)."""
        body_bytes = json.dumps(doc).encode("utf-8")
        conn = http.client.HTTPConnection("127.0.0.1", main_srv.port, timeout=10)
        try:
            conn.request("PUT", "/api/achievements", body=body_bytes, headers={
                "Cookie": f"pinball_session={cookie}",
                "Sec-Fetch-Site": "same-origin",
                "Content-Type": "application/json",
                "Content-Length": str(len(body_bytes)),
                "Connection": "close",
            })
            resp = conn.getresponse()
            resp.read()
            return resp.status
        finally:
            conn.close()

    def t_two_users_isolated():
        email_a = next_email("alice")
        email_b = next_email("bob")
        cookie_a = sign_in(main_srv, email_a, next_fake_ip())
        cookie_b = sign_in(main_srv, email_b, next_fake_ip())
        check(cookie_a.split(".")[0] != cookie_b.split(".")[0], "two different users must get two different uids")

        put_status = put_achievements(cookie_a, {"jaws": {"first_shark": 1234567}})
        check(put_status == 204, f"expected 204 from a valid same-origin PUT, got {put_status}")

        get_a = http_request(main_srv.port, "GET", "/api/achievements", headers={"Cookie": f"pinball_session={cookie_a}"})[2]
        get_b = http_request(main_srv.port, "GET", "/api/achievements", headers={"Cookie": f"pinball_session={cookie_b}"})[2]
        check(b"first_shark" in get_a, "alice's own achievements PUT must be readable back")
        check(b"first_shark" not in get_b, "bob must NOT see alice's achievements — per-user isolation broken")
        check(get_b == b"{}", f"bob's own blob should still be empty, got {get_b!r}")

    test("two distinct users: different uids, achievements never cross between them", t_two_users_isolated)

    def t_deletion_actually_deletes():
        email = next_email("deleteme")
        ip = next_fake_ip()
        cookie = sign_in(main_srv, email, ip)
        uid = cookie.split(".")[0]  # unescaped: token_urlsafe's alphabet never needs cookie-field escaping

        # Save some achievements so we can prove the blob is gone afterward.
        put_status = put_achievements(cookie, {"x": {"y": 1}})
        check(put_status == 204, f"setup PUT failed: {put_status}")
        achievements_path = os.path.join(main_srv.state_dir, "achievements", f"{uid}.json")
        check(os.path.exists(achievements_path), f"setup: expected {achievements_path} to exist before deletion")

        del_status, del_headers, del_body = http_request(
            main_srv.port, "POST", "/auth/delete",
            headers={"Cookie": f"pinball_session={cookie}", "Sec-Fetch-Site": "same-origin"},
        )
        check(del_status == 200, f"POST /auth/delete -> {del_status}, want 200")
        check(b'"deleted":true' in del_body, f"expected a deletion confirmation body, got {del_body!r}")
        set_cookie = header(del_headers, "Set-Cookie")
        check(set_cookie is not None and set_cookie.startswith("pinball_session=;"),
              f"expected the session cookie to be cleared (Max-Age=0), got {set_cookie!r}")

        # The OLD cookie must be dead everywhere now — but D6 (2026-07-30
        # review) means "dead" is 200 {"user": null}, not a bare 401: a
        # signed-out /whoami is routine, not evidence of abuse (see that
        # fix's own note on the module docstring and _handle_get). The
        # session is still verifiably gone: /api/achievements (which keeps
        # a REAL 401) is checked right below for exactly that reason.
        status_after, _h, body_after = http_request(main_srv.port, "GET", "/whoami", headers={"Cookie": f"pinball_session={cookie}"})
        check(status_after == 200, f"expected 200 (signed-out shape) for a deleted user's old cookie, got {status_after}")
        check(body_after == b'{"user":null}', f"expected a null-user body for a deleted user's old cookie, got {body_after!r}")
        achievements_after = http_request(main_srv.port, "GET", "/api/achievements", headers={"Cookie": f"pinball_session={cookie}"})[0]
        check(achievements_after == 401, f"expected a REAL 401 from /api/achievements for a deleted user's old cookie, got {achievements_after}")

        # The achievements blob file must actually be gone from disk.
        check(not os.path.exists(achievements_path), f"expected {achievements_path} to be deleted from disk")

        # Requesting a NEW link for the SAME email creates a genuinely NEW
        # account (different uid) — proves the old row is truly gone, not
        # just flagged inactive.
        new_cookie = sign_in(main_srv, email, next_fake_ip())
        check(new_cookie.split(".")[0] != uid, "re-registering after deletion must mint a NEW uid")

    test("POST /auth/delete removes the user row, achievements file, and kills the session", t_deletion_actually_deletes)

    def t_whoami_signed_out_is_200_not_401():
        status, _h, body = http_request(main_srv.port, "GET", "/whoami")
        check(status == 200, f"expected 200 for a signed-out /whoami, got {status}")
        check(body == b'{"user":null}', f"expected a null-user body for a signed-out /whoami, got {body!r}")

    test("D6: a signed-out GET /whoami is 200 with a null user, not a bare 401 (fail2ban jail exemption)", t_whoami_signed_out_is_200_not_401)

    def t_achievements_signed_out_still_401():
        status, _h, _b = http_request(main_srv.port, "GET", "/api/achievements")
        check(status == 401, f"expected a REAL 401 for signed-out /api/achievements, got {status}")

    test("D6: /api/achievements keeps a REAL 401 when signed out (still a genuine fail2ban signal)", t_achievements_signed_out_still_401)

    def t_export_contents():
        email = next_email("exportme")
        ip = next_fake_ip()
        cookie = sign_in(main_srv, email, ip)
        put_status = put_achievements(cookie, {"jaws": {"boat_1": 42}})
        check(put_status == 204, f"setup PUT failed: {put_status}")

        status, _headers_list, body = http_request(
            main_srv.port, "GET", "/auth/export", headers={"Cookie": f"pinball_session={cookie}"},
        )
        check(status == 200, f"GET /auth/export -> {status}, want 200")
        doc = json.loads(body)
        check(doc.get("email") == email, f"expected email {email!r} in export, got {doc.get('email')!r}")
        check("user_id" in doc, "expected user_id in export")
        check("created_at" in doc, "expected created_at in export")
        check(doc.get("achievements", {}).get("jaws", {}).get("boat_1") == 42, "expected the saved achievement in the export")

    test("GET /auth/export returns email, timestamps, and the real achievements blob", t_export_contents)

    def t_export_and_delete_require_session():
        status_export, _h1, _b1 = http_request(main_srv.port, "GET", "/auth/export")
        check(status_export == 401, f"unauth GET /auth/export -> {status_export}, want 401")
        status_delete, _h2, _b2 = http_request(main_srv.port, "POST", "/auth/delete")
        check(status_delete == 401, f"unauth POST /auth/delete -> {status_delete}, want 401")

    test("GET /auth/export and POST /auth/delete both 401 with no session", t_export_and_delete_require_session)

    def t_state_files_are_0600():
        """D12 regression (2026-07-30 security review): users.json (every
        registered email in cleartext) and magic_tokens.json (every live
        bearer credential's hash) were both observed world-readable
        (-rw-r--r--) under the default umask — a regression from the
        retired auth.json's 0640. Force at least one of each to exist
        regardless of what ran earlier in this file, then check the mode."""
        sign_in(main_srv, next_email("perm-check"), next_fake_ip())
        for fname in ("users.json", "magic_tokens.json"):
            path = os.path.join(main_srv.state_dir, fname)
            check(os.path.exists(path), f"expected {path} to exist")
            mode = os.stat(path).st_mode & 0o777
            check(mode == 0o600, f"expected {fname} to be 0600, got {oct(mode)}")

    test("D12: users.json and magic_tokens.json are written 0600, not the umask default", t_state_files_are_0600)

    def t_dev_magic_link_file_is_0600_and_stdout_stays_clean():
        path = os.path.join(main_srv.state_dir, "dev_magic_links.jsonl")
        check(os.path.exists(path), f"expected {path} to exist (DevLogSender has sent by now)")
        mode = os.stat(path).st_mode & 0o777
        check(mode == 0o600, f"expected dev_magic_links.jsonl to be 0600, got {oct(mode)}")
        log = main_srv.log_text()
        check("DEV MAGIC LINK for" not in log, "the OLD log format (which printed the live token+email) must be fully retired")
        check("auth/verify?token=" not in log, "a full magic-link URL must never appear in this service's own stdout log")

    test("D4/D12: the dev magic-link file is 0600 and no live token/email ever reaches stdout", t_dev_magic_link_file_is_0600_and_stdout_stays_clean)

    # =======================================================================
    section("6. Login page states — default form vs 'check your inbox'")
    # =======================================================================

    def t_login_default_shows_form_not_sent():
        status, _headers_list, body = http_request(main_srv.port, "GET", "/login")
        check(status == 200, f"GET /login -> {status}")
        check(b'class="card "' in body or b'class="card"' in body, f"expected the default (non-sent) state, got: {body[:400]!r}")
        # NOT a bare "is-sent" substring check: login.html's own header
        # comment explains the marker mechanism in prose and literally
        # contains the words `"is-sent"` regardless of which state is being
        # served — see that file's header. The precise, state-bearing signal
        # is the CLASS ATTRIBUTE value, not the word appearing anywhere in
        # the byte stream.
        check(b'class="card is-sent"' not in body, "a clean GET /login must not carry the is-sent CLASS on .card")
        check(b'class="card is-limited"' not in body, "a clean GET /login must not carry the is-limited CLASS on .card")
        check(b"Send me a link" in body, "expected the email form's submit button text")
        check(b'type="password"' not in body, "there must be NO password field anywhere on this page")
        # D5 (2026-07-30 review) added a SECOND template slot (RETRY_MARKER)
        # to login.html; it must always be substituted, even on a clean
        # /login where the .limited-panel it belongs to stays hidden — a
        # raw, unsubstituted marker leaking into a served page is exactly
        # the incident class login.css's own header comment warns about
        # (see the module docstring's STATE_MARKER block). Checks for the
        # exact marker TOKENS, not a bare "%%" substring — login.html's own
        # prose legitimately contains "%%-delimited" describing the
        # mechanism, which is not itself a leaked marker.
        check(b"%%STATE%%" not in body, "the STATE_MARKER token must never survive templating")
        check(b"%%RETRY_MIN%%" not in body, "the RETRY_MARKER token must never survive templating")

    test("clean GET /login shows the email form, no password field, no is-sent/is-limited state, no raw marker", t_login_default_shows_form_not_sent)

    def t_login_sent_state():
        status, _headers_list, body = http_request(main_srv.port, "GET", "/login?sent=1")
        check(status == 200, f"GET /login?sent=1 -> {status}")
        # The precise, state-bearing signal (see the default-state test's
        # comment for why a bare "is-sent" substring check is too weak —
        # login.html's header comment contains that word unconditionally).
        check(b'class="card is-sent"' in body, "expected the is-sent CLASS on .card when ?sent=1")
        check(b"Check your inbox" in body, "expected the confirmation copy")

    test("GET /login?sent=1 shows the 'check your inbox' confirmation state", t_login_sent_state)

    def t_login_preserves_skip_and_instagram_and_legal():
        _status, _headers_list, body = http_request(main_srv.port, "GET", "/login")
        check(b"Skip sign-in" in body, "expected the 'skip sign-in' escape hatch to survive the Phase 5 rewrite")
        check(b"instagram.com/pinballgenie" in body, "expected the Instagram CTA to survive the rewrite")
        check(b'href="/privacy"' in body and b'href="/terms"' in body, "expected the legal links row to survive the rewrite")
        check(b"<style" not in body, "no inline <style> — CSP style-src is 'self' only")
        check(b"<script>" not in body, "no inline <script> (other than the external src= tag) — CSP script-src is 'self' only")

    test("login page keeps skip-sign-in link, Instagram CTA, and legal links; still CSP-clean", t_login_preserves_skip_and_instagram_and_legal)

    def t_signed_in_visiting_login_redirects_home():
        email = next_email("already-signed-in")
        cookie = sign_in(main_srv, email, next_fake_ip())
        status, headers_list, _body = http_request(main_srv.port, "GET", "/login", headers={"Cookie": f"pinball_session={cookie}"})
        check(status == 302, f"expected 302 for an already-signed-in visitor, got {status}")
        check(header(headers_list, "Location") == "/", "expected redirect to /")

    test("an already-signed-in visitor hitting /login is redirected to /", t_signed_in_visiting_login_redirects_home)

finally:
    main_srv.stop()


# ===========================================================================
section("7. Rate limiting — per-IP, per-subnet, per-(IP+email), global (dedicated fresh servers)")
# ===========================================================================
# Each sub-test below gets its OWN freshly-spawned server so its counters
# start at exactly zero — see this file's header comment for why sharing a
# server across these three would make the exact trip-point non-deterministic.


def t_per_ip_cap_trips():
    srv = ServerProc(label="per-ip")
    try:
        ip = "10.77.0.1"
        statuses = []
        for i in range(9):  # REQUEST_LIMIT_PER_IP_MAX is 8
            status, _h, _b = http_request(
                srv.port, "POST", "/auth/request", form={"email": next_email(f"ip-cap-{i}")},
                headers={"X-Forwarded-For": ip},
            )
            statuses.append(status)
        check(statuses[:8] == [302] * 8, f"expected the first 8 requests from one IP to succeed, got {statuses[:8]}")
        check(statuses[8] == 429, f"expected the 9th request from the same IP within the window to be 429, got {statuses[8]}")
    finally:
        srv.stop()


test("per-IP cap: 9th request from the same IP in the window -> 429", t_per_ip_cap_trips)


def t_429_has_real_body_and_retry_after():
    """D5 regression (2026-07-30 security review): every rate-limit
    rejection used to be `_plain_status(429)` — Content-Length: 0, no
    body — which reads to a real visitor as the site being down, not
    "slow down". A tripped cap must now render the real login page's
    "too many attempts" state, plus a real Retry-After header."""
    srv = ServerProc(label="429-body")
    try:
        ip = "10.95.0.1"
        last_status, last_headers, last_body = None, None, None
        for i in range(9):
            last_status, last_headers, last_body = http_request(
                srv.port, "POST", "/auth/request", form={"email": next_email(f"body-check-{i}")},
                headers={"X-Forwarded-For": ip},
            )
        check(last_status == 429, f"expected the 9th request to trip the per-IP cap, got {last_status}")
        check(len(last_body) > 0, "expected a real HTML body on a 429, not Content-Length: 0")
        check(b"too many attempts" in last_body.lower(), f"expected human-readable rate-limit copy, got {last_body[:300]!r}")
        check(b'class="card is-limited"' in last_body, "expected the is-limited CLASS on .card for a rate-limited response")
        retry_after = header(last_headers, "Retry-After")
        check(retry_after is not None and retry_after.isdigit() and int(retry_after) > 0,
              f"expected a positive integer Retry-After header, got {retry_after!r}")
    finally:
        srv.stop()


test("D5: a tripped rate limit renders the real login page with retry guidance, not a blank 429", t_429_has_real_body_and_retry_after)


def t_per_email_cap_trips_same_requester():
    srv = ServerProc(label="per-email-same-ip")
    try:
        email = next_email("email-cap")
        ip = "10.78.9.9"
        statuses = []
        for i in range(4):  # REQUEST_LIMIT_PER_EMAIL_MAX is 3
            status, _h, _b = http_request(
                srv.port, "POST", "/auth/request", form={"email": email},
                headers={"X-Forwarded-For": ip},
            )
            statuses.append(status)
        check(statuses[:3] == [302] * 3, f"expected the first 3 requests for one email (same requester) to succeed, got {statuses[:3]}")
        check(statuses[3] == 429, f"expected the 4th request for the same email+requester in the window to be 429, got {statuses[3]}")
    finally:
        srv.stop()


test("per-email cap (same requester IP): 4th request for the same address+IP in the window -> 429", t_per_email_cap_trips_same_requester)


def t_per_email_cap_does_not_punish_other_requesters():
    """D5 fix (2026-07-30 security review): the per-email cap used to be
    keyed on the address ALONE — anyone who merely knew a victim's email
    could send REQUEST_LIMIT_PER_EMAIL_MAX requests from 3 different IPs
    and lock the REAL owner out of requesting their own sign-in link for
    the rest of the window, without ever touching the victim's inbox. It's
    now keyed on (requester IP, email): a fresh requester IP against the
    same email always gets its own fresh budget."""
    srv = ServerProc(label="per-email-fair")
    try:
        email = next_email("email-cap-fair")
        statuses = []
        # "Attacker" burns 3 requests against `email`, each from a
        # DIFFERENT IP — this alone must NOT lock the address out for
        # everyone.
        for i in range(3):
            status, _h, _b = http_request(
                srv.port, "POST", "/auth/request", form={"email": email},
                headers={"X-Forwarded-For": f"10.78.10.{i + 1}"},
            )
            statuses.append(status)
        check(all(s == 302 for s in statuses), f"expected the attacker's first 3 requests (each from a distinct IP) to succeed, got {statuses}")

        # The real owner, from THEIR OWN never-before-seen IP, must still
        # get through — this is the property under test.
        victim_status, _h, _b = http_request(
            srv.port, "POST", "/auth/request", form={"email": email},
            headers={"X-Forwarded-For": "10.78.10.200"},
        )
        check(victim_status == 302, f"expected the real owner's request from a fresh IP to succeed, got {victim_status}")
    finally:
        srv.stop()


test("D5: per-email cap no longer punishes the victim — a fresh requester IP against the same email is unaffected by other IPs' requests", t_per_email_cap_does_not_punish_other_requesters)


def t_subnet_cap_isolates_abusive_24():
    """D5 fix (2026-07-30 security review): the global cap used to be the
    ONLY thing standing between a handful of IPs and a site-wide lockout —
    reproduced, ~8 IPs sharing a /24 (each individually under its own
    per-IP cap) could collectively exhaust the 60/hour global bucket and
    lock out sign-in for every OTHER visitor on the internet.
    REQUEST_LIMIT_SUBNET now catches this: a burst concentrated in one /24
    trips ITS OWN, much lower cap well before it can meaningfully dent the
    global bucket other subnets rely on."""
    srv = ServerProc(label="subnet")
    try:
        statuses = []
        # Each request from a DISTINCT IP so no single IP's own per-IP cap
        # trips first, but all within the SAME /24 (10.90.5.0/24).
        #
        # Derived from the constant, NOT hardcoded (2026-07-31): this test used
        # to assert `trip_index == 24` against a then-24 subnet cap, so it broke
        # the moment PG-11 lowered that cap to 12 — a false failure about a
        # deliberate change. The PROPERTY under test is "a burst inside one /24
        # trips that subnet's own cap, and other subnets are unaffected", which
        # is true at any cap value.
        subnet_cap = pinball_auth.REQUEST_LIMIT_PER_SUBNET_MAX
        for i in range(subnet_cap + 6):
            status, _h, _b = http_request(
                srv.port, "POST", "/auth/request", form={"email": next_email(f"subnet-abuse-{i}")},
                headers={"X-Forwarded-For": f"10.90.5.{i + 1}"},
            )
            statuses.append(status)
        check(429 in statuses, "expected the shared /24 to eventually trip its own subnet cap")
        trip_index = statuses.index(429)
        check(trip_index == subnet_cap,
              f"expected the subnet cap to trip at request #{subnet_cap + 1} (index {subnet_cap}), "
              f"tripped at index {trip_index}")

        # A request from a COMPLETELY DIFFERENT /24 must still succeed —
        # proves the trip was scoped to the abusive /24, not site-wide.
        other_status, _h, _b = http_request(
            srv.port, "POST", "/auth/request", form={"email": next_email("other-subnet")},
            headers={"X-Forwarded-For": "172.20.1.1"},
        )
        check(other_status == 302, f"expected a different /24 to be unaffected by the first /24's trip, got {other_status}")
    finally:
        srv.stop()


test("D5: one /24 tripping its subnet cap does not lock sign-in site-wide for a different /24", t_subnet_cap_isolates_abusive_24)


def t_global_cap_leaves_a_per_subnet_reserve():
    """NEW-3 (2026-07-30, SECOND review pass) — REWRITTEN.

    This test previously asserted that request #61 from a brand-new /24 got a
    429, i.e. that exhausting the global bucket locked out *everyone*. That
    assertion encoded a real defect as if it were the spec. The
    re-verification reproduced the consequence: 9 IPs spread over 3 /24s
    sending 60 requests in seconds left every other visitor on the internet —
    8.8.8.8, 1.1.1.1, an unrelated CGNAT address — holding a blank-walled
    `429 Retry-After: 3600` on a site whose sign-in they had never touched.
    Sixty requests is not an attack worth taking sign-in down for.

    The contract now: the global bucket still caps the SHARED pool (that pool
    is what protects the send quota), but once it is spent, a subnet that has
    barely used the service falls back to a small private reserve the shared
    pool cannot consume. So a flood costs the attacker subnets and cannot
    reach into a stranger's reserve.

    Both halves matter and both are asserted here — an unbounded reserve would
    simply move the quota hole rather than close the availability one.
    """
    srv = ServerProc(label="global")
    try:
        # Spend the entire shared pool. Each request uses its own /24 so that
        # neither the per-IP nor the per-subnet cap can trip first — this
        # isolates the GLOBAL cap specifically.
        statuses = []
        for i in range(60):
            status, _h, _b = http_request(
                srv.port, "POST", "/auth/request", form={"email": next_email(f"global-cap-{i}")},
                headers={"X-Forwarded-For": f"10.79.{i}.1"},
            )
            statuses.append(status)
        check(all(s == 302 for s in statuses), "expected all 60 requests within the global cap to be accepted")

        # THE POINT: the shared pool is now spent, but an untouched subnet
        # must still be able to sign in.
        fresh = []
        for i in range(4):
            status, _h, _b = http_request(
                srv.port, "POST", "/auth/request", form={"email": next_email(f"reserve-a-{i}")},
                headers={"X-Forwarded-For": "198.51.100.7"},
            )
            fresh.append(status)
        check(
            fresh[0] == 302,
            f"a visitor from an UNTOUCHED subnet must still be able to sign in after the global pool is spent — got {fresh[0]} (this is the site-wide lockout NEW-3 fixed)",
        )

        # ...but the reserve is bounded, or it would just be a quota hole with
        # extra steps. REQUEST_LIMIT_RESERVE_MAX is 2 per subnet per hour.
        check(
            fresh.count(302) == 2 and fresh[2:] == [429, 429],
            f"expected exactly 2 reserve grants for one subnet then 429s, got {fresh}",
        )

        # A DIFFERENT untouched subnet has its own reserve — one subnet
        # spending its reserve must not consume another's.
        other, _h, _b = http_request(
            srv.port, "POST", "/auth/request", form={"email": next_email("reserve-b")},
            headers={"X-Forwarded-For": "192.0.2.44"},
        )
        check(other == 302, f"a second untouched subnet must have its own reserve, got {other}")
    finally:
        srv.stop()


test("NEW-3: global cap spends the shared pool but leaves each subnet a bounded reserve (no site-wide lockout)", t_global_cap_leaves_a_per_subnet_reserve)


def t_signout_route():
    """NEW-1 (2026-07-30, second review pass). ui/account.ts shipped a Sign
    out button whose copy promises the shared-computer case, calling
    POST /auth/signout — a route that did not exist and returned 404, leaving
    the user signed in while the UI implied otherwise. A control that claims
    to protect a shared computer and silently does nothing is worse than no
    control, because the user stops looking for another way out. Guards
    mirror /auth/delete deliberately; the account must SURVIVE (that is the
    whole difference from delete)."""
    srv = ServerProc(label="signout")
    try:
        # Idempotent with no session — a double-tap or an already-expired
        # cookie must not look like an error.
        status, _h, _b = http_request(
            srv.port, "POST", "/auth/signout", form={},
            headers={"Sec-Fetch-Site": "same-origin"},
        )
        check(status == 204, f"signout with no session should be a no-op 204, got {status}")

        email = next_email("signout")
        ip = next_fake_ip()
        cookie = sign_in(srv, email, ip)
        status, _h, body = http_request(
            srv.port, "GET", "/whoami", headers={"Cookie": f"pinball_session={cookie}"}
        )
        check(status == 200 and b"null" not in body, f"expected a live session before signout, got {body!r}")

        # CSRF: a hostile page must not be able to force-sign-out a visitor.
        status, _h, _b = http_request(
            srv.port, "POST", "/auth/signout", form={},
            headers={"Cookie": f"pinball_session={cookie}", "Sec-Fetch-Site": "cross-site"},
        )
        check(status == 403, f"cross-origin signout must be refused, got {status}")
        _s, _h, body = http_request(
            srv.port, "GET", "/whoami", headers={"Cookie": f"pinball_session={cookie}"}
        )
        check(b"null" not in body, "a refused cross-origin signout must leave the session intact")

        status, headers_list, _b = http_request(
            srv.port, "POST", "/auth/signout", form={},
            headers={"Cookie": f"pinball_session={cookie}", "Sec-Fetch-Site": "same-origin"},
        )
        check(status == 204, f"same-origin signout should be 204, got {status}")

        # WHAT SIGN-OUT ACTUALLY GUARANTEES, and why this assertion is about
        # the Set-Cookie header rather than about a later request.
        #
        # Sessions here are STATELESS signed cookies: validity is a signature
        # plus an expiry, with no server-side session row to delete. So
        # "sign out" is precisely "tell this browser to drop the cookie" —
        # which is what the account page's copy claims ("ends your session on
        # THIS DEVICE — useful on a shared or public computer"), and which
        # fully covers that threat: the next person at that machine has no
        # cookie to send.
        #
        # It does NOT retroactively invalidate a copy of the cookie value that
        # someone captured beforehand; such a copy keeps validating until its
        # 30-day expiry. An earlier draft of this test asserted otherwise —
        # replaying the captured value and expecting 401 — and failed, because
        # it was asserting a property the design does not provide rather than
        # a bug in the implementation. Server-side revocation (a per-user
        # session epoch folded into the signed payload and bumped on sign-out,
        # which would also give "sign out everywhere") is a real improvement
        # and is deliberately NOT in this change; account deletion already
        # revokes everything, because the uid stops resolving.
        setc = [v for k, v in headers_list if k.lower() == "set-cookie"]
        check(
            any("Max-Age=0" in v for v in setc),
            f"signout must tell the browser to expire the session cookie, got {setc!r}",
        )
        check(
            any("HttpOnly" in v and "SameSite=Lax" in v for v in setc),
            f"the clearing cookie must carry the same flags as the real one, got {setc!r}",
        )

        # A browser that honoured that header sends no cookie at all — which
        # is the state a shared computer's next user is in.
        _s, _h, body = http_request(srv.port, "GET", "/whoami")
        check(b"null" in body, f"a visitor with no cookie must read as signed out, got {body!r}")

        # The ACCOUNT must survive — this is sign-out, not delete.
        again = sign_in(srv, email, next_fake_ip())
        status, _h, body = http_request(
            srv.port, "GET", "/whoami", headers={"Cookie": f"pinball_session={again}"}
        )
        check(status == 200 and b"null" not in body, "the account must still exist and be signed-in-able after signout")
    finally:
        srv.stop()


test("NEW-1: POST /auth/signout exists, is CSRF-guarded, idempotent, and keeps the account", t_signout_route)

# ===========================================================================
section("8. Token expiry (dedicated short-TTL server)")
# ===========================================================================


def t_token_expires():
    srv = ServerProc(label="short-ttl", env_overrides={"PINBALL_MAGIC_TTL_SECONDS": "1"})
    try:
        check("PINBALL_MAGIC_TTL_SECONDS overrides" in srv.log_text(), "expected the loud TTL-override warning at startup")
        email = next_email("expiring")
        ip = "10.80.0.1"
        link = request_link(srv, email, ip)
        token = token_from_link(link)
        time.sleep(1.5)  # past the 1-second TTL, comfortably inside test-suite patience
        status, _headers_list, body = verify(srv, token, "10.80.0.2")
        # D6 fix (2026-07-30 security review): expired now renders as 410
        # Gone, not 401 — see t_second_verify_of_same_token_fails_used's
        # identical note and the module docstring's D6 section.
        check(status == 410, f"expected 410 for an expired token, got {status}")
        check(b"expired" in body.lower(), "expected the 'expired' friendly page, not 'invalid' or 'used'")
        check(b"Traceback" not in body, "must never be a stack trace")
    finally:
        srv.stop()


test("a token past its TTL is rejected with the 'expired' friendly page", t_token_expires)


def t_ttl_override_never_silent():
    src = open(PINBALL_AUTH, "r", encoding="utf-8").read()
    check("must never be set on the production systemd unit" in src, "expected an explicit production warning near the TTL override")
    check("PINBALL_MAGIC_TTL_SECONDS" not in open(os.path.join(SERVER_DIR, "pinball-auth.service")).read(),
          "the production systemd unit must NOT set PINBALL_MAGIC_TTL_SECONDS")

test("the TTL test-override is never wired into the production systemd unit", t_ttl_override_never_silent)

# ===========================================================================
section("9. D2 — canonical public origin (Host-header injection can't choose the link's domain)")
# ===========================================================================


def t_validate_public_origin_unit():
    check(pinball_auth.validate_public_origin("https://pinball-genie.com") == "https://pinball-genie.com",
          "expected a clean https origin to validate and round-trip unchanged")
    check(pinball_auth.validate_public_origin("https://pinball-genie.com/") == "https://pinball-genie.com",
          "a bare trailing slash is an equivalent origin and should be accepted")
    for bad in [
        "http://pinball-genie.com",       # wrong scheme
        "https://pinball-genie.com/path", # a path
        "https://pinball-genie.com?x=1",  # a query
        "https://pinball-genie.com#frag", # a fragment
        "https://user:pass@pinball-genie.com",  # embedded userinfo
        "not-a-url",
        "",
        "ftp://pinball-genie.com",
        "https://",
    ]:
        got = pinball_auth.validate_public_origin(bad)
        check(got is None, f"expected {bad!r} to be rejected, got {got!r}")


test("D2: validate_public_origin accepts a clean https origin and rejects path/query/fragment/userinfo/wrong-scheme", t_validate_public_origin_unit)


def t_subnet_key_unit():
    check(pinball_auth.subnet_key("10.1.2.3") == pinball_auth.subnet_key("10.1.2.250"),
          "expected two addresses in the same /24 to share a bucket")
    check(pinball_auth.subnet_key("10.1.2.3") != pinball_auth.subnet_key("10.1.3.3"),
          "expected two addresses in different /24s to get different buckets")
    check(pinball_auth.subnet_key("not-an-ip") == "unparsed-ip",
          "expected a fixed sentinel bucket for unparseable input, so it can never collide with a real subnet")


test("D5: subnet_key() buckets IPv4 addresses by their containing /24", t_subnet_key_unit)


def _spawn_expect_fatal(extra_env, expect_substr, dev=False):
    """Spawns pinball_auth.py expecting it to exit non-zero at startup and
    print `expect_substr` — used for D2's "refuses to boot without a valid
    PINBALL_PUBLIC_ORIGIN" behavior, which by definition can't be observed
    through a healthy ServerProc."""
    port = free_port()
    state_dir = tempfile.mkdtemp(prefix="pg-auth-fatal-")
    try:
        secret_path = os.path.join(state_dir, "secret")
        with open(secret_path, "w", encoding="utf-8") as f:
            f.write(secrets.token_hex(32))
        env = os.environ.copy()
        env["PINBALL_AUTH_LOGIN"] = LOGIN_HTML
        env["PINBALL_STATE_DIR"] = state_dir
        env["PINBALL_AUTH_SECRET_FILE"] = secret_path
        env.setdefault("PINBALL_RESEND_KEY_FILE", os.path.join(state_dir, "no-such-key"))
        env.update(extra_env)
        args = [sys.executable, PINBALL_AUTH, "--port", str(port),
                "--root", APP_ROOT, "--data", DATA_DIR, "--state-dir", state_dir]
        if dev:
            args.append("--dev")
        proc = subprocess.Popen(args, cwd=SERVER_DIR, env=env, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True)
        try:
            out, _ = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, _ = proc.communicate()
        check(proc.returncode is not None and proc.returncode != 0,
              f"expected a non-zero exit for a FATAL startup condition, got {proc.returncode}; log:\n{out}")
        check(expect_substr in out, f"expected {expect_substr!r} in startup output; got:\n{out}")
    finally:
        shutil.rmtree(state_dir, ignore_errors=True)


def t_public_origin_required_outside_dev():
    _spawn_expect_fatal({}, "PINBALL_PUBLIC_ORIGIN is required", dev=False)


test("D2: non-dev startup with no PINBALL_PUBLIC_ORIGIN set refuses to boot", t_public_origin_required_outside_dev)


def t_public_origin_rejects_non_https():
    _spawn_expect_fatal({"PINBALL_PUBLIC_ORIGIN": "http://pinball-genie.com"}, "not a valid absolute", dev=False)


test("D2: non-dev startup with a non-https PINBALL_PUBLIC_ORIGIN refuses to boot", t_public_origin_rejects_non_https)


def t_public_origin_rejects_a_path():
    _spawn_expect_fatal({"PINBALL_PUBLIC_ORIGIN": "https://pinball-genie.com/some/path"}, "not a valid absolute", dev=False)


test("D2: non-dev startup with a PINBALL_PUBLIC_ORIGIN containing a path refuses to boot", t_public_origin_rejects_a_path)


def t_host_header_cannot_choose_link_origin():
    """D2 regression, end-to-end (2026-07-30 security review): with a
    properly configured PINBALL_PUBLIC_ORIGIN, a spoofed Host header must
    have ZERO effect on the emailed magic-link's domain — the exact
    one-click-account-takeover vector the fix closes."""
    srv = ServerProc(label="d2-host-injection", dev=False,
                      env_overrides={"PINBALL_PUBLIC_ORIGIN": "https://pinball-genie.com"})
    try:
        email = next_email("host-injection")
        status, _h, _b = http_request(
            srv.port, "POST", "/auth/request", form={"email": email},
            headers={"Host": "evil.example", "X-Forwarded-For": "127.0.0.1"},
        )
        check(status == 302, f"expected 302, got {status}")
        link = srv.link_for(email)
        check(link is not None, f"expected a dev magic-link record for {email}")
        check(link.startswith("https://pinball-genie.com/auth/verify"),
              f"expected the link to use PINBALL_PUBLIC_ORIGIN regardless of a spoofed Host header, got {link!r}")
        check("evil.example" not in link, "the attacker-controlled Host header must never appear in the emailed link")
    finally:
        srv.stop()


test("D2: a spoofed Host header cannot change the emailed magic-link's origin", t_host_header_cannot_choose_link_origin)

# ===========================================================================
section("10. D7 — account rows are created at VERIFY time, never at REQUEST time")
# ===========================================================================


def t_no_user_row_before_verify():
    srv = ServerProc(label="d7-deferred")
    try:
        n = 10
        for i in range(n):
            request_link(srv, next_email(f"never-verifies-{i}"), f"10.85.0.{i + 1}")

        users_path = os.path.join(srv.state_dir, "users.json")
        # D7: users.json isn't even created until the first successful
        # find_or_create() call, which now only happens at verify time — so
        # after N requests with ZERO verifies, either the file doesn't
        # exist at all, or (if something else on this fresh server touched
        # it) it holds zero rows. Either is the property under test.
        if os.path.exists(users_path):
            with open(users_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            check(data.get("users") == {}, f"expected ZERO user rows after {n} requests with no verify, got {len(data.get('users', {}))}")
            check(data.get("by_email") == {}, f"expected ZERO by_email entries after {n} requests with no verify, got {len(data.get('by_email', {}))}")

        # Now actually verify ONE of them, and confirm exactly one row
        # appears — proving the row is created at verify time, not before.
        email = next_email("verifies-now")
        ip = "10.85.9.1"
        link = request_link(srv, email, ip)
        status, headers_list, _b = verify(srv, token_from_link(link), ip)
        check(status == 302, f"expected 302 from a fresh verify, got {status}")
        check(session_cookie(headers_list) is not None, "expected a session cookie from the fresh verify")
        with open(users_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        check(len(data["users"]) == 1, f"expected exactly ONE user row after the one verify, got {len(data['users'])}")
        check(email in data["by_email"], "expected the verified email to be the one registered")
    finally:
        srv.stop()


test("D7: requesting N links without ever verifying creates ZERO user rows; verifying creates exactly one", t_no_user_row_before_verify)


def t_new_user_disclosure_removed():
    """D17 (2026-07-30 security review): POST /auth/request used to log
    `new_user=<0|1>` — a per-IP, per-request disclosure of whether an
    address was already registered, which the privacy policy doesn't
    cover. D7's restructuring (account creation moved to verify time)
    removed the `created` flag this log line depended on entirely, so
    there is nothing left to disclose on this path."""
    src = open(PINBALL_AUTH, "r", encoding="utf-8").read()
    check("new_user=" not in src, "expected the new_user= disclosure to be fully removed from the source")


test("D17: POST /auth/request no longer logs a new_user=0/1 registration-status disclosure", t_new_user_disclosure_removed)

# ===========================================================================
section("11. D9 — issuing a new link revokes the address's other unused tokens")
# ===========================================================================


def t_second_link_request_revokes_first():
    srv = ServerProc(label="d9-revoke")
    try:
        email = next_email("d9-revoke")
        link1 = request_link(srv, email, "10.91.0.1")
        token1 = token_from_link(link1)
        link2 = request_link(srv, email, "10.91.0.2")
        token2 = token_from_link(link2)
        check(token1 != token2, "expected two distinct tokens from two separate requests")

        status1, _h1, _b1 = verify(srv, token1, "10.91.0.3")
        check(status1 == 401, f"expected the FIRST (superseded) token to be rejected as invalid, got {status1}")

        status2, headers2, _b2 = verify(srv, token2, "10.91.0.4")
        check(status2 == 302, f"expected the SECOND (latest) token to still work, got {status2}")
        check(session_cookie(headers2) is not None, "expected a session cookie from the latest token")
    finally:
        srv.stop()


test("D9: issuing a second link for the same address revokes the first (at most one live credential per address)", t_second_link_request_revokes_first)

# ===========================================================================
section("12. D13 — email validation rejects injection characters and a trailing domain dot")
# ===========================================================================


def t_email_rejects_injection_and_trailing_dot():
    for bad in [
        "a,b@example.com",     # D13: comma — the actual reproduced Resend-list-splitting risk
        "a;b@example.com",
        "a<b@example.com",
        'a"b@example.com',
        "a@example.com,evil.com",
        "user@example.com.",   # D13: trailing dot on the domain
    ]:
        got = pinball_auth.normalize_email(bad)
        check(got is None, f"expected {bad!r} to be rejected by normalize_email, got {got!r}")
    # A completely ordinary address must still pass.
    check(pinball_auth.normalize_email("Some.User+tag@Example.com") == "some.user+tag@example.com",
          "expected an ordinary address to still normalize (lowercased) successfully")


test("D13: normalize_email rejects comma/semicolon/angle-brackets/quotes and a trailing domain dot", t_email_rejects_injection_and_trailing_dot)


def t_email_injection_char_rejected_end_to_end():
    """End-to-end companion to the unit test above: an address containing
    the injection character must be treated exactly like any other
    malformed input by the live server — the same neutral 302, and (this
    IS the point of D13) it must never reach mail_sender.ResendSender's
    `to: [...]` as multiple recipients. main_srv is already stopped by this
    point in the file (see its `finally: main_srv.stop()` above) — this
    test gets its own dedicated server, same pattern as sections 7-11."""
    srv = ServerProc(label="d13-injection")
    try:
        status, headers_list, _b = http_request(
            srv.port, "POST", "/auth/request", form={"email": "a,b@example.com"},
            headers={"X-Forwarded-For": "10.92.0.1"},
        )
        check(status == 302, f"expected the same neutral 302 for a comma-injected address, got {status}")
        check(header(headers_list, "Location") == "/login?sent=1", "expected /login?sent=1")
        check(srv.link_for("a,b@example.com") is None, "a comma-containing address must never reach TOKENS.issue()/SENDER.send() as a valid email")
    finally:
        srv.stop()


test("D13: a comma-injected address gets the same neutral response and never reaches the sender", t_email_injection_char_rejected_end_to_end)

# ===========================================================================
section("13. Phase 4 — SEO guide pages (/machines, /machines/<slug>): public in BOTH PINBALL_PUBLIC modes, traversal-safe")
# ===========================================================================
# This section builds its OWN tiny fixture webroot rather than depending on
# app/dist/machines/** actually being built — that directory is produced by
# a separate content-generation pipeline (RULES-*.md -> HTML), not by this
# test, and may not exist yet in a given checkout. A fixture proves the
# ROUTING code in pinball_auth.py (Handler._serve_machine_guide and its
# callsite in _handle_get) is correct for ANY conforming build — real guide
# content is exercised instead, end to end, by deploy-prod.sh's Phase 4
# smoke-test block against the actual production build.
#
# Both the fixture webroot AND a traversal canary live under ONE dedicated
# parent tempdir so teardown is a single shutil.rmtree with no risk of ever
# computing an over-broad path (os.path.dirname of a bare mkdtemp() result
# would be the SYSTEM temp root, which must never be handed to rmtree).
_FIXTURE_PARENT = tempfile.mkdtemp(prefix="pg-auth-machines-fixture-")
_MACHINES_ROOT = os.path.join(_FIXTURE_PARENT, "webroot")
_TRAVERSAL_CANARY = os.path.join(_FIXTURE_PARENT, "outside-webroot-canary.txt")


def _write_fixture(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


_write_fixture(os.path.join(_MACHINES_ROOT, "index.html"), "<html><body>FIXTURE SPA ROOT</body></html>")
_write_fixture(os.path.join(_MACHINES_ROOT, "machines", "index.html"), "<html><body>FIXTURE GUIDE INDEX</body></html>")
_write_fixture(
    os.path.join(_MACHINES_ROOT, "machines", "jaws", "index.html"),
    '<html><head><link rel="canonical" href="https://pinball-genie.com/machines/jaws"></head>'
    "<body>Jaws — how to start Frenzy multiball...</body></html>",
)
_write_fixture(
    os.path.join(_MACHINES_ROOT, "machines", "godzilla", "index.html"),
    "<html><body>Godzilla — how to start Kaiju multiball...</body></html>",
)
_write_fixture(_TRAVERSAL_CANARY, "TRAVERSAL-CANARY-SHOULD-NEVER-BE-SERVED")


def t_resolve_safe_path_unit():
    """Direct unit test of the primitive _serve_machine_guide relies on for
    ALL of its traversal safety — mirrors this file's existing style for
    pure-function checks (see t_validate_public_origin_unit / t_subnet_key_
    unit above) rather than only testing it indirectly through a live
    server."""
    ok = pinball_auth.resolve_safe_path(_MACHINES_ROOT, "machines/jaws/index.html")
    check(
        ok == os.path.realpath(os.path.join(_MACHINES_ROOT, "machines/jaws/index.html")),
        f"expected an in-bounds path to resolve to the real file, got {ok!r}",
    )
    # Every shape of "escape the webroot" this route could plausibly see.
    # resolve_safe_path is handed the SAME already-percent-decoded string
    # _handle_get would pass it (decoding happens once, earlier, in
    # _handle_get — see resolve_safe_path's own docstring), so these are
    # literal ".." strings, not "%2e%2e" — the encoded form is proved
    # end-to-end against the live server below instead, where the decoding
    # step is actually exercised.
    for bad in [
        "machines/../../../etc/passwd",
        "machines/jaws/../../../../etc/passwd",
        "../outside-webroot-canary.txt",
        "machines/../../outside-webroot-canary.txt",  # lands exactly on
        # _TRAVERSAL_CANARY's real position (_FIXTURE_PARENT), i.e. the
        # narrowest possible escape — if resolve_safe_path ever allowed
        # even ONE directory level too many of "..", this is the case that
        # would catch it, not just a wildly-over-escaped /etc/passwd probe.
    ]:
        got = pinball_auth.resolve_safe_path(_MACHINES_ROOT, bad)
        check(got is None, f"expected {bad!r} to be refused (None), got {got!r}")


test("resolve_safe_path unit: refuses every traversal shape /machines/* could see", t_resolve_safe_path_unit)

machines_gated_srv = ServerProc(label="machines-gated", root=_MACHINES_ROOT)  # PINBALL_PUBLIC unset -> "0", the staging default
machines_public_srv = ServerProc(label="machines-public", root=_MACHINES_ROOT, env_overrides={"PINBALL_PUBLIC": "1"})  # the production unit's actual setting

try:
    for _srv, _mode in [(machines_gated_srv, "PINBALL_PUBLIC=0 (gated/staging)"), (machines_public_srv, "PINBALL_PUBLIC=1 (public/production)")]:

        def t_index_public(srv=_srv, mode=_mode):
            status, _h, body = http_request(srv.port, "GET", "/machines")
            check(status == 200, f"[{mode}] GET /machines with no session -> {status}, want 200")
            check(b"FIXTURE GUIDE INDEX" in body, f"[{mode}] /machines body missing expected fixture content")

        test(f"GET /machines is 200 with NO session cookie — {_mode}", t_index_public)

        def t_slug_public(srv=_srv, mode=_mode):
            status, _h, body = http_request(srv.port, "GET", "/machines/jaws")
            check(status == 200, f"[{mode}] GET /machines/jaws with no session -> {status}, want 200")
            check(b"Frenzy multiball" in body, f"[{mode}] /machines/jaws body missing expected fixture content")
            content_type = header(_h, "Content-Type")
            check(
                content_type is not None and "text/html" in content_type,
                f"[{mode}] expected text/html Content-Type on /machines/jaws, got {content_type!r}",
            )

        test(f"GET /machines/<slug> is 200 with NO session cookie, real content — {_mode}", t_slug_public)

        def t_slug_trailing_slash_redirects(srv=_srv, mode=_mode):
            status, headers_list, _b = http_request(srv.port, "GET", "/machines/jaws/")
            check(status == 301, f"[{mode}] GET /machines/jaws/ -> {status}, want 301 (permanent)")
            check(header(headers_list, "Location") == "/machines/jaws", f"[{mode}] expected redirect Location /machines/jaws")

        test(f"GET /machines/<slug>/ (trailing slash) 301s to the no-slash canonical — {_mode}", t_slug_trailing_slash_redirects)

        def t_index_trailing_slash_redirects(srv=_srv, mode=_mode):
            status, headers_list, _b = http_request(srv.port, "GET", "/machines/")
            check(status == 301, f"[{mode}] GET /machines/ -> {status}, want 301 (permanent)")
            check(header(headers_list, "Location") == "/machines", f"[{mode}] expected redirect Location /machines")

        test(f"GET /machines/ (trailing slash) 301s to /machines — {_mode}", t_index_trailing_slash_redirects)

        def t_unknown_slug_clean_404(srv=_srv, mode=_mode):
            status, _h, body = http_request(srv.port, "GET", "/machines/not-a-real-machine")
            check(status == 404, f"[{mode}] GET /machines/<unknown> -> {status}, want a clean 404")
            check(b"TRAVERSAL-CANARY" not in body, f"[{mode}] canary leaked for an unknown slug")

        test(f"GET /machines/<unknown-slug> is a clean 404, not a crash or a leak — {_mode}", t_unknown_slug_clean_404)

        def t_traversal_literal_dotdot_refused(srv=_srv, mode=_mode):
            status, _h, body = http_request(srv.port, "GET", "/machines/../../../etc/passwd")
            check(status == 404, f"[{mode}] literal ../ traversal via /machines -> {status}, want 404")
            # This route's OWN 404, never the traversed file. The body used to
            # be the literal b"not found"; it is now the branded 404 page for
            # extension-less URLs like this one (see _send_not_found), so the
            # assertion checks the two properties that actually matter and
            # always did: it is this site's own error page, and not one byte of
            # /etc/passwd came back ("root:" is the first field of its first
            # line on every Unix).
            check(b"Page not found" in body, f"[{mode}] expected this route's own clean 404 body, got {body!r}")
            check(b"root:" not in body, f"[{mode}] /etc/passwd content leaked into the 404 body: {body!r}")

        test(f"GET /machines/../../../etc/passwd (literal ../) is refused — {_mode}", t_traversal_literal_dotdot_refused)

        def t_traversal_encoded_refused(srv=_srv, mode=_mode):
            # %2e%2e/%2e%2e decodes (once, by _handle_get, exactly like a
            # real request) to "../..", which lands EXACTLY on
            # _TRAVERSAL_CANARY's real filesystem position — the narrowest
            # possible over-escape, not a wildly-obvious one.
            status, _h, body = http_request(srv.port, "GET", "/machines/%2e%2e/%2e%2e/outside-webroot-canary.txt")
            check(status == 404, f"[{mode}] percent-encoded traversal via /machines -> {status}, want 404")
            check(b"TRAVERSAL-CANARY" not in body, f"[{mode}] traversal canary leaked into the response body (encoded ../)")

        test(f"GET /machines/%2e%2e/%2e%2e/... (encoded ../) is refused, canary never leaks — {_mode}", t_traversal_encoded_refused)

    # ---- Regression: gating for every OTHER route must be exactly unchanged ----
    def t_gated_mode_still_gates_non_machines_paths():
        status, headers_list, _b = http_request(machines_gated_srv.port, "GET", "/")
        check(status == 302, f"expected PINBALL_PUBLIC=0 root '/' with no session to 302, got {status} (the new /machines branch must not leak into the catch-all route)")
        check(header(headers_list, "Location") == "/login", "expected redirect to /login")

    test("PINBALL_PUBLIC=0: a NON-/machines path ('/') is still session-gated exactly as before", t_gated_mode_still_gates_non_machines_paths)

    def t_public_mode_still_serves_everything_else():
        status, _h, body = http_request(machines_public_srv.port, "GET", "/")
        check(status == 200, f"expected PINBALL_PUBLIC=1 root '/' with no session to be 200, got {status}")
        check(b"FIXTURE SPA ROOT" in body, "expected the fixture's own index.html body, unaffected by the new /machines branch")

    test("PINBALL_PUBLIC=1: the ordinary catch-all route is unaffected by the new /machines branch", t_public_mode_still_serves_everything_else)

    def t_achievements_still_gated_in_both_modes():
        """The one route this whole file exists to protect must be
        completely untouched by Phase 4: per-user state stays gated
        regardless of PUBLIC_MODE, same assertion deploy-prod.sh's own
        smoke test makes against the real production unit."""
        for srv, mode in [(machines_gated_srv, "gated"), (machines_public_srv, "public")]:
            status, _h, _b = http_request(srv.port, "GET", "/api/achievements")
            check(status == 401, f"[{mode}] expected /api/achievements to stay 401 with no session, got {status}")

    test("D-unchanged: /api/achievements stays 401 with no session in BOTH modes (Phase 4 changed nothing here)", t_achievements_still_gated_in_both_modes)

    # ---- Branded 404 page (P1, 2026-08-13) --------------------------------
    # A mistyped URL gets a real page; a stale hashed chunk keeps the cheap
    # plain-text body. Both are 404 — only the representation differs, and it
    # is chosen from the URL's shape alone (Handler._send_not_found). Driven
    # against the PUBLIC_MODE=1 server because that is the production unit, and
    # because in mode 0 an unknown path 302s to /login before it can ever miss
    # a file (proved directly by t_gated_mode_still_gates_non_machines_paths
    # just above — the branded page must not change that).
    def t_page_shaped_404_is_the_branded_html_page():
        status, headers_list, body = http_request(machines_public_srv.port, "GET", "/no-such-page")
        check(status == 404, f"expected GET /no-such-page -> 404, got {status}")
        content_type = header(headers_list, "Content-Type")
        check(
            content_type is not None and "text/html" in content_type,
            f"expected a text/html 404 for an extension-less path, got {content_type!r}",
        )
        check(b"Pinball Genie" in body, f"expected the branded 404 page to name the site, got {body[:200]!r}")
        check(b"Page not found" in body, f"expected the branded 404 page's heading, got {body[:200]!r}")
        check(b'href="/machines"' in body, f"expected the 'All machines' link on the 404 page, got {body[:400]!r}")
        # The CSP this site sets forbids inline style/script — a 404 page that
        # violated it would render unstyled (or not at all) in a real browser
        # while looking fine to curl, so assert the absence here rather than
        # trusting the source to stay clean.
        check(b"<style" not in body and b"style=" not in body, f"the 404 page must carry no inline style: {body!r}")
        check(b"<script" not in body, f"the 404 page must carry no script: {body!r}")

    test("404: a page-shaped miss (/no-such-page) returns the branded HTML page", t_page_shaped_404_is_the_branded_html_page)

    def t_asset_shaped_404_stays_plain_text():
        status, headers_list, body = http_request(machines_public_srv.port, "GET", "/assets/nope.js")
        check(status == 404, f"expected GET /assets/nope.js -> 404, got {status}")
        content_type = header(headers_list, "Content-Type")
        check(
            content_type is not None and "text/html" not in content_type,
            f"a stale-chunk miss must NOT be answered with HTML, got {content_type!r}",
        )
        check(body == b"not found", f"expected the cheap plain-text 404 body for an asset miss, got {body!r}")

    test("404: an asset-shaped miss (/assets/nope.js) keeps the cheap plain-text 404", t_asset_shaped_404_stays_plain_text)

    def t_unknown_guide_slug_404_is_the_branded_page():
        """The OTHER 404 site (_serve_machine_guide's miss) must make the same
        choice — a wrong /machines/<slug> is a person following a bad link at
        least as often as a mistyped root path is."""
        status, headers_list, body = http_request(machines_public_srv.port, "GET", "/machines/not-a-real-machine")
        check(status == 404, f"expected an unknown guide slug -> 404, got {status}")
        content_type = header(headers_list, "Content-Type")
        check(
            content_type is not None and "text/html" in content_type,
            f"expected a text/html 404 for an unknown guide slug, got {content_type!r}",
        )
        check(b"Page not found" in body, f"expected the branded 404 page for an unknown slug, got {body[:200]!r}")

    test("404: an unknown /machines/<slug> also returns the branded HTML page", t_unknown_guide_slug_404_is_the_branded_page)

    def t_guide_asset_404_stays_plain_text():
        status, headers_list, body = http_request(machines_public_srv.port, "GET", "/machines/nope.png")
        check(status == 404, f"expected a missing /machines asset -> 404, got {status}")
        content_type = header(headers_list, "Content-Type")
        check(
            content_type is not None and "text/html" not in content_type,
            f"a missing /machines/*.png must NOT be answered with HTML, got {content_type!r}",
        )
        check(body == b"not found", f"expected the plain-text 404 body, got {body!r}")

    test("404: a missing asset under /machines keeps the plain-text 404 too", t_guide_asset_404_stays_plain_text)
finally:
    machines_gated_srv.stop()
    machines_public_srv.stop()
    shutil.rmtree(_FIXTURE_PARENT, ignore_errors=True)

# ===========================================================================
section("14. D-EPOCH — POST /auth/revoke-sessions (surface-1 security review, 2026-07-31)")
# ===========================================================================
# SURFACE 1 finding: sessions are stateless signed cookies with NO server-
# side row, so before this change the ONLY way to invalidate a session
# cookie an attacker had captured was full account deletion (see
# _do_signout's own docstring, which explicitly named and deferred this
# gap). This section proves the new POST /auth/revoke-sessions route
# actually closes it: a captured RAW cookie value, replayed exactly as an
# attacker would (no relationship to the browser that generated it, no
# reliance on Set-Cookie ever reaching them), must stop authenticating the
# moment the legitimate owner calls this route — without the account or its
# achievements data being touched.
revoke_srv = ServerProc(label="revoke-sessions")
try:

    def t_revoke_sessions_kills_a_captured_cookie():
        email = next_email("revoke")
        ip = next_fake_ip()
        cookie = sign_in(revoke_srv, email, ip)

        # Prove the captured cookie is live before revocation.
        status, _h, body = http_request(
            revoke_srv.port, "GET", "/whoami", headers={"Cookie": f"pinball_session={cookie}"}
        )
        check(status == 200 and b"null" not in body, f"expected a live session pre-revoke, got {status} {body!r}")

        # The legitimate owner calls revoke-sessions (e.g. from a NEW,
        # trusted session obtained via a fresh magic link — modeled here by
        # reusing the same cookie, since same-origin + a valid session is
        # all the route requires).
        status, headers_list, body = http_request(
            revoke_srv.port, "POST", "/auth/revoke-sessions", form={},
            headers={"Cookie": f"pinball_session={cookie}", "Sec-Fetch-Site": "same-origin"},
        )
        check(status == 200, f"expected 200 from revoke-sessions, got {status} {body!r}")
        check(b'"revoked":true' in body, f"expected a revoked:true body, got {body!r}")
        setc = [v for k, v in headers_list if k.lower() == "set-cookie"]
        check(any("Max-Age=0" in v for v in setc), f"expected revoke-sessions to also clear this device's cookie, got {setc!r}")

        # THE KEY PROOF: replay the EXACT SAME raw cookie value captured
        # before revocation (this is what an attacker who stole it earlier,
        # or a second browser tab that never saw the Set-Cookie clear,
        # would still be holding) — it must now be dead, unlike plain
        # signout (see NEW-1's t_signout_route, which asserts the opposite
        # for that route on purpose).
        status, _h, body = http_request(
            revoke_srv.port, "GET", "/whoami", headers={"Cookie": f"pinball_session={cookie}"}
        )
        check(status == 200 and b"null" in body, f"expected the captured cookie to be DEAD post-revoke, got {status} {body!r}")

        status, _h, _b = http_request(
            revoke_srv.port, "GET", "/api/achievements", headers={"Cookie": f"pinball_session={cookie}"}
        )
        check(status == 401, f"expected /api/achievements to reject the revoked cookie, got {status}")

        # The ACCOUNT must survive — this is "kill sessions", not delete.
        again = sign_in(revoke_srv, email, next_fake_ip())
        status, _h, body = http_request(
            revoke_srv.port, "GET", "/whoami", headers={"Cookie": f"pinball_session={again}"}
        )
        check(status == 200 and b"null" not in body, "expected the account to still exist and be signed-in-able after revoke-sessions")

    test(
        "D-EPOCH: revoke-sessions kills a captured raw cookie value everywhere while the account survives",
        t_revoke_sessions_kills_a_captured_cookie,
    )

    def t_revoke_sessions_requires_a_session():
        status, _h, _b = http_request(revoke_srv.port, "POST", "/auth/revoke-sessions", form={})
        check(status == 401, f"expected 401 with no session, got {status}")

    test("D-EPOCH: revoke-sessions with no session cookie -> 401", t_revoke_sessions_requires_a_session)

    def t_revoke_sessions_blocks_cross_origin():
        email = next_email("revoke-cross")
        ip = next_fake_ip()
        cookie = sign_in(revoke_srv, email, ip)
        status, _h, _b = http_request(
            revoke_srv.port, "POST", "/auth/revoke-sessions", form={},
            headers={"Cookie": f"pinball_session={cookie}", "Sec-Fetch-Site": "cross-site"},
        )
        check(status == 403, f"expected a cross-origin revoke-sessions to be refused, got {status}")
        # A refused cross-origin call must not have revoked anything.
        status, _h, body = http_request(
            revoke_srv.port, "GET", "/whoami", headers={"Cookie": f"pinball_session={cookie}"}
        )
        check(status == 200 and b"null" not in body, "a refused cross-origin revoke-sessions call must leave the session intact")

    test("D-EPOCH: a hostile page cannot force revoke-sessions cross-origin (and nothing is revoked if it's blocked)", t_revoke_sessions_blocks_cross_origin)

    def t_normal_signout_still_does_not_bump_epoch():
        """Regression guard: the D-EPOCH change must not accidentally make
        ordinary POST /auth/signout (this-device-only, see NEW-1) start
        revoking every session — that would silently change its documented
        semantics (a laptop sign-out would unexpectedly log out a phone
        too)."""
        email = next_email("signout-vs-revoke")
        ip = next_fake_ip()
        cookie = sign_in(revoke_srv, email, ip)
        status, _h, _b = http_request(
            revoke_srv.port, "POST", "/auth/signout", form={},
            headers={"Cookie": f"pinball_session={cookie}", "Sec-Fetch-Site": "same-origin"},
        )
        check(status == 204, f"expected signout to succeed, got {status}")
        # The raw captured cookie must STILL validate — signout does not
        # touch session_epoch, only this browser's own cookie jar.
        status, _h, body = http_request(
            revoke_srv.port, "GET", "/whoami", headers={"Cookie": f"pinball_session={cookie}"}
        )
        check(status == 200 and b"null" not in body, f"signout must NOT bump session_epoch (that's revoke-sessions' job), got {status} {body!r}")

    test("D-EPOCH regression: plain signout still does not invalidate a captured raw cookie (unchanged NEW-1 semantics)", t_normal_signout_still_does_not_bump_epoch)

    def t_revoke_sessions_source_never_puts_epoch_in_the_cookie():
        """The cookie's own wire shape (uid.exp.sig, three dot-separated
        fields) must be unchanged — epoch is looked up from UserStore at
        sign/verify time, never carried in the cookie itself. See the
        module docstring's Session cookie section."""
        email = next_email("revoke-shape")
        ip = next_fake_ip()
        cookie = sign_in(revoke_srv, email, ip)
        check(cookie.count(".") == 2, f"expected the cookie to still have exactly 3 dot-separated fields, got {cookie!r}")

    test("D-EPOCH: the session cookie's wire format is unchanged (3 fields; epoch is server-side only)", t_revoke_sessions_source_never_puts_epoch_in_the_cookie)

finally:
    revoke_srv.stop()

# ===========================================================================
section("15. Surface-2 (HTTP server) hardening — 2026-07-31 review, D14/D15/D16")
# ===========================================================================
# Three bugs found by attacking pinball_auth.py as a raw HTTP server rather
# than as an auth system, all reproduced against a live subprocess before
# being fixed — this section proves each one stays fixed.

# ---- D15: /machines/<slug> must not be able to reach a SIBLING file inside
# ROOT_DIR that PINBALL_PUBLIC=0 would otherwise gate. The existing Phase 4
# fixture above only ever tested escaping the ENTIRE webroot (down to
# /etc/passwd or the outside-webroot canary) — never the narrower, more
# dangerous case of staying INSIDE ROOT_DIR but stepping OUT of machines/
# into a file the ordinary catch-all route would otherwise have gated in
# PINBALL_PUBLIC=0. This fixture adds exactly that sibling file.
_D15_PARENT = tempfile.mkdtemp(prefix="pg-auth-d15-fixture-")
_D15_ROOT = os.path.join(_D15_PARENT, "webroot")
_write_fixture(os.path.join(_D15_ROOT, "index.html"), "<html><body>D15 FIXTURE SPA ROOT</body></html>")
_write_fixture(os.path.join(_D15_ROOT, "machines", "index.html"), "<html><body>D15 MACHINES INDEX</body></html>")
_write_fixture(os.path.join(_D15_ROOT, "machines", "jaws", "index.html"), "<html><body>D15 JAWS GUIDE</body></html>")
_write_fixture(os.path.join(_D15_ROOT, "assets", "app.js"), "GATED_APP_BUNDLE_SHOULD_NEVER_BE_PUBLIC_IN_MODE_0")

d15_gated_srv = ServerProc(label="d15-gated", root=_D15_ROOT)  # PINBALL_PUBLIC unset -> "0"

try:
    def t_d15_sibling_asset_is_gated_normally():
        status, _h, _b = http_request(d15_gated_srv.port, "GET", "/assets/app.js")
        check(status in (302, 401), f"expected /assets/app.js to be gated (302/401) with no session in mode 0, got {status}")

    test("D15 baseline: /assets/app.js IS gated with no session in PINBALL_PUBLIC=0 (sanity check)", t_d15_sibling_asset_is_gated_normally)

    def t_d15_machines_still_works():
        status, _h, body = http_request(d15_gated_srv.port, "GET", "/machines/jaws")
        check(status == 200, f"expected legit /machines/jaws to stay 200, got {status}")
        check(b"D15 JAWS GUIDE" in body, "expected the real guide fixture body")

    test("D15 baseline: legit /machines/jaws is unaffected by the fix", t_d15_machines_still_works)

    def t_d15_traversal_cannot_reach_sibling_gated_file():
        """THE bug: GET /machines/%2e%2e/assets/app.js used to decode to
        '/machines/../assets/app.js', resolve against ROOT_DIR (not scoped
        to ROOT_DIR/machines), and serve the gated bundle with NO session —
        a complete bypass of PINBALL_PUBLIC=0 gating for anything in
        ROOT_DIR, reachable purely because /machines/* is checked before
        the PUBLIC_MODE gate. Reproduced pre-fix: 200 + the gated body.
        Must now be a clean 404, and the gated content must never appear."""
        status, _h, body = http_request(d15_gated_srv.port, "GET", "/machines/%2e%2e/assets/app.js")
        check(status == 404, f"expected the traversal-into-sibling-file bypass to 404, got {status}")
        check(b"GATED_APP_BUNDLE" not in body, "gated sibling file content leaked through the /machines/ bypass")

    test("D15: /machines/%2e%2e/assets/app.js can no longer bypass PINBALL_PUBLIC=0 gating", t_d15_traversal_cannot_reach_sibling_gated_file)

    def t_d15_deeper_traversal_still_cannot_escape_filesystem():
        status, _h, _b = http_request(d15_gated_srv.port, "GET", "/machines/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd")
        check(status == 404, f"expected an escape-the-whole-filesystem attempt via /machines to still 404, got {status}")

    test("D15: /machines/* still can't escape the filesystem entirely (unchanged)", t_d15_deeper_traversal_still_cannot_escape_filesystem)
finally:
    d15_gated_srv.stop()
    shutil.rmtree(_D15_PARENT, ignore_errors=True)

# ---- D14 + D16 share one dedicated server: main_srv (used by the sections
# above) is already stopped by this point in the file (see its own
# `finally: main_srv.stop()`), so these need a server of their own, same as
# every other post-main_srv section (d15_gated_srv above, revoke_srv before
# it).
surface2_srv = ServerProc(label="surface2")

# ---- D14: PUT /api/achievements with deeply-nested JSON must not crash the
# handler thread with an uncaught RecursionError.


def _d14_raw_nested_put(cookie: str) -> bytes:
    """A raw socket is needed (not the shared http_request helper, which only
    builds bodies from `form=`) so an actual ~40KB deeply-nested body is on
    the wire — the shape that blows json.loads's recursion limit."""
    depth = 20000  # ~40KB, comfortably under ACHIEVEMENTS_MAX_BODY (128KB)
    body = (("[" * depth) + ("]" * depth)).encode("ascii")
    req = (
        f"PUT /api/achievements HTTP/1.1\r\n"
        f"Host: 127.0.0.1\r\n"
        f"Cookie: pinball_session={cookie}\r\n"
        f"Sec-Fetch-Site: same-origin\r\n"
        f"Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"Connection: close\r\n\r\n"
    ).encode("ascii") + body
    s = socket.create_connection(("127.0.0.1", surface2_srv.port), timeout=10)
    s.sendall(req)
    s.settimeout(5)
    chunks = []
    try:
        while True:
            d = s.recv(4096)
            if not d:
                break
            chunks.append(d)
    except socket.timeout:
        pass
    s.close()
    return b"".join(chunks)


def t_d14_raw_deeply_nested_json_gets_a_real_response():
    email = next_email("d14-nest")
    ip = next_fake_ip()
    cookie = sign_in(surface2_srv, email, ip)
    out = _d14_raw_nested_put(cookie)
    check(out.startswith(b"HTTP/1.1 400"), f"expected a real HTTP/1.1 400 response, got {out[:80]!r}")
    check(b"Traceback" not in out, "a stack trace must never reach the client")


test(
    "D14: a raw deeply-nested JSON body (20,000 levels, ~40KB, under the 128KB cap) gets a real HTTP 400, not a dropped connection",
    t_d14_raw_deeply_nested_json_gets_a_real_response,
)


def t_d14_server_still_healthy_after():
    """The whole point: one bad request must not take down anything else —
    prove the SAME server process still answers normally afterward."""
    status, _h, body = http_request(surface2_srv.port, "GET", "/health")
    check(status == 200 and body == b"ok", f"expected the server to still be healthy after D14's crash input, got {status} {body!r}")


test("D14: the server process is still healthy after the deeply-nested-JSON request", t_d14_server_still_healthy_after)

# ---- D16: a rejected POST/PUT that never reads its declared body must not
# corrupt whatever request comes next on the same persistent connection.


def _pipelined_raw(first_req: bytes, second_req: bytes) -> bytes:
    s = socket.create_connection(("127.0.0.1", surface2_srv.port), timeout=10)
    s.sendall(first_req + second_req)
    s.settimeout(3)
    chunks = []
    try:
        while True:
            d = s.recv(4096)
            if not d:
                break
            chunks.append(d)
    except socket.timeout:
        pass
    s.close()
    return b"".join(chunks)


def t_d16_unauth_put_achievements_does_not_corrupt_pipelined_request():
    body = b'{"x":1}' + b" " * 50
    first = (
        b"PUT /api/achievements HTTP/1.1\r\nHost: 127.0.0.1\r\n"
        b"Content-Length: " + str(len(body)).encode() + b"\r\n"
        b"Connection: keep-alive\r\n\r\n" + body
    )
    second = b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    out = _pipelined_raw(first, second)
    check(b"401 Unauthorized" in out, f"expected the first response to still be 401, got {out[:200]!r}")
    # Pre-fix, the leftover unread body corrupted the second request into a
    # bogus 400 "Bad request syntax" — the fix closes the connection
    # instead, so either the follow-up never gets answered on this same
    # socket (clean close) or, if it somehow were answered, it must NEVER
    # be a corrupted parse. Both are acceptable; a garbled 400/501 for
    # /health is not.
    check(b"Bad request syntax" not in out, f"pipelined /health request was corrupted by an undrained PUT body: {out!r}")
    check(b"Unsupported method" not in out, f"pipelined /health request was corrupted: {out!r}")


test(
    "D16: unauthenticated PUT /api/achievements (undrained body) can't corrupt a pipelined follow-up request",
    t_d16_unauth_put_achievements_does_not_corrupt_pipelined_request,
)


def t_d16_unmatched_post_path_does_not_corrupt_pipelined_request():
    first = (
        b"POST /nonexistent-route HTTP/1.1\r\nHost: 127.0.0.1\r\n"
        b"Content-Length: 40\r\nConnection: keep-alive\r\n\r\n" + b"B" * 40
    )
    second = b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    out = _pipelined_raw(first, second)
    check(b"404 Not Found" in out, f"expected the first response to still be 404, got {out[:200]!r}")
    check(b"Unsupported method" not in out, f"pipelined /health request was corrupted by an undrained POST body: {out!r}")


test(
    "D16: an unmatched POST path (undrained body) can't corrupt a pipelined follow-up request",
    t_d16_unmatched_post_path_does_not_corrupt_pipelined_request,
)


def t_d16_rejected_request_actually_closes_the_connection():
    """The mechanism, not just the symptom: prove the socket is actually
    closed (EOF) after a rejection that declared a body, rather than merely
    'happening to' avoid corruption in the two tests above."""
    body = b"C" * 20
    req = (
        b"PUT /api/achievements HTTP/1.1\r\nHost: 127.0.0.1\r\n"
        b"Content-Length: " + str(len(body)).encode() + b"\r\nConnection: keep-alive\r\n\r\n" + body
    )
    s = socket.create_connection(("127.0.0.1", surface2_srv.port), timeout=10)
    s.sendall(req)
    s.settimeout(3)
    first = s.recv(4096)
    check(b"401 Unauthorized" in first, f"expected 401, got {first[:200]!r}")
    try:
        rest = s.recv(4096)
        check(rest == b"", f"expected EOF (server closed the connection) after the 401, got {rest!r}")
    except socket.timeout:
        raise AssertionError("connection was neither closed nor did it answer — looks still open/hung")
    finally:
        s.close()


test(
    "D16: the server actually closes the connection after a body-bearing rejection (not just avoids corruption by luck)",
    t_d16_rejected_request_actually_closes_the_connection,
)

surface2_srv.stop()

# ===========================================================================
section("16. C1 — request smuggling via an UNREAD request body (CRITICAL, 2026-07-31 audit)")
# ===========================================================================
# THE BUG. Any route that answered without consuming a declared body left
# those bytes in the socket. Caddy pools backend connections ACROSS DIFFERENT
# DOWNSTREAM VISITORS, so the leftovers were prepended to the NEXT victim's
# request — absorbing their request line and headers, INCLUDING THEIR COOKIE,
# as header continuations of the attacker's smuggled request, which then ran
# AS THAT VICTIM. Reproduced end to end: an unauthenticated attacker DELETED a
# victim's account, and separately bound a victim's browser to the attacker's
# session.
#
# WHY THE EARLIER D16 TESTS DID NOT CATCH IT. They all smuggled a COMPLETE
# request. Go's HTTP transport kills those via its "unsolicited response on an
# idle connection" guard, so they looked handled. An UNTERMINATED prefix
# emits no extra response and sails straight past. This test therefore
# smuggles an unterminated prefix, and does it on a GET — the method the
# route-by-route _drain_or_close() fix never covered.
#
# The assertion is deliberately about the CONNECTION, not about any route's
# status code: the guarantee is "a request whose body we ignored can never
# share a socket with the next request", which is what makes the whole class
# unreachable regardless of which routes exist now or later.

def t_c1_unread_body_closes_connection():
    srv = ServerProc(label="c1-smuggle")
    try:
        smuggled = (
            "POST /auth/delete HTTP/1.1\r\n"
            "Host: 127.0.0.1\r\n"
            "Sec-Fetch-Site: none\r\n"
            "X-Junk: "  # deliberately UNTERMINATED — no trailing CRLF
        )
        attack = (
            "GET /health HTTP/1.1\r\n"
            "Host: 127.0.0.1\r\n"
            f"Content-Length: {len(smuggled)}\r\n"
            "\r\n" + smuggled
        ).encode()

        sock = socket.create_connection(("127.0.0.1", srv.port), timeout=8)
        try:
            sock.sendall(attack)
            time.sleep(0.4)
            first = sock.recv(4096).decode(errors="replace")
            check(first.startswith("HTTP/1.1 200"), f"expected the carrier GET to be answered, got {first[:60]!r}")

            # The victim's request, arriving on what WOULD have been a pooled
            # socket. It must not be servable at all.
            sock.sendall(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            time.sleep(0.4)
            try:
                second = sock.recv(4096)
            except OSError:
                second = b""
            check(
                second == b"",
                "the connection MUST be closed after a request whose declared body was never read — "
                f"got a second response instead: {second[:80]!r} (smuggled bytes could reach the next visitor)",
            )
        finally:
            sock.close()
    finally:
        srv.stop()


test("C1: a GET with an unread declared body closes the connection (no smuggling into the next visitor)", t_c1_unread_body_closes_connection)


def t_c1_chunked_also_closes():
    """L4, folded in: Transfer-Encoding: chunked is checked by the same guard.
    This server has no chunked parser, so any chunked body is by definition
    unread and the socket must not be reused."""
    srv = ServerProc(label="c1-chunked")
    try:
        sock = socket.create_connection(("127.0.0.1", srv.port), timeout=8)
        try:
            sock.sendall(
                b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                b"Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n"
            )
            time.sleep(0.4)
            try:
                sock.recv(4096)
            except OSError:
                pass
            sock.sendall(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            time.sleep(0.4)
            try:
                again = sock.recv(4096)
            except OSError:
                again = b""
            check(again == b"", f"chunked body must also close the connection, got {again[:80]!r}")
        finally:
            sock.close()
    finally:
        srv.stop()


test("C1/L4: a chunked body on a route that never reads one also closes the connection", t_c1_chunked_also_closes)


def t_c1_normal_keepalive_still_works():
    """The guard must NOT break ordinary keep-alive. A request with no body,
    and a POST whose body IS read, must both leave the connection reusable —
    otherwise this 'fix' silently halves throughput for every real visitor."""
    srv = ServerProc(label="c1-keepalive")
    try:
        sock = socket.create_connection(("127.0.0.1", srv.port), timeout=8)
        try:
            for i in range(3):
                sock.sendall(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                time.sleep(0.25)
                resp = sock.recv(4096).decode(errors="replace")
                check(resp.startswith("HTTP/1.1 200"), f"keep-alive request {i + 1} failed: {resp[:60]!r}")
        finally:
            sock.close()
    finally:
        srv.stop()


test("C1: ordinary bodyless keep-alive is unaffected by the guard", t_c1_normal_keepalive_still_works)


# ===========================================================================
section("17. PG-01/PG-02/PG-04 — 2026-07-31 webapp pentest (serverMode methodology)")
# ===========================================================================
# Three findings from a full OWASP-driven web-app test, each reproduced before
# the fix and re-run after it. See server/pinball_auth.py for the per-fix
# incident write-ups; these are the standing regressions.

# ---- PG-01: response-header injection -> session fixation -----------------
# _serve_machine_guide's trailing-slash 301 built Location from the
# PERCENT-DECODED request path, and CPython's send_header does no CR/LF
# filtering, so %0d%0a in the path emitted attacker-chosen response headers.
# Confirmed against the LIVE site before the fix: an injected header came back
# in a real response from https://pinball-genie.com. The Set-Cookie form binds
# a victim's browser to the ATTACKER's account in one click.
#
# The assertions below are deliberately about what reaches the wire, not about
# a status code: "no request-derived bytes can start a new header line" is the
# property, and it has to hold no matter which route reflects what.

def _raw_get(port, target):
    """Send a request line VERBATIM — http.client would re-encode or reject
    the payloads under test, which is exactly the encoding an attacker
    controls."""
    sock = socket.create_connection(("127.0.0.1", port), timeout=8)
    try:
        sock.sendall(f"GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".encode())
        buf = b""
        while True:
            try:
                chunk = sock.recv(65536)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
        return buf.decode("latin-1", "replace")
    finally:
        sock.close()


def t_pg01_header_injection_blocked():
    srv = ServerProc(label="pg01-inject")
    try:
        resp = _raw_get(srv.port, "/machines/%0d%0aX-Injected:%20pwned/")
        check("X-Injected" not in resp,
              f"CR/LF in the request path injected a response header (PG-01): {resp[:200]!r}")
        check(resp.startswith("HTTP/1.1 400"),
              f"a control character in the request target must be a 400, got {resp.splitlines()[0]!r}")
    finally:
        srv.stop()


test("PG-01: %0d%0a in the path cannot inject a response header", t_pg01_header_injection_blocked)


def t_pg01_set_cookie_fixation_blocked():
    """The finding's real impact: forging a session cookie onto a victim."""
    srv = ServerProc(label="pg01-cookie")
    try:
        resp = _raw_get(
            srv.port,
            "/machines/x%0d%0aSet-Cookie:%20pinball_session=ATTACKER;%20Path=/;%20Max-Age=2592000/",
        )
        check("ATTACKER" not in resp,
              f"session-fixation cookie was injected into the response (PG-01): {resp[:200]!r}")
    finally:
        srv.stop()


test("PG-01: a crafted link cannot inject Set-Cookie (session fixation)", t_pg01_set_cookie_fixation_blocked)


def t_pg01_response_splitting_blocked():
    """The strongest form: a whole second HTTP response, body and all."""
    srv = ServerProc(label="pg01-split")
    try:
        resp = _raw_get(
            srv.port,
            "/machines/x%0d%0aContent-Length:%200%0d%0a%0d%0a"
            "HTTP/1.1%20200%20OK%0d%0aContent-Type:%20text/html%0d%0a"
            "Content-Length:%2025%0d%0a%0d%0a%3Cscript%3Ealert(1)%3C/script%3E/",
        )
        check(resp.count("HTTP/1.1") == 1,
              f"response splitting produced more than one response (PG-01): {resp[:300]!r}")
        check("<script>" not in resp, f"attacker-controlled body reached the wire: {resp[:300]!r}")
    finally:
        srv.stop()


test("PG-01: the path cannot split the response into a second attacker-controlled one",
     t_pg01_response_splitting_blocked)


def t_pg01_legit_redirect_unaffected():
    """The guard must not break the thing the route exists for. A real
    trailing-slash guide URL still 301s to the canonical no-slash form — the
    exact behaviour deploy-prod.sh's Phase 4 smoke gate asserts in production.

    Builds its own throwaway webroot rather than reusing section 13's: that
    fixture's parent is rmtree'd when its own section finishes, so referencing
    it here would fail for a reason that has nothing to do with this guard."""
    parent = tempfile.mkdtemp(prefix="pg-auth-pg01-fixture-")
    root = os.path.join(parent, "webroot")
    _write_fixture(os.path.join(root, "index.html"), "<!doctype html><title>app</title>")
    _write_fixture(os.path.join(root, "machines", "jaws", "index.html"),
                   "<!doctype html><title>Jaws</title>")
    srv = ServerProc(label="pg01-legit", root=root)
    try:
        status, headers_list, _b = http_request(srv.port, "GET", "/machines/jaws/")
        check(status == 301, f"legit /machines/jaws/ -> {status}, want 301")
        check(header(headers_list, "Location") == "/machines/jaws",
              f"Location was {header(headers_list, 'Location')!r}, want '/machines/jaws'")
    finally:
        srv.stop()
        shutil.rmtree(parent, ignore_errors=True)


test("PG-01 regression: an ordinary /machines/<slug>/ redirect still works", t_pg01_legit_redirect_unaffected)


# ---- PG-02: unauthenticated slow-body worker-slot exhaustion -------------
# POST /auth/request read the whole declared body in one blocking call BEFORE
# any rate-limit/CSRF/auth check. One connection declaring Content-Length:2000
# and sending ONE BYTE pinned a worker for the full 14.97s socket timeout;
# ~100 of them exhausted BoundedThreadingHTTPServer's 100 slots and real
# visitors got 502 Bad Gateway through Caddy. The fix reads against a total
# wall-clock budget (BODY_READ_TIMEOUT) and answers 408.

def t_pg02_slow_body_gets_408_not_a_pinned_slot():
    srv = ServerProc(label="pg02-slowbody")
    try:
        sock = socket.create_connection(("127.0.0.1", srv.port), timeout=30)
        try:
            sock.sendall(
                b"POST /auth/request HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                b"Sec-Fetch-Site: same-origin\r\n"
                b"Content-Type: application/x-www-form-urlencoded\r\n"
                b"Content-Length: 2000\r\n\r\ne"  # 1 of 2000 declared bytes, then silence
            )
            started = time.time()
            resp = sock.recv(4096).decode(errors="replace")
            elapsed = time.time() - started
            check(resp.startswith("HTTP/1.1 408"),
                  f"a trickled body must be answered 408, got {resp.splitlines()[0] if resp else resp!r}")
            # The whole point is the BOUND. Assert against the constant with
            # generous slack rather than a hard-coded number, so tuning
            # BODY_READ_TIMEOUT doesn't silently make this test meaningless.
            budget = pinball_auth.BODY_READ_TIMEOUT
            check(elapsed < budget + 3,
                  f"slot was held {elapsed:.1f}s, expected release near BODY_READ_TIMEOUT={budget}s")
        finally:
            sock.close()
    finally:
        srv.stop()


test("PG-02: a trickled request body gets 408 within the read budget, not a pinned worker",
     t_pg02_slow_body_gets_408_not_a_pinned_slot)


def t_pg02_service_survives_concurrent_slow_bodies():
    """The impact assertion: while slow bodies are held open, an ordinary
    visitor is still served. Pre-fix this returned 502 through Caddy and a
    reset connection direct. Uses well under the 100-slot cap — the mechanism
    is what's under test, not the flood."""
    srv = ServerProc(label="pg02-concurrent")
    held = []
    try:
        for _ in range(20):
            try:
                s = socket.create_connection(("127.0.0.1", srv.port), timeout=20)
                s.sendall(
                    b"POST /auth/request HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                    b"Sec-Fetch-Site: same-origin\r\n"
                    b"Content-Type: application/x-www-form-urlencoded\r\n"
                    b"Content-Length: 2000\r\n\r\ne"
                )
                held.append(s)
            except OSError:
                break
        status, _h, _b = http_request(srv.port, "GET", "/health")
        check(status == 200, f"a legitimate request must still be served during slow-body load, got {status}")
    finally:
        for s in held:
            try:
                s.close()
            except OSError:
                pass
        srv.stop()


test("PG-02: legitimate requests are still served while slow bodies are held open",
     t_pg02_service_survives_concurrent_slow_bodies)


def t_pg02_normal_body_still_works():
    """The budget must not break real requests. A full, promptly-delivered
    body on both body-reading routes still succeeds."""
    srv = ServerProc(label="pg02-normal")
    try:
        status, _h, _b = http_request(srv.port, "POST", "/auth/request",
                                      form={"email": "normal@example.com"},
                                      headers={"Sec-Fetch-Site": "same-origin"})
        check(status == 302, f"an ordinary sign-in POST -> {status}, want 302")
        cookie = sign_in(srv, "puttest@example.com", "127.0.0.1")
        blob = json.dumps({"jaws": {"done": True}})
        status, _h, _b = http_request(srv.port, "PUT", "/api/achievements",
                                      headers={"Cookie": f"pinball_session={cookie}", "Sec-Fetch-Site": "same-origin",
                                               "Content-Type": "application/json",
                                               "Content-Length": str(len(blob))})
        # http_request sends no body for PUT without `form`; do it raw instead.
        conn = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=10)
        try:
            conn.request("PUT", "/api/achievements", body=blob,
                         headers={"Cookie": f"pinball_session={cookie}", "Sec-Fetch-Site": "same-origin",
                                  "Content-Type": "application/json", "Connection": "close"})
            status = conn.getresponse().status
        finally:
            conn.close()
        check(status == 204, f"an ordinary achievements PUT -> {status}, want 204")
    finally:
        srv.stop()


test("PG-02 regression: ordinary request bodies are unaffected by the read budget",
     t_pg02_normal_body_still_works)


# ---- PG-04: concurrent PUT corrupted the user's own achievements ---------
# Every writer for a uid shared one fixed `.{uid}.json.tmp` scratch file, so
# two in-flight PUTs interleaved into a single fd and os.replace published the
# splice. Reproduced on the FIRST attempt: a 47,601-byte blob of writer B's
# document followed by writer A's tail, which json.loads rejects. No attacker
# needed — two tabs or two devices syncing at once.

def t_pg04_concurrent_puts_never_corrupt():
    srv = ServerProc(label="pg04-race")
    try:
        cookie = sign_in(srv, "race@example.com", "127.0.0.1")

        def put(tag, size, out):
            blob = json.dumps({("m%03d" % i): {"tag": tag, "pad": tag * 60} for i in range(size)})
            conn = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=15)
            try:
                conn.request("PUT", "/api/achievements", body=blob,
                             headers={"Cookie": f"pinball_session={cookie}", "Sec-Fetch-Site": "same-origin",
                                      "Content-Type": "application/json", "Connection": "close"})
                out.append(conn.getresponse().status)
            except OSError as e:
                out.append(type(e).__name__)
            finally:
                conn.close()

        for rnd in range(12):
            statuses = []
            threads = [threading.Thread(target=put, args=(t, n, statuses))
                       for t, n in (("A", 700), ("B", 15), ("C", 300))]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            check(all(s == 204 for s in statuses),
                  f"round {rnd}: concurrent PUTs returned {statuses}, want all 204")
            _s, _h, body = http_request(srv.port, "GET", "/api/achievements",
                                        headers={"Cookie": f"pinball_session={cookie}"})
            try:
                doc = json.loads(body)
            except (ValueError, UnicodeDecodeError) as e:
                check(False, f"round {rnd}: achievements blob is CORRUPT ({len(body)}B) — {e}; "
                             f"head={body[:80]!r} tail={body[-80:]!r}")
                return
            tags = {v.get("tag") for v in doc.values()}
            check(len(tags) == 1,
                  f"round {rnd}: blob is a SPLICE of two writers' documents (tags={tags}) — "
                  "each PUT is a whole-document replace, so exactly one writer must win")
    finally:
        srv.stop()


test("PG-04: concurrent PUTs for one user never corrupt or splice the achievements blob",
     t_pg04_concurrent_puts_never_corrupt)


def t_pg04_no_scratch_files_left_behind():
    srv = ServerProc(label="pg04-scratch")
    try:
        cookie = sign_in(srv, "scratch@example.com", "127.0.0.1")
        blob = json.dumps({"jaws": {"done": True}})
        conn = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=10)
        try:
            conn.request("PUT", "/api/achievements", body=blob,
                         headers={"Cookie": f"pinball_session={cookie}", "Sec-Fetch-Site": "same-origin",
                                  "Content-Type": "application/json", "Connection": "close"})
            check(conn.getresponse().status == 204, "setup PUT should succeed")
        finally:
            conn.close()
        ach_dir = os.path.join(srv.state_dir, "achievements")
        leftovers = [f for f in os.listdir(ach_dir) if ".tmp" in f]
        check(not leftovers, f"temp scratch files left behind: {leftovers}")
        uid = urllib.parse.unquote(cookie.split(".")[0])
        mode = os.stat(os.path.join(ach_dir, f"{uid}.json")).st_mode & 0o777
        check(mode == 0o600, f"achievements blob mode is {oct(mode)}, want 0o600 (matches the D12 posture)")
    finally:
        srv.stop()


test("PG-04: a completed PUT leaves no scratch file and writes the blob 0600",
     t_pg04_no_scratch_files_left_behind)


# ---- PG-06: login CSRF — a magic link was not bound to any browser ---------
# GET /auth/verify minted a session for whoever opened the URL. An attacker
# could request a link for THEIR OWN address, get a victim to open it, and the
# victim would be silently signed in as the attacker — every achievement they
# recorded afterwards accruing to the attacker's account and readable via
# GET /auth/export. POST /auth/request now hands the requesting browser a
# nonce cookie; a click carrying it signs in as before, a click without it gets
# a confirmation page naming the address instead.

pg06_srv = ServerProc(label="pg06")


def t_pg06_same_browser_is_still_one_click():
    """The property that must NOT regress. A user who asks for a link and
    clicks it in the same browser gets a session immediately — no extra tap,
    no interstitial. This is the overwhelmingly common path, including iOS
    Mail opening the link in Safari (same cookie jar)."""
    email = next_email("pg06-same")
    ip = next_fake_ip()
    link = request_link(pg06_srv, email, ip)
    status, headers_list, _b = verify(pg06_srv, token_from_link(link), ip)
    check(status == 302, f"same-browser verify -> {status}, want an immediate 302")
    check(session_cookie(headers_list) is not None,
          "same-browser verify must still mint a session cookie in one click")


test("PG-06: a same-browser click still signs in immediately (no extra step)",
     t_pg06_same_browser_is_still_one_click)


def t_pg06_other_browser_gets_no_session():
    """The finding itself: a click from a browser that never asked for the
    link must not be handed a session."""
    email = next_email("pg06-other")
    ip = next_fake_ip()
    link = request_link(pg06_srv, email, ip)
    status, headers_list, body = verify(pg06_srv, token_from_link(link), ip, nonce=False)
    check(session_cookie(headers_list) is None,
          "a link opened in a browser that never requested it MUST NOT mint a session (PG-06 login CSRF)")
    check(status == 200, f"expected the confirmation page, got {status}")
    check(b"Confirm sign-in" in body, f"expected a confirmation page, got {body[:160]!r}")
    check(email.encode() in body,
          "the confirmation page must NAME the address — that is what lets a victim "
          "notice they are about to be signed in as someone else")


test("PG-06: a link opened in a different browser mints no session (login CSRF)",
     t_pg06_other_browser_gets_no_session)


def t_pg06_confirmation_does_not_burn_the_token():
    """Rendering the confirmation must leave the token spendable — otherwise
    the cross-device user is shown a button that cannot work."""
    email = next_email("pg06-spend")
    ip = next_fake_ip()
    link = request_link(pg06_srv, email, ip)
    token = token_from_link(link)
    verify(pg06_srv, token, ip, nonce=False)          # renders the confirmation
    status, headers_list, _b = http_request(
        pg06_srv.port, "POST", "/auth/verify", form={"token": token},
        headers={"X-Forwarded-For": ip, "Sec-Fetch-Site": "same-origin"})
    check(status == 302, f"confirming should sign in, got {status}")
    check(session_cookie(headers_list) is not None, "confirmed sign-in must mint a session")


test("PG-06: the confirmation page leaves the token spendable, and confirming signs in",
     t_pg06_confirmation_does_not_burn_the_token)


def t_pg06_confirm_post_is_same_origin_only():
    """Without this, the confirmation page would be decorative: a hostile page
    could auto-submit the form on the victim's behalf and the attack stands."""
    email = next_email("pg06-csrf")
    ip = next_fake_ip()
    link = request_link(pg06_srv, email, ip)
    token = token_from_link(link)
    status, headers_list, _b = http_request(
        pg06_srv.port, "POST", "/auth/verify", form={"token": token},
        headers={"X-Forwarded-For": ip, "Sec-Fetch-Site": "cross-site"})
    check(status == 403, f"cross-origin confirm -> {status}, want 403")
    check(session_cookie(headers_list) is None, "a cross-origin confirm must never mint a session")
    # ...and the token is still unspent, so the real user can still use it.
    status, headers_list, _b = http_request(
        pg06_srv.port, "POST", "/auth/verify", form={"token": token},
        headers={"X-Forwarded-For": ip, "Sec-Fetch-Site": "same-origin"})
    check(status == 302, f"the blocked attempt must not have burned the token, got {status}")


test("PG-06: the confirm POST refuses a cross-origin submission", t_pg06_confirm_post_is_same_origin_only)


def t_pg06_single_use_still_holds_through_confirm():
    """The confirm path must not create a second way to replay a token."""
    email = next_email("pg06-replay")
    ip = next_fake_ip()
    link = request_link(pg06_srv, email, ip)
    token = token_from_link(link)
    status, _h, _b = http_request(pg06_srv.port, "POST", "/auth/verify", form={"token": token},
                                  headers={"X-Forwarded-For": ip, "Sec-Fetch-Site": "same-origin"})
    check(status == 302, f"first confirm -> {status}, want 302")
    status, headers_list, _b = http_request(pg06_srv.port, "POST", "/auth/verify", form={"token": token},
                                            headers={"X-Forwarded-For": ip, "Sec-Fetch-Site": "same-origin"})
    check(status == 410, f"replaying a confirmed token -> {status}, want 410 Gone")
    check(session_cookie(headers_list) is None, "a replayed token must never mint a second session")


test("PG-06: a token consumed via confirm cannot be replayed", t_pg06_single_use_still_holds_through_confirm)


def t_pg06_nonce_cookie_is_enumeration_neutral():
    """The binding cookie must be set identically for a known address, an
    unknown one, and junk — otherwise its presence becomes the registration
    oracle the neutral 302 exists to prevent."""
    shapes = [next_email("pg06-neutral"), "definitely-not-registered@example.com", "not-an-email"]
    seen = []
    for value in shapes:
        _s, headers_list, _b = http_request(
            pg06_srv.port, "POST", "/auth/request", form={"email": value},
            headers={"X-Forwarded-For": next_fake_ip()})
        seen.append(link_nonce(headers_list) is not None)
    check(all(seen), f"pinball_link cookie presence differed across address shapes: {list(zip(shapes, seen))}")


test("PG-06: the binding cookie is set regardless of whether the address is known",
     t_pg06_nonce_cookie_is_enumeration_neutral)

pg06_srv.stop()  # same teardown convention as surface2_srv above


# ---- PG-07: non-latin-1 in a redirect target killed the handler thread ----
# `Location` is the only header this server builds from request-derived data
# (_serve_machine_guide's trailing-slash canonicalisation passes the
# percent-DECODED path). CPython encodes header values latin-1/strict, so any
# character above U+00FF raised UnicodeEncodeError out of send_response: the
# worker thread died, the client got NO RESPONSE at all, and ~20 lines of
# traceback went to the journal. One unauthenticated GET does it. Found during a
# SecLists content-discovery run against production, whose wordlist contained
# non-ASCII entries. Pre-existing (the stdlib did the same encode before this
# file overrode send_header) and distinct from PG-01, which rejected CONTROL
# characters but said nothing about merely-unencodable ones.

def t_pg07_non_latin1_redirect_does_not_kill_the_handler():
    srv = ServerProc(label="pg07-unicode")
    try:
        cases = [
            ("%F0%9F%8E%B0", "emoji U+1F3B0"),
            ("%E4%B8%AD%E6%96%87", "CJK"),
            ("%D0%BF%D1%80%D0%B8", "Cyrillic"),
            ("%C3%A9caf", "latin-1-range e-acute"),
        ]
        for encoded, label in cases:
            resp = _raw_get(srv.port, f"/machines/{encoded}/")
            check(resp.strip() != "",
                  f"{label}: NO RESPONSE — the handler thread died on an unencodable header (PG-07)")
            check(resp.startswith("HTTP/1.1 301"),
                  f"{label}: expected a 301 canonicalisation, got {resp.splitlines()[0]!r}")
            # The Location must be a valid ASCII URI reference (RFC 3986 §2.1).
            loc = [l for l in resp.split("\r\n") if l.lower().startswith("location:")]
            check(loc, f"{label}: 301 with no Location header")
            value = loc[0].split(":", 1)[1].strip()
            check(all(ord(c) < 128 for c in value),
                  f"{label}: Location is not ASCII: {value!r}")
        check("Traceback" not in srv.log_text(),
              "the service logged a traceback while serving these requests (PG-07 regression)")
    finally:
        srv.stop()


test("PG-07: a non-latin-1 character in a /machines path cannot kill the handler thread",
     t_pg07_non_latin1_redirect_does_not_kill_the_handler)


def t_pg07_ordinary_redirects_are_byte_identical():
    """The percent-encoding must not disturb the redirects that already work —
    deploy-prod.sh's Phase 4 smoke gate asserts the exact canonical string."""
    srv = ServerProc(label="pg07-plain")
    try:
        for target, want in (("/machines/jaws/", "/machines/jaws"), ("/machines/", "/machines")):
            status, headers_list, _b = http_request(srv.port, "GET", target)
            check(status == 301, f"{target} -> {status}, want 301")
            check(header(headers_list, "Location") == want,
                  f"{target} -> Location {header(headers_list, 'Location')!r}, want {want!r}")
        # And the query-bearing redirect the sign-in flow depends on.
        status, headers_list, _b = http_request(
            srv.port, "POST", "/auth/request", form={"email": "pg07@example.com"},
            headers={"Sec-Fetch-Site": "same-origin"})
        check(header(headers_list, "Location") == "/login?sent=1",
              f"sign-in redirect was mangled by percent-encoding: {header(headers_list, 'Location')!r}")
    finally:
        srv.stop()


test("PG-07 regression: ordinary and query-bearing redirects are unchanged",
     t_pg07_ordinary_redirects_are_byte_identical)


# ---- PG-08: chunked framing walked straight through the C1 guard ----------
# C1's comment claimed "Transfer-Encoding is checked here too". It was not:
# the guard read `not self._body_read AND (CL or TE)`, and _do_auth_request
# sets _body_read=True after reading ZERO bytes when there is no
# Content-Length — which is exactly the case for a chunked request. This
# server has no chunked parser, so the whole frame stayed in the socket and
# poisoned the connection Caddy pools across visitors. Measured against real
# Caddy 2.11.4: 15.3% of UNRELATED visitors' requests turned into 502.

def _chunked_post(port, path, extra_headers=b"", trailing=b""):
    """Send a chunked POST and return everything the server writes back."""
    smuggled = b"GET /health HTTP/1.1\r\nX-Attacker: smuggled\r\nX-Dangling: "
    frame = b"%x\r\n%s\r\n0\r\n\r\n" % (len(smuggled), smuggled)
    sock = socket.create_connection(("127.0.0.1", port), timeout=6)
    try:
        sock.sendall(
            f"POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            "Content-Type: application/x-www-form-urlencoded\r\n"
            "Sec-Fetch-Site: same-origin\r\n"
            "Transfer-Encoding: chunked\r\n".encode()
            + extra_headers + b"\r\n" + frame + trailing
        )
        buf = b""
        deadline = time.time() + 2.5
        while time.time() < deadline:
            try:
                chunk = sock.recv(65536)
            except (socket.timeout, OSError):
                break
            if not chunk:
                break
            buf += chunk
        return buf
    finally:
        sock.close()


def t_pg08_chunked_body_cannot_leave_leftovers():
    srv = ServerProc(label="pg08-chunked")
    try:
        resp = _chunked_post(srv.port, "/auth/request")
        # The signature of the bug: the server answered the POST AND then
        # parsed the leftover chunk-size token as a second request line,
        # emitting a bare unframed error body onto the same socket.
        # NB: a legitimate 411 page contains the stdlib's "Error response"
        # title, so that string is NOT the signal. The signal is the leftover
        # chunk-size token being parsed as a request LINE.
        check(b"Bad request syntax" not in resp,
              "the chunked frame was left unread and parsed as a follow-up request — "
              f"the pooled connection is poisoned (PG-08). Got: {resp[:220]!r}")
        check(resp.count(b"HTTP/1.1 ") <= 1,
              f"more than one response was written for a single request: {resp[:220]!r}")
    finally:
        srv.stop()


test("PG-08: a chunked body cannot leave unread bytes on the connection", t_pg08_chunked_body_cannot_leave_leftovers)


def t_pg08_chunked_is_rejected_with_411():
    srv = ServerProc(label="pg08-411")
    try:
        resp = _chunked_post(srv.port, "/auth/request")
        first = resp.split(b"\r\n", 1)[0].decode("latin-1", "replace")
        check("411" in first,
              f"a chunked request should be answered 411 Length Required rather than silently "
              f"accepted with its body ignored; got {first!r}")
    finally:
        srv.stop()


test("PG-08: chunked requests get a clean 411 instead of a 302 that ignored the body",
     t_pg08_chunked_is_rejected_with_411)


def t_pg08_ordinary_keepalive_still_works():
    """The unconditional TE arm must not disturb Content-Length keep-alive."""
    srv = ServerProc(label="pg08-keepalive")
    try:
        sock = socket.create_connection(("127.0.0.1", srv.port), timeout=8)
        try:
            for i in range(3):
                sock.sendall(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                time.sleep(0.25)
                resp = sock.recv(4096).decode(errors="replace")
                check(resp.startswith("HTTP/1.1 200"), f"keep-alive request {i + 1} broke: {resp[:60]!r}")
        finally:
            sock.close()
    finally:
        srv.stop()


test("PG-08 regression: ordinary Content-Length keep-alive is unaffected", t_pg08_ordinary_keepalive_still_works)


# ---- PG-09: unbounded document shape in the achievements blob -------------
# _put_achievements only checked isinstance(doc, dict). Deep nesting produced
# (a) a 302x export amplification — a legal 126.7KB PUT exported as 37.4 MB,
# built in memory against MemoryMax=256M — and (b) an UNCAUGHT RecursionError
# in GET /auth/export, because json.loads and json.dumps(compact) both survive
# depths that json.dumps(indent=2) does not, so the document stored fine and
# then killed the export thread on every retry, permanently.

def _put_json(port, cookie, raw_body):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        conn.request("PUT", "/api/achievements", body=raw_body,
                     headers={"Cookie": f"pinball_session={cookie}",
                              "Sec-Fetch-Site": "same-origin",
                              "Content-Type": "application/json", "Connection": "close"})
        r = conn.getresponse()
        r.read()
        return r.status
    finally:
        conn.close()


def t_pg09_deep_document_is_rejected():
    srv = ServerProc(label="pg09-depth")
    try:
        cookie = sign_in(srv, next_email("pg09-depth"), next_fake_ip())
        deep = ('{"a":' * 900) + "1" + ("}" * 900)
        status = _put_json(srv.port, cookie, deep)
        check(status == 400,
              f"a 900-deep document was accepted with {status} — it exports at ~300x amplification "
              "and can raise an uncaught RecursionError in json.dumps(indent=2) (PG-09)")
    finally:
        srv.stop()


test("PG-09: an over-deep achievements document is rejected at the write", t_pg09_deep_document_is_rejected)


ACHIEVEMENTS_MAX_BODY_LOCAL = pinball_auth.ACHIEVEMENTS_MAX_BODY


def t_pg09_export_survives_and_stays_small():
    """The real property: whatever is stored, export must answer and stay sane."""
    srv = ServerProc(label="pg09-export")
    try:
        cookie = sign_in(srv, next_email("pg09-export"), next_fake_ip())
        # The deepest document the cap still allows, repeated to fill the body.
        chain = ('{"a":' * 30) + "1" + ("}" * 30)
        body = "{" + ",".join(f'"m{i}":{chain}' for i in range(300)) + "}"
        check(len(body) < ACHIEVEMENTS_MAX_BODY_LOCAL, "test body must fit under the PUT cap")
        status = _put_json(srv.port, cookie, body)
        check(status == 204, f"a legal at-the-cap document should store, got {status}")
        st, _h, exported = http_request(srv.port, "GET", "/auth/export",
                                        headers={"Cookie": f"pinball_session={cookie}"})
        check(st == 200, f"export -> {st}, want 200")
        ratio = len(exported) / max(1, len(body))
        # The unit runs under MemoryMax=256M and json.dumps builds the whole
        # string in memory, so what matters is the absolute ceiling, not the
        # multiple. Pre-fix, a legal 126.7KB PUT exported as 37.4 MB.
        check(len(exported) < 4 * 1024 * 1024,
              f"export produced {len(exported) / 1024 / 1024:.1f} MB from a {len(body) / 1024:.0f} KB "
              f"stored blob ({ratio:.0f}x) — unbounded against MemoryMax=256M (PG-09)")
        return f"{len(body) / 1024:.0f} KB stored -> {len(exported) / 1024:.0f} KB exported ({ratio:.0f}x)"
    finally:
        srv.stop()


test("PG-09: export answers 200 and stays within a sane size multiple", t_pg09_export_survives_and_stays_small)


def t_pg09_huge_integer_literal_is_a_clean_400():
    """A >4300-digit int raises a BARE ValueError, not a JSONDecodeError — the
    old except tuple missed it and the worker thread died with no response.

    ENVIRONMENT NOTE (2026-07-31): the guard under test only EXISTS on CPython
    3.11+, where sys.set_int_max_str_digits caps int<->str conversion at 4300
    digits. On an older interpreter the 5000-digit literal simply parses, the
    PUT is legitimately accepted, and this test reports a 204 — a false failure
    that says nothing about the server code. macOS ships /usr/bin/python3 as
    3.9.6, so running the suite with the system Python fails here while the
    droplet (3.12.3) passes. Skip rather than fail, and name the reason.
    """
    if not hasattr(sys, "get_int_max_str_digits"):
        return (
            f"SKIPPED — {sys.version.split()[0]} has no int-digit limit "
            "(needs CPython 3.11+; the droplet runs 3.12)"
        )
    srv = ServerProc(label="pg09-bigint")
    try:
        cookie = sign_in(srv, next_email("pg09-bigint"), next_fake_ip())
        status = _put_json(srv.port, cookie, '{"a": ' + ("1" * 5000) + "}")
        check(status == 400, f"a >4300-digit integer literal -> {status}, want a clean 400 (PG-09)")
        # And the service must still be healthy afterwards.
        st, _h, _b = http_request(srv.port, "GET", "/health")
        check(st == 200, "service unhealthy after the oversized-integer PUT")
    finally:
        srv.stop()


test("PG-09: a >4300-digit integer literal is a clean 400, not a dead thread",
     t_pg09_huge_integer_literal_is_a_clean_400)


def t_pg14_malformed_signature_is_a_clean_401():
    """A non-ASCII byte in the cookie's signature field reached
    hmac.compare_digest, which raises TypeError on non-ASCII — killing the
    worker thread (502 + traceback) where a plain 401 was the right answer."""
    srv = ServerProc(label="pg14-sig")
    try:
        cookie = sign_in(srv, next_email("pg14"), next_fake_ip())
        uid, exp, _sig = cookie.split(".")
        for bad_sig, label in [
            ("é" * 64, "non-ASCII signature"),
            ("z" * 64, "non-hex signature"),
            ("ab", "short signature"),
            ("a" * 200, "over-long signature"),
        ]:
            status, _h, _b = http_request(
                srv.port, "GET", "/api/achievements",
                headers={"Cookie": f"pinball_session={uid}.{exp}.{bad_sig}"})
            check(status == 401, f"{label}: expected a clean 401, got {status}")
        st, _h, _b = http_request(srv.port, "GET", "/health")
        check(st == 200, "service unhealthy after malformed-signature cookies")
        check("Traceback" not in srv.log_text(), "a malformed signature produced a traceback (PG-14)")
    finally:
        srv.stop()


test("PG-14: a malformed session signature is a clean 401, not a dead thread",
     t_pg14_malformed_signature_is_a_clean_401)


def t_pg15_revoke_sessions_also_kills_outstanding_magic_links():
    """Bumping the epoch invalidates every cookie, but an unused magic link is
    a bearer credential too — leaving those live meant "revoke all sessions"
    was undone the instant somebody clicked a link already in an inbox."""
    srv = ServerProc(label="pg15-revoke")
    try:
        email = next_email("pg15")
        ip = next_fake_ip()
        cookie = sign_in(srv, email, ip)
        # A SECOND, still-unused link for the same account, issued before the revoke.
        spare = token_from_link(request_link(srv, email, ip))
        status, _h, _b = http_request(
            srv.port, "POST", "/auth/revoke-sessions",
            headers={"Cookie": f"pinball_session={cookie}", "Sec-Fetch-Site": "same-origin"})
        check(status == 200, f"revoke-sessions -> {status}, want 200")
        # The spare link must no longer mint a session.
        st, headers_list, _b = verify(srv, spare, ip)
        check(session_cookie(headers_list) is None,
              "an outstanding magic link still minted a session after revoke-sessions (PG-15) — "
              f"verify returned {st} with a Set-Cookie")
    finally:
        srv.stop()


test("PG-15: revoke-sessions also revokes outstanding magic links",
     t_pg15_revoke_sessions_also_kills_outstanding_magic_links)


def t_pg17_token_sweep_is_time_driven():
    """Retention used to run ONLY from issue(), so it was a function of traffic:
    with no sign-ins, rows holding typed-in addresses stayed on disk forever."""
    check(hasattr(pinball_auth.TokenStore, "sweep"),
          "TokenStore has no sweep() — retention is still traffic-driven (PG-17)")
    store = pinball_auth.TokenStore(os.path.join(tempfile.mkdtemp(prefix="pg17-"), "tokens.json"))
    # Hand-place one long-expired row and one live row.
    store._data = {
        "deadsel": {"verifier_hash": "x", "email": "old@example.com",
                    "exp": int(time.time()) - 99999, "used": False, "created_at": 0},
        "livesel": {"verifier_hash": "y", "email": "new@example.com",
                    "exp": int(time.time()) + 99999, "used": False, "created_at": 0},
    }
    store.sweep()
    check("deadsel" not in store._data, "sweep() did not drop the long-expired row")
    check("livesel" in store._data, "sweep() dropped a still-live row")
    check("old@example.com" not in json.dumps(store._data),
          "the expired row's email address survived the sweep")


test("PG-17: TokenStore.sweep() drops expired rows (time-driven retention)",
     t_pg17_token_sweep_is_time_driven)


# ---- PG-18: sign-in CODE, for the installed-PWA case ----------------------
# On iOS a Home-Screen web app has its OWN cookie jar and Mail opens links in
# Safari, so the emailed LINK physically cannot deliver a session into the
# installed app — rolo hit this and had to re-add the app after signing in.
# The same email now carries a short code that works in whichever app the user
# is standing in. It is the SAME credential in another form, so it must inherit
# every guard the link has.

pg18_srv = ServerProc(label="pg18-code")


def _issue_for(email, ip):
    """Request a link and return (token, code) straight off the dev log."""
    request_link(pg18_srv, email, ip)
    path = os.path.join(pg18_srv.state_dir, "dev_magic_links.jsonl")
    with open(path, encoding="utf-8") as f:
        rec = json.loads([l for l in f.read().splitlines() if l.strip()][-1])
    token = urllib.parse.parse_qs(urllib.parse.urlsplit(rec["link"]).query)["token"][0]
    return token, rec["code"]


def _post_code(email, code, ip, extra=None):
    headers = {"X-Forwarded-For": ip, "Sec-Fetch-Site": "same-origin"}
    headers.update(extra or {})
    return http_request(pg18_srv.port, "POST", "/auth/code",
                        form={"email": email, "code": code}, headers=headers)


def t_pg18_code_signs_in_with_no_cookies_at_all():
    """The whole point: no nonce cookie, no session, nothing — exactly what an
    installed PWA looks like when the link was opened in Safari."""
    email, ip = next_email("pg18-ok"), next_fake_ip()
    _token, code = _issue_for(email, ip)
    status, headers_list, _b = _post_code(email, code, ip)
    check(status == 302, f"redeeming a valid code -> {status}, want 302")
    check(session_cookie(headers_list) is not None, "a valid code must mint a session cookie")


test("PG-18: a sign-in code works with no cookies at all (the installed-PWA case)",
     t_pg18_code_signs_in_with_no_cookies_at_all)


def t_pg18_code_is_case_and_separator_insensitive():
    """People read this off a phone screen — hyphen, case and stray spaces
    must not matter."""
    email, ip = next_email("pg18-fmt"), next_fake_ip()
    _token, code = _issue_for(email, ip)
    typed = f" {code[:4].lower()}-{code[4:].lower()} "
    status, headers_list, _b = _post_code(email, typed, ip)
    check(status == 302, f"a lower-case hyphenated code -> {status}, want 302")
    check(session_cookie(headers_list) is not None, "normalised code must still sign in")


test("PG-18: the code is accepted lower-case, hyphenated and padded", t_pg18_code_is_case_and_separator_insensitive)


def t_pg18_code_and_link_share_one_single_use():
    """They are the same credential. Spending either must retire the other, or
    the code doubles the number of live bearer tokens per request."""
    email, ip = next_email("pg18-single"), next_fake_ip()
    token, code = _issue_for(email, ip)
    status, _h, _b = _post_code(email, code, ip)
    check(status == 302, f"code redemption -> {status}, want 302")
    st, headers_list, _b = verify(pg18_srv, token, ip)
    check(session_cookie(headers_list) is None,
          "the LINK still worked after its code was spent — they must share one single use")
    check(st == 410, f"the spent link -> {st}, want 410 Gone")
    st2, headers_list2, _b = _post_code(email, code, ip)
    check(st2 == 410, f"replaying the code -> {st2}, want 410")
    check(session_cookie(headers_list2) is None, "a replayed code must never mint a second session")


test("PG-18: the code and its link share one single use", t_pg18_code_and_link_share_one_single_use)


def t_pg18_wrong_code_is_401_and_counts_as_a_failure():
    email, ip = next_email("pg18-wrong"), next_fake_ip()
    _issue_for(email, ip)
    status, headers_list, _b = _post_code(email, "ZZZZ-ZZZZ", ip)
    check(status == 401, f"a wrong code -> {status}, want 401")
    check(session_cookie(headers_list) is None, "a wrong code must never mint a session")


test("PG-18: a wrong code is a 401 with no session", t_pg18_wrong_code_is_401_and_counts_as_a_failure)


def t_pg18_code_for_another_address_does_not_work():
    """The code is scoped to the address it was issued for — presenting a valid
    code against a different email must fail."""
    victim, attacker = next_email("pg18-victim"), next_email("pg18-attacker")
    ip = next_fake_ip()
    _t, victim_code = _issue_for(victim, ip)
    status, headers_list, _b = _post_code(attacker, victim_code, next_fake_ip())
    check(status in (401, 410), f"a code presented against another address -> {status}, want 401/410")
    check(session_cookie(headers_list) is None, "cross-address code use must never mint a session")


test("PG-18: a code is scoped to its own email address", t_pg18_code_for_another_address_does_not_work)


def t_pg18_code_route_is_same_origin_only():
    """Same CSRF posture as every other state-changing route here."""
    email, ip = next_email("pg18-csrf"), next_fake_ip()
    _t, code = _issue_for(email, ip)
    status, headers_list, _b = _post_code(email, code, ip, extra={"Sec-Fetch-Site": "cross-site"})
    check(status == 401, f"cross-origin code POST -> {status}, want 401")
    check(session_cookie(headers_list) is None, "a cross-origin code POST must never mint a session")
    # ...and the code survives, so a blocked attempt cannot burn the real user's credential.
    status, headers_list, _b = _post_code(email, code, ip)
    check(status == 302, f"the blocked attempt must not have spent the code, got {status}")


test("PG-18: the code route refuses a cross-origin POST", t_pg18_code_route_is_same_origin_only)


def t_pg18_code_alphabet_avoids_confusable_characters():
    """Read off a screen and typed by hand — 0/O, 1/I/L and 5/S must not be in
    play at all, or support becomes 'is that a one or an ell'."""
    for ch in "01OIL5S":
        check(ch not in pinball_auth.CODE_ALPHABET,
              f"confusable character {ch!r} is in CODE_ALPHABET")
    check(pinball_auth.CODE_LENGTH >= 8, "code is shorter than 8 characters")
    codes = {pinball_auth.generate_code() for _ in range(200)}
    check(len(codes) == 200, "generate_code() produced a collision in 200 draws")
    check(all(len(c) == pinball_auth.CODE_LENGTH for c in codes), "wrong code length")


test("PG-18: the code alphabet excludes confusable characters and codes are unique",
     t_pg18_code_alphabet_avoids_confusable_characters)


def t_pg18_email_carries_the_code():
    text, html_body = mail_sender.render_magic_link_email("https://pinball-genie.com/auth/verify?token=x", "ABCD2468")
    check("ABCD2468" in text, "the plain-text email does not contain the code")
    check("ABCD2468" in html_body, "the HTML email does not contain the code")
    check("Home Screen" in html_body, "the HTML email does not explain WHY the code exists")
    # Back-compat: the old single-arg call must still render.
    t2, h2 = mail_sender.render_magic_link_email("https://pinball-genie.com/auth/verify?token=x")
    check("ABCD2468" not in t2 and "ABCD2468" not in h2, "code leaked into a codeless render")


test("PG-18: the email carries the code in both parts", t_pg18_email_carries_the_code)

pg18_srv.stop()


# ===========================================================================
# Summary
# ===========================================================================
passed = sum(1 for _n, o in _results if o == "pass")
failed = sum(1 for _n, o in _results if o == "fail")
print(f"\n{passed} passed, {failed} failed (of {len(_results)})")
if failed:
    print("\nFAILED:")
    for n, o in _results:
        if o == "fail":
            print(f"  - {n}")
    sys.exit(1)

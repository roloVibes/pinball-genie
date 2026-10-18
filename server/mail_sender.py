#!/usr/bin/env python3
"""mail_sender — outbound email for pinball-auth's magic-link sign-in
(Phase 5, 2026-07-30). Python 3 stdlib only (urllib.request), imported as a
plain sibling module by pinball_auth.py (same directory on sys.path[0],
whether that's this repo's server/ locally or /opt/pinball-auth/ on the
droplet — deploy-prod.sh's step (d) uploads both files together; see its
comment there).

WHY THIS IS A SEPARATE MODULE, NOT INLINED INTO pinball_auth.py: the sender
is genuinely swappable (Resend today, DevLogSender until rolo has a Resend
account, conceivably something else later), and pulling the two concrete
implementations behind one call shape (`sender.send(to_email, link)`) means
pinball_auth.py's request handler never has to know or care which one is
live. Both raise on failure; the caller (pinball_auth.py's POST
/auth/request handler) already wraps the send in a broad try/except because
a mail-provider hiccup must NEVER produce a response distinguishable from
the neutral "check your inbox" one — see that file's ENUMERATION note.

WHY HTTPS-API SENDING AT ALL, NOT SMTP: DigitalOcean blocks outbound SMTP
(ports 25/465/587) on droplets by default (anti-spam policy applied to the
whole platform, not just this account) — an MTA on this box literally cannot
open an SMTP connection out. Resend's API is a plain authenticated POST,
which is exactly what urllib.request already does for nothing else in this
codebase but works the same way. Free tier: 3,000 sends/mo — see
pinball_auth.py's rate-limit constants, sized against that quota.

NEVER LOGGED (D4, 2026-07-30 security review): neither sender ever writes a
live token or a full recipient address to this service's own stdout —
ResendSender never logged either to begin with (Resend's own dashboard is
the delivery record); DevLogSender used to, and was fixed to redact its
stdout line and put the real link in a deliberately-opened 0600 file instead
— see DevLogSender's own docstring for the incident.

WHY A DEDICATED SENDING SUBDOMAIN (send.pinball-genie.com), NOT
admin@pinball-genie.com: transactional/bulk-ish mail (magic links, which by
nature bounce whenever someone mistypes their address or types a stranger's)
carries its own bounce/complaint reputation. Isolating it onto its own
subdomain with its own SPF/DKIM means a run of bad addresses can never touch
the deliverability of the admin@ mailbox Google Workspace already proved out
end-to-end (RUNBOOK.md's Phase 2) — a bounce storm on one subdomain doesn't
poison the other.
"""

from __future__ import annotations

import html
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

RESEND_API_URL = "https://api.resend.com/emails"
# Identifies us to Cloudflare, which fronts api.resend.com and rejects
# urllib's default Python-urllib signature outright — see ResendSender.send()
# for the full incident note. Any ordinary non-default UA works; a real
# product name and contact URL is the polite form and makes us identifiable
# in Resend's own request logs.
USER_AGENT = "pinball-genie/1.0 (+https://pinball-genie.com)"
# Read-only endpoint used by startup_self_test() — same host, same key, same
# Cloudflare edge as the send path, but delivers nothing and costs no quota.
RESEND_DOMAINS_URL = "https://api.resend.com/domains"
# The domain FROM_ADDR sends from, checked against the self-test's response so
# a key scoped to the wrong domain is caught at boot rather than at first
# sign-in. Kept in sync with FROM_ADDR below.
FROM_DOMAIN = "send.pinball-genie.com"
RESEND_TIMEOUT_SECONDS = 10  # a slow/hung Resend call must not pin a worker
# thread indefinitely — the Handler's own socket timeout (15s, see
# pinball_auth.py) is the outer bound; this is a tighter inner one so a
# flaky provider fails fast and the caller's try/except still gets control
# back well inside that outer bound.

FROM_ADDR = "Pinball Genie <no-reply@send.pinball-genie.com>"
REPLY_TO = "admin@pinball-genie.com"
SUBJECT = "Your Pinball Genie sign-in link"


def render_magic_link_email(link: str, code: str = "") -> "tuple[str, str]":
    """Returns (plain_text, html) bodies for the magic-link email. Both
    parts say the same three things the spec requires verbatim: the link,
    that it expires in 15 minutes, and "if you didn't request this, ignore
    this email" — Resend (like any transactional provider) expects a real
    multipart send, and a text-only inbox/client falls back to the plain
    part automatically."""
    text = (
        "Sign in to Pinball Genie\n\n"
        f"{link}\n\n"
        # PG-18: the code is the ONLY way to sign in inside an installed
        # iOS PWA — Mail opens the link in Safari, which has a separate
        # cookie jar, so the link can never reach the installed app.
        + (f"Or type this code into the app:\n\n    {code}\n\n" if code else "")
        + "This link expires in 15 minutes and works once.\n\n"
        "If you didn't request this, ignore this email — no account changes "
        "were made.\n"
    )
    # Escaped even though `link` is always server-generated (our own
    # https://.../auth/verify?token=... — see pinball_auth.py's
    # _build_magic_link) rather than user input: cheap insurance against a
    # future change making that no longer true, and it costs nothing here.
    safe_link = html.escape(link, quote=True)
    # PG-18. Escaped like the link even though it is server-generated from a
    # fixed alphabet — same cheap insurance, same reasoning as safe_link.
    safe_code = html.escape(code, quote=True)
    code_block = (
        '<p style="margin:16px 0 8px;font-size:13px;color:rgba(242,240,234,0.6);">'
        "Added Pinball Genie to your Home Screen? Open it and enter this code instead "
        "&mdash; the link above signs you in to your browser, not the installed app."
        "</p>"
        f'<p style="margin:0 0 16px;font-family:ui-monospace,Menlo,monospace;font-size:22px;'
        f'font-weight:700;letter-spacing:0.12em;color:#f5a623;">{safe_code}</p>'
    ) if code else ""
    html_body = f"""<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#16181d;color:#f2f0ea;padding:24px;">
    <table role="presentation" width="100%" style="max-width:420px;margin:0 auto;">
      <tr><td>
        <h1 style="font-size:18px;letter-spacing:0.04em;text-transform:uppercase;color:#f5a623;margin:0 0 16px;">Pinball Genie</h1>
        <p style="margin:0 0 20px;">Tap the button below to sign in. No password needed.</p>
        <p style="margin:0 0 24px;">
          <a href="{safe_link}" style="display:inline-block;background:#f5a623;color:#1a1200;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:10px;">Sign in to Pinball Genie</a>
        </p>
        {code_block}
        <p style="margin:0 0 8px;font-size:13px;color:rgba(242,240,234,0.6);">This link expires in <strong>15 minutes</strong> and works once.</p>
        <p style="margin:0;font-size:13px;color:rgba(242,240,234,0.6);">If you didn't request this, ignore this email — no account changes were made.</p>
      </td></tr>
    </table>
  </body>
</html>"""
    return text, html_body


class ResendSender:
    """Sends via Resend's HTTPS API (https://api.resend.com/emails), a plain
    Bearer-authenticated POST — no SDK, stdlib urllib.request only, per this
    repo's no-third-party-dependency rule."""

    def __init__(self, api_key: str):
        self._api_key = api_key

    def startup_self_test(self) -> bool:
        """Prove at boot that we can actually reach the Resend API, and say so
        loudly in the log either way. Returns True on success; NEVER raises —
        the site is public and must keep serving even if mail is broken.

        WHY THIS EXISTS. On 2026-07-31 Phase 5 deployed with a valid, correctly
        scoped, correctly installed API key — and every sign-in email failed,
        because Cloudflare (which fronts api.resend.com) rejected urllib's
        default User-Agent before the request ever reached Resend. The deploy
        script printed a full page of green ticks. Nothing was wrong with the
        key, the DNS, the domain verification, or the code that builds the
        message; the one broken thing was invisible to every check we had.

        It was invisible because two deliberate safety properties covered for
        each other: send failures are swallowed so a mail hiccup can't become
        an account-enumeration oracle, and the service logs the exception TYPE
        only so a token or address can't leak into the log. Both are correct
        in isolation. Together they turn a total outage into `reason=RuntimeError`
        and a user staring at "check your inbox" forever.

        A GET is the right probe: it needs the same key, the same host, the
        same TLS path and — critically — the same Cloudflare edge as the POST,
        so it catches exactly this failure, while sending nothing and costing
        nothing against the quota. `/domains` additionally proves the key can
        see the sending domain we are about to send from.
        """
        req = urllib.request.Request(
            RESEND_DOMAINS_URL,
            method="GET",
            headers={"Authorization": f"Bearer {self._api_key}", "User-Agent": USER_AGENT},
        )
        try:
            with urllib.request.urlopen(req, timeout=RESEND_TIMEOUT_SECONDS) as resp:
                body = resp.read(4096).decode("utf-8", errors="replace")
            ok = FROM_DOMAIN in body
            print(
                f"mail: Resend reachable (HTTP {resp.status}); sending domain "
                f"{FROM_DOMAIN} {'visible to this key' if ok else 'NOT FOUND IN THIS KEY SCOPE'}",
                file=sys.stderr,
            )
            if not ok:
                print(
                    f"WARNING: mail self-test could not see {FROM_DOMAIN}. Sign-in "
                    "emails will be REJECTED. Check the key's domain scope in the "
                    "Resend dashboard.",
                    file=sys.stderr,
                )
            return ok
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read(500).decode("utf-8", errors="replace")
            except Exception:
                pass
            hint = ""
            if "1010" in detail or e.code == 403:
                hint = (
                    " — HTTP 403 with 'error code: 1010' is CLOUDFLARE, not Resend: "
                    "the User-Agent was rejected before the request reached the API. "
                    "This is the 2026-07-31 outage; see send()'s User-Agent comment."
                )
            print(
                f"ERROR: mail self-test FAILED: HTTP {e.code}: {detail}{hint} "
                "SIGN-IN EMAILS WILL NOT BE DELIVERED. The site will keep serving.",
                file=sys.stderr,
            )
            return False
        except Exception as e:  # noqa: BLE001 — must never take the service down
            print(
                f"ERROR: mail self-test FAILED: {type(e).__name__}: {e}. "
                "SIGN-IN EMAILS WILL NOT BE DELIVERED. The site will keep serving.",
                file=sys.stderr,
            )
            return False

    def send(self, to_email: str, link: str, code: str = "") -> None:
        text, html_body = render_magic_link_email(link, code)
        payload = json.dumps(
            {
                "from": FROM_ADDR,
                "to": [to_email],
                "reply_to": REPLY_TO,
                "subject": SUBJECT,
                "text": text,
                "html": html_body,
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            RESEND_API_URL,
            data=payload,
            method="POST",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
                # REQUIRED — do not drop this back to urllib's default.
                #
                # api.resend.com sits behind Cloudflare, which blocks
                # urllib's default `User-Agent: Python-urllib/3.x` on browser
                # signature. The request never reaches Resend at all: it comes
                # back as `HTTP 403` with the body `error code: 1010`
                # (Cloudflare's "browser signature banned"), NOT as a Resend
                # API error, so nothing in the response mentions Resend, the
                # key, or the message.
                #
                # This shipped to production on 2026-07-31 and every single
                # sign-in email failed. It was invisible from the outside
                # because send failures are deliberately swallowed so that a
                # mail hiccup can't become an account-enumeration oracle (see
                # this file's header) — the user still saw "check your inbox"
                # and simply never received anything. The only trace was
                # `event=auth_request_error reason=RuntimeError` in the
                # service log, which logs the exception TYPE only, also
                # deliberately. Two safety properties combined to hide a total
                # outage; the startup self-test added alongside this comment
                # is what makes it loud instead.
                #
                # Proven directly on the droplet: same key, same payload,
                # same moment — default UA -> 403 error code: 1010; this UA
                # -> 200 with a message id.
                "User-Agent": USER_AGENT,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=RESEND_TIMEOUT_SECONDS) as resp:
                if resp.status >= 300:
                    raise RuntimeError(f"resend: unexpected HTTP {resp.status}")
        except urllib.error.HTTPError as e:
            # Resend puts the useful diagnostic in the body (bad address
            # shape, domain not verified yet, quota, ...) — read a bounded
            # amount of it into the exception so a startup/log check can see
            # WHY without ever putting that detail in the HTTP response this
            # module's caller sends back to the browser (it never does; see
            # this file's header).
            detail = ""
            try:
                detail = e.read(2048).decode("utf-8", errors="replace")
            except Exception:
                pass
            raise RuntimeError(f"resend: HTTP {e.code}: {detail}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"resend: network error: {e.reason}") from e


class DevLogSender:
    """No Resend key configured yet (rolo hasn't created a Resend account as
    of this writing — see this file's header). This is not a stub to delete
    later; it is the load-bearing local/dev delivery path and it is what
    keeps the magic-link flow fully testable end-to-end with zero external
    account: writing the link out is functionally identical to receiving it
    by email for every purpose except the actual mail transport.

    D4 FIX (2026-07-30 security review): this used to `print(f"DEV MAGIC
    LINK for {to_email}: {link}")` straight to this service's own stdout —
    i.e. a working, unexpired, single-use sign-in credential PLUS the
    address it belongs to, sitting in a log stream that (a) pinball_auth.py's
    privacy page and its own module docstring (:1055) both promise never
    happens ("emails are never logged"), and (b) under systemd lands in
    journalctl, which is broader-audience and longer-retained than a
    deliberately-opened file. The token and email no longer touch stdout at
    all: `send()` prints only a fully generic, redacted marker (no email, no
    domain, no token, not even a hint of which — see the print() below), and
    the actual link is written to a dedicated 0600 file under STATE_DIR
    (`dev_magic_links.jsonl`) that a developer has to go open on purpose to
    read, exactly the same "deliberately opened, not passively logged"
    posture used everywhere else in this codebase for secrets. The file
    write is best-effort: a developer/test harness losing the ability to
    read a just-issued dev link is an inconvenience, not a production
    incident (Resend, not DevLogSender, is what's actually live once a real
    key exists — see build_sender() below), so a failure here is warned
    about and swallowed rather than allowed to become a 500 on a public
    sign-in form."""

    def __init__(self, state_dir: "str | None" = None):
        self._state_dir = state_dir
        self._lock = threading.Lock()  # guards the shared JSONL file's
        # read-modify-... well, append — appends are the only op, but the
        # lock still keeps os.chmod from racing a concurrent send() and
        # keeps two threads' os.open/os.write/os.close sequences from
        # interleaving mid-line (each line is short enough to be a single
        # atomic write() on any POSIX fs, but there's no reason to rely on
        # that when a lock is this cheap).

    def send(self, to_email: str, link: str, code: str = "") -> None:
        # Fully generic — no email, no domain, no token, no length/shape
        # hint of either. See this class's docstring for why.
        print(
            "DEV MAGIC LINK: a sign-in link was issued (redacted — this "
            "process never logs a live token or address; see "
            "dev_magic_links.jsonl under STATE_DIR to read it deliberately)",
            flush=True,
        )
        if not self._state_dir:
            return
        try:
            os.makedirs(self._state_dir, exist_ok=True)
            path = os.path.join(self._state_dir, "dev_magic_links.jsonl")
            # PG-18: the code lands in the same deliberately-0600 dev file as the
            # link, and is just as much a live credential — never printed.
            line = json.dumps({"email": to_email, "link": link, "code": code, "issued_at": time.time()}) + "\n"
            with self._lock:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                try:
                    os.write(fd, line.encode("utf-8"))
                finally:
                    os.close(fd)
                # os.open's mode arg is still subject to umask (same trap as
                # D12 in pinball_auth.py's UserStore/TokenStore) — chmod
                # unconditionally after every write so the file can never be
                # left at whatever the umask-derived creation mode was.
                os.chmod(path, 0o600)
        except OSError as e:
            print(f"WARNING: could not write dev magic-link file: {e}", file=sys.stderr, flush=True)


def build_sender(key_path: str, state_dir: "str | None" = None):
    """Reads the Resend API key from `key_path` and returns a ResendSender,
    or a DevLogSender (with a loud one-time startup warning, not a crash) if
    the file is missing or empty. This MUST NOT raise: the site is live and
    public, and losing the key file (or never having had one) is exactly the
    "site keeps serving" case the module docstring promises — see
    pinball_auth.py's main(), which calls this once at startup.

    `state_dir`, when given, is passed straight through to DevLogSender so
    its (redacted-log-plus-deliberate-file) delivery path has somewhere to
    write — see that class's docstring (D4). Optional and defaults to None
    so existing callers (and this module's own test suite, which constructs
    a DevLogSender purely to check `isinstance`, never `.send()`) keep
    working unchanged."""
    try:
        with open(key_path, "r", encoding="utf-8") as f:
            key = f.read().strip()
    except OSError:
        key = ""
    if not key:
        print(
            f"WARNING: no Resend API key at {key_path} — using DevLogSender "
            "(magic-link emails are NOT sent; the link is written to a 0600 "
            "file under STATE_DIR instead — see DevLogSender's docstring). "
            "Expected until a real key is placed there; the service starts "
            "and serves normally either way.",
            file=sys.stderr,
        )
        return DevLogSender(state_dir)
    sender = ResendSender(key)
    sender.startup_self_test()
    return sender

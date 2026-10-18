// login.js — OPTIONAL UX polish only. The sign-in flow works with NO
// JavaScript at all: pinball_auth.py renders the email-entry state, the
// "check your inbox" confirmation, and the "too many attempts" state
// server-side via a template marker in login.html's .card class list (see
// that file's header comment for the exact substitution mechanism — this
// file deliberately does NOT spell that marker out; login.js is served RAW,
// same as login.css, so see login.css's own header comment for why),
// driven purely by the form's native POST and the resulting 302's query
// string. Nothing here is required for correctness or security.
//
// The only job this file does: disable the submit button (and relabel it)
// once the form is submitted, so an impatient double-click doesn't fire a
// second POST /auth/request while the first is still in flight. That is
// NOT a correctness fix — POST /auth/request is fine being called twice (it
// just issues a second valid link and spends a bit of the per-IP/per-email
// rate budget; see pinball_auth.py's REQUEST_LIMIT_* constants) — it's pure
// UX, and this script staying absent or failing to load changes nothing
// about whether sign-in works.
var form = document.querySelector('.signin-panel form')
if (form) {
  form.addEventListener('submit', function () {
    var btn = form.querySelector('button[type="submit"]')
    if (btn) {
      btn.disabled = true
      btn.textContent = 'Sending…'
    }
  })
}

// PG-18 (2026-07-31): remember the address just used to request a link, and
// prefill the code form's email field with it after the redirect. Pure
// convenience — the field is visible and typeable, because the case this
// feature exists for is the one where the code is entered in a DIFFERENT
// storage container (the installed PWA) from the one that requested it
// (Safari), where nothing was remembered. sessionStorage, not localStorage:
// this is one sign-in attempt, not a durable preference.
try {
  var emailInput = document.querySelector('.signin-panel input[type="email"]')
  if (form && emailInput) {
    form.addEventListener('submit', function () {
      try { sessionStorage.setItem('pg_last_signin_email', emailInput.value) } catch (e) {}
    })
  }
  var codeEmail = document.getElementById('signin-code-email')
  if (codeEmail && !codeEmail.value) {
    var remembered = sessionStorage.getItem('pg_last_signin_email')
    if (remembered) codeEmail.value = remembered
  }
  // Normalise as the user types: accept "abcd-efgh", "ABCDEFGH", spaces, etc.
  // The server normalises too (normalize_code) — this is only so the field
  // looks like what the email showed.
  var codeInput = document.getElementById('signin-code')
  if (codeInput) {
    codeInput.addEventListener('input', function () {
      var raw = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
      codeInput.value = raw.length > 4 ? raw.slice(0, 4) + '-' + raw.slice(4, 8) : raw
    })
  }
} catch (e) {
  // Never let optional polish break a page the flow does not need it for.
}

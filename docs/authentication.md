# Authentication

This page describes how people sign in to Construction RCM. It covers what each
part does, where the code is, what an operator can do when someone is locked
out, and where single sign-on (SSO) would fit. Finance teams approve real money
here, so every rule below is enforced in the server, not only in the screens.

| Piece | Code |
| --- | --- |
| Password hashing and the password rule | `src/server/auth/password.ts`, `password-rules.ts` |
| Sign-in, including the second step | `src/server/auth/sign-in.ts`, `src/server/services/team.ts` (`authenticate`, `createSession`, `resolveSession`) |
| Two-step verification (TOTP, recovery codes) | `src/server/auth/totp.ts`, `mfa.ts`, `qr.ts` |
| Password reset | `src/server/auth/password-reset.ts`, `scripts/reset-password.ts` |
| Session cookies | `src/server/auth/session.ts` |
| Throttling | `src/server/auth/throttle.ts` |
| Audit of account events | `src/server/auth/account.ts` (`recordAccountEvent`) |
| Screens | `src/app/(auth)/**`, `src/app/mfa-required`, `src/app/(app)/settings/{profile,team,policy}` |
| Tests | `tests/auth.test.ts`, `tests/team.test.ts` |

## Passwords

**Storage.** Passwords are hashed with scrypt (N = 16384, r = 8, p = 1, 64-byte
key) and a random 16-byte salt per password. They are compared in constant time.
The plain password is never stored or logged.

**The rule.** It applies to sign-up, accepting an invitation as a new user,
changing a password and setting one through a reset link. A password:

- must be at least 10 characters and at most 200;
- does not need particular kinds of character (no "one capital, one symbol");
- must not be on a built-in list of common passwords, or be one character repeated;
- must not be the account's email address or name.

The rule is checked when a password is set, never at sign-in. Existing accounts
whose password predates the common-password and email/name checks keep working. The same
function (`passwordProblem`) runs in the browser as you type and in the server,
which is the check that counts.

**Changing your password** (Settings → Profile) needs your current password.
The new one must be different. Afterwards every other session on the account is
signed out, along with any sign-in waiting on its second step and any unused
reset link. The session you used to change it stays signed in.

## Signing in

1. The email and password are checked. A wrong password and an unknown email get
   the same message, "That email and password do not match an account". For an unknown email the
   server still checks the password against a dummy hash, so the two take about
   the same time.
2. If the account does not use two-step verification, a session is created.
3. If it does, **no session is created yet.** The server creates a login
   challenge instead. This is a row whose id is the sha256 of a random token, and
   the token goes in an HttpOnly cookie, `rcm_login`. The browser is sent to
   `/login/verify`.
4. On `/login/verify` the person enters a 6-digit code from their authenticator
   app or one of their recovery codes. A challenge lasts 10 minutes and accepts at
   most 5 codes. After that they start again from the password.
5. A correct code creates the session, marked as having passed the second step
   (`sessions.mfaVerifiedAt`), and deletes the challenge.
6. After a complete sign-in the browser is remembered for that account (see
   "Remembered browsers" under "Throttling").

A session without that mark is refused for any account that has two-step
verification on. A session left over from before someone turned it on cannot be
used to skip it.

**Accepting an invitation with an existing account.** The invitation page asks
for the account's password. For an account without two-step verification the
person joins and is signed in to the inviting organisation. For an account with
it, the password only starts a login challenge that carries the invitation
(`loginChallenges.invitationId`); nothing is joined and the invitation is not
used up. When the code is right, the membership and the session are created
together, and the session opens in the organisation that invited them. If the
invitation was revoked or expired in the meantime, they are signed in without
joining and told so. Joining on the password alone would let someone who knows
the password put the account in an organisation they control and recover it
from there.

## Two-step verification

**What it is.** Two-step verification uses time-based one-time passwords (TOTP,
RFC 6238), the codes shown by Google Authenticator, Microsoft Authenticator,
1Password, Authy and similar apps. It is built on `node:crypto` and has no third-party
TOTP library:

- HMAC-SHA1, 6 digits, 30-second steps.
- Codes from the current step and one step either side are accepted, which allows
  for up to about 30 seconds of clock drift.
- The secret is 160 random bits, shown in base32.
- The code is tested against the RFC 6238 and RFC 4226 test vectors.

**Replay.** The step of the last accepted code is stored
(`users.mfaLastCounter`). A code is only accepted if its step is later than that,
so a code that has been used once, or any earlier code, is refused. The user row
is locked while a code is checked, so two requests with the same code cannot
both succeed.

**Storage.** The secret is encrypted with AES-256-GCM (`encryptJson`, keyed from
`RCM_SECRET_KEY`) in `users.mfaSecret`. It counts as on only once
`users.mfaEnabledAt` is set. Recovery codes are stored only as keyed hashes
(HMAC-SHA256 with a key derived from `RCM_SECRET_KEY`) in `users.mfaRecoveryCodes`.
A code carries about 49 bits, so a plain hash taken from a copy of the database
could be reversed by brute force; the keyed hash cannot be checked without the key.

**Setting it up** (Settings → Profile → Two-step verification):

1. The person enters their current password. Turning two-step verification on
   signs out every other session and a password reset does not undo it, so
   someone holding a stolen session must not be able to lock the owner out with
   their own phone. The server then makes a new secret and stores it encrypted.
   The secret does nothing yet.
2. The page shows a QR code and the key to type in by hand. The QR code is drawn
   on our server as an SVG, so the key is never sent to a QR-code service.
3. The person enters a code from the app. If it is right, two-step verification
   is on.
4. Ten recovery codes are shown once. Each looks like `abcde-fghjk`. They can be
   copied or downloaded, and the dialog cannot be closed until the person ticks
   that they have saved them. The server keeps only their hashes, so they can
   never be shown again, only replaced.

When two-step verification is turned on, the current session is marked as
verified and every other session on the account is signed out.

**Recovery codes** each work once, in place of an app code, at sign-in and
anywhere a code is asked for. A used code is removed. When three or fewer are
left, the profile page and the sign-in step say so.

**Turning it off** and **replacing the recovery codes** both need the current
password and a valid code from the app or a recovery code. Replacing the codes
makes the old ones stop working straight away. If an organisation you belong to
requires two-step verification, the dialog for turning it off warns you that you
will not be able to work there.

**If `RCM_SECRET_KEY` changes**, stored TOTP secrets can no longer be read and
recovery codes no longer match, so the second step fails for everyone who uses
it. Remembered browsers are forgotten too. Treat the key as permanent. If it is
lost, reset two-step verification for the people affected (see "Operator
recovery").

## Requiring two-step verification for an organisation

An owner or admin can turn on **Require two-step verification for every member**
in Settings → Review policy → Security. It is stored as `requireMfa` in the
organisation's settings.

- It is a team decision, so it needs `team:manage` (owners and admins).
  Controllers can change the review policy but not this setting.
- You can only turn it on if your own account already has two-step verification.
  Otherwise the click would lock you out of the organisation, so the server
  refuses and the page explains why.
- The Security section shows how many active members have not set it up. Settings
  → Team has a Two-step column.

**Enforcement.** The rule is applied in `resolveSession`. Every page, server
action and API route gets its organisation context from there. If the session's
organisation requires two-step verification and the person has not turned it
on, the session resolves with **no organisation context** and `mfaRequired` set.
As a result:

- `requireCtx()` (every page and server action in the app) redirects to
  `/mfa-required`. That page explains the rule, runs the setup flow, offers to
  switch to one of the person's other organisations that do not require it, and
  offers to sign out. Once setup is done the person continues into the organisation.
- API routes get no context and refuse the request. See "Known gaps" for the
  status code.
- Nothing in that organisation can be read or changed until the person has set
  up two-step verification. Their account-level actions (Settings → Profile,
  signing out) still work.

Turning the requirement on or off is recorded in the organisation's audit
trail.

## Password reset

A reset link is a URL of the form `APP_URL/reset-password/<token>`. Every link,
however it was made:

- is single-use: the token is stored only as a sha256 hash (`passwordResets.tokenHash`)
  and is claimed in one atomic update, so two uses at once cannot both succeed;
- expires 60 minutes after it is created;
- replaces any earlier unused link for the same account;
- when used, sets the new password (subject to the password rule), records
  `passwordChangedAt`, signs the account out on every device and cancels any
  pending sign-in challenge;
- **does not sign anyone in.** The person signs in afterwards with the new password;
- **does not turn off two-step verification.** After a reset, someone who has
  only the email account still needs the second step.

There are three ways to get a link.

**1. "Forgot password?" by email.** The link is under the password field on the
sign-in page and goes to `/forgot-password`.

- If email delivery is configured (`RESEND_API_KEY` and `EMAIL_FROM`), the page
  asks for an email address. It always answers with the same neutral message,
  whether or not an account exists: "If … has an account, a link … is on its way."
- The email is sent after the response, so its timing does not show whether an
  account exists.
- An address can request at most 3 links an hour. Requests beyond that get the same
  neutral message and send nothing.
- If email is **not** configured, the page says so plainly. It tells the person
  to ask an owner or admin of their organisation, or whoever runs the deployment.
  The page does not pretend an email was sent.

**2. From an owner or admin.** Settings → Team → a member's menu → *Create
password reset link…*.

- This needs `team:manage`. The admin can only use it on an active member of their
  own organisation, and only an owner can use it on another owner. Nobody can use
  it on themselves this way.
- The link is shown once, with a copy button. It is never stored in plain text and
  cannot be shown again.
- The member's current password keeps working until the link is used.
- The member gets an in-app notification. The event is recorded in the audit trail
  of every organisation the member belongs to, naming the admin.

**3. From the operator**, with `pnpm reset-password <email>`. See below.

## Admins resetting a member's two-step verification

For a member who has lost both their phone and their recovery codes: Settings →
Team → the member's menu → *Reset two-step verification…*. The same permission
rules apply as for reset links (`team:manage`, own organisation, owners only for
owners, never yourself).

**Only for members who belong to no other organisation.** Resetting someone's
password or two-step verification hands over the whole account, including its
access to every other organisation it belongs to, and anyone can become an owner
by signing up. So an owner or admin can create a reset link or reset two-step
verification only for a member with no membership in any other organisation
(demo workspaces, which hold sample data, do not count). For anyone else the
message says they belong to another organisation, without naming it, and points
to "Forgot password?" and to the operator (see "Operator recovery"). This
replaces an earlier version in which an admin of one organisation could recover
a member who also belonged to another; a security review showed that a
self-made organisation could use that to take over members of a real one.

The reset clears the member's secret and recovery codes and signs them out on
every device. They are notified in the app, and the reset is recorded in the
audit trail of each organisation they belong to. They can then sign in with
their password alone and set up two-step verification again. If an organisation
requires it, they are sent straight to the setup page.

The dialog asks the admin to confirm who is asking, for example by phoning a
number they already have. Anyone who knows the password could otherwise get in
once two-step verification is reset.

## Sessions

- **Cookie.** The session cookie is `rcm_session`. It is HttpOnly and SameSite=Lax.
  It is Secure in production, unless `APP_URL` is plain `http://localhost` or
  `http://127.0.0.1`, so that a production build can be tried locally. The login
  challenge cookie `rcm_login` and the remembered-browser cookie `rcm_device`
  have the same flags.
- **Storage.** The cookie holds a random 32-byte token. The database stores only its
  sha256 hash (`sessions.id`). A copy of the sessions table cannot be used to sign in.
- **Lifetime.**
  - A session ends 14 days after sign-in, whatever happens (absolute lifetime,
    unchanged from before).
  - It also ends after 14 days without use (idle timeout). With a 14-day absolute
    lifetime the idle timeout cannot end a session sooner. It starts to matter if
    the absolute lifetime is ever raised. See "Known gaps".
  - Signing out deletes the session row, so the cookie stops working even if a copy
    of it survives.
- **What is recorded.** Each session records the browser's user agent (at most 400
  characters), the client address and when it was last used. The address is the
  address described in "Client addresses" below. The last-used time is updated
  at most once every 5 minutes, so reading a page does not write to the database
  each time.
- **Signed-in devices** (Settings → Profile):
  - The page lists every live session, for example "Chrome on macOS", with its
    address, organisation, sign-in time and last use. The current one is marked.
  - You can sign out any other session, or all other sessions at once.
  - Each row is identified by an id derived from the stored hash, so the browser
    never sees anything that could be used as a session.
  - Signing sessions out is recorded in the audit trail.
- **Everything else that signs sessions out:**
  - changing your password (every other session);
  - using a reset link (every session);
  - turning on two-step verification (every other session);
  - an admin resetting your two-step verification (every session);
  - being deactivated in an organisation (that organisation's sessions; existing
    behaviour).

## Throttling

Attempts are recorded in the `authAttempts` table, in the database rather than in
memory. The limits therefore survive a restart and are shared by every instance
of the app.

| What | Limit | Counted | Remembered browser |
| --- | --- | --- | --- |
| Wrong passwords for one email, from one address | 8 in 15 minutes | Failures since the last success for that pair | Also held back |
| Wrong passwords for one email, from anywhere | 8 in 15 minutes | Failures since that account's last successful sign-in | Not held back |
| Wrong passwords from one address, any email | 30 in 15 minutes | All failures from that address | Not held back |
| Wrong passwords when confirming a change while signed in | 8 in 15 minutes | Failures since the last success | n/a |
| Wrong second-step codes for one account | 10 in 15 minutes, across every challenge | Failures | n/a |
| Codes per sign-in challenge | 5 | Then sign in again | n/a |
| Reset-link requests for one email | 3 an hour | Every request | n/a |
| New accounts from one address | 10 an hour | Every sign-up | n/a |

**Remembered browsers.** After a complete sign-in the browser keeps an HttpOnly
cookie, `rcm_device`, for 180 days. It holds, for up to five accounts, a keyed
hash (HMAC with a key derived from `RCM_SECRET_KEY`) of the account id and its
current password hash, so it stops counting when the password changes and
cannot be made without the key. Nothing is stored in the database. It grants
nothing on its own: the password and the second step are still asked for. Its
only effect is on the limits marked above. Wrong passwords for an address from
strangers lock that address for browsers that have never signed in to it, but
the owner's usual browser can still sign in, so guessing at someone's address
cannot keep them out of their own account. Likewise, wrong passwords sent in an
office's name cannot lock out the people who work there. However many
addresses a guesser uses, an account takes at most 8 wrong passwords per 15
minutes from browsers that have never signed in to it. In production without
`RCM_SECRET_KEY` no browser is remembered.

- **Messages.** When a limit is reached the person is told to try again in a few
  minutes. The message is the same for an existing and a non-existent account, and
  for reset requests nothing changes on screen at all.
- **What counts.** Checks of your current password while signed in (changing it,
  turning two-step verification on or off, replacing recovery codes) have their
  own count, so strangers guessing at the sign-in page do not stop the owner from
  changing their password. Completing a password reset clears the per-email count.
- **Sign-up** answers "An account with that email already exists" for a taken
  address, which tells the asker that the address has an account. The per-address
  limit on new accounts keeps that from being used to test addresses in bulk.
  Answering neutrally would need a confirmation email for every sign-up; see
  "Known gaps".
- **Concurrency.** An attempt is reserved, as a failure, before the password or code
  is checked. It is marked successful afterwards. The reservation happens under a
  per-subject PostgreSQL advisory lock, so parallel requests cannot all slip
  under the limit. A test fires 20 parallel wrong passwords and checks that
  exactly 8 are evaluated. Another test runs two separate connection pools as two
  instances.
- **Housekeeping.** Attempts older than 24 hours, and challenges, reset links and
  sessions that expired more than 24 hours ago, are deleted opportunistically:
  on about 1 in 50 attempts.

### Client addresses

Next.js does not give server actions the network connection, so the client's
address comes from a header, and a header is only as trustworthy as whatever
sets it (`src/server/auth/request-meta.ts`):

- **`RCM_CLIENT_IP_HEADER`** names a header that the hosting platform sets itself
  and overwrites if a client sends one: `cf-connecting-ip` behind Cloudflare,
  `fly-client-ip` on Fly.io, `x-real-ip` on Vercel. When it is set, only that
  header is read.
- **Otherwise `X-Forwarded-For` is read from the right.** Each proxy appends the
  address it received the request from, so with `RCM_TRUSTED_PROXY_HOPS` proxies
  in front of the app (default 1: one load balancer or reverse proxy, such as an
  AWS ALB or nginx with `$proxy_add_x_forwarded_for`) the client is that many
  entries from the end. Entries further left were written by the client and are
  ignored. If there are fewer entries than proxies, no address is used.
- **With nothing in front of the app**, Next.js fills `X-Forwarded-For` from the
  connection only when the request has none, so a client can claim any address.
  Do not run it that way in production: put it behind a proxy or platform that
  sets the header. The per-email limit does not depend on the address, so an
  account still takes at most 8 wrong passwords per 15 minutes from browsers
  that never signed in to it; what a forged address defeats is the per-address
  limit on guessing across many accounts.

An earlier version took the first (leftmost) entry, which the client controls
even behind an appending proxy.

## Audit trail

Account events are recorded with `recordAudit` in the audit trail of **every
organisation the person is an active member of**, so each organisation's admins
see what happened to their members. Summaries are plain sentences. They never
contain passwords, tokens, links, secrets or codes.

| Action | When |
| --- | --- |
| `team.password_changed` | Someone changed their own password (and how many other sessions were signed out) |
| `team.password_reset_issued` | An admin created a reset link for a member (who, for whom), or the operator created one |
| `team.password_reset_completed` | A reset link was used (and whose link it was) |
| `team.mfa_enabled` / `team.mfa_disabled` | Someone turned two-step verification on or off |
| `team.mfa_recovery_codes_regenerated` | Someone replaced their recovery codes |
| `team.mfa_recovery_code_used` | Someone signed in with a recovery code |
| `team.mfa_reset` | An admin or the operator reset someone's two-step verification |
| `team.session_revoked` | Someone signed out one, or all, of their other sessions |
| `policy.updated` | Requiring two-step verification was turned on or off (alongside review-policy changes) |

An event done by the person themselves is attributed to them. An event done by
an admin is attributed to the admin; in the admin's other organisations it notes
"acting as Admin of …". Events done by the operator script or by a reset link
are attributed to the system.

## Operator recovery

Use this when someone is locked out and cannot be helped from inside the app.
Typical cases are a sole owner who has forgotten their password on a deployment
that cannot send email, or a sole owner who has lost their phone and recovery
codes.

```sh
# A one-time reset link (60 minutes, single use, replaces earlier links)
pnpm reset-password owner@example.com

# Also turn off two-step verification, for an owner with no phone, no recovery
# codes and no other owner or admin to reset it
pnpm reset-password owner@example.com --reset-two-step
```

1. **Confirm who you are dealing with**, through a channel you already trust,
   before running anything. The link is as good as their password until it is used
   or expires. `--reset-two-step` removes their second step.
2. Run the command where the app's database is. For PostgreSQL, set
   `DATABASE_URL`. For the embedded database, stop the app first, because only one
   process can open it at a time. Set `APP_URL` to the address people use, or the
   link will point at `http://localhost:3000`.
3. Give the printed link to the person directly. It is printed once and not stored.
4. They open it, choose a new password (the rule applies) and sign in. If they
   used `--reset-two-step` and an organisation requires two-step verification,
   they are taken to set it up straight away.
5. The audit trail of each of their organisations records that the system operator
   created the link, and reset two-step verification if you used that flag.

If no account signs in with that email, the script says so and changes nothing.

## Single sign-on (SSO): evaluation

**Not implemented.** This section is the assessment for deciding when to build it.

**What IT teams ask for.** Mid-size and large general contractors usually run
Microsoft 365, so the most common request is "sign in with Microsoft" through
**Entra ID** (formerly Azure AD). Next come **Okta** and **Google Workspace**. In
practice that means:

- **OIDC** (OpenID Connect). Entra ID, Okta and Google all support it, and it is
  the simpler protocol to implement well.
- **SAML 2.0.** Older or stricter IT departments still require it, and some
  security questionnaires ask for it by name.
- Often, once SSO exists: **enforced SSO** for the company domain (no passwords
  for those people), automatic removal when someone leaves, either through
  **SCIM** provisioning or at least just-in-time sign-in checks, and group-to-role
  mapping.

**Where it would plug in.**

- *Sign-in.* An OIDC or SAML callback route would verify the identity provider's
  assertion. It would then call the same `createSession(db, userId, orgId, meta)`
  in `src/server/services/team.ts` that password sign-in uses, with the session
  marked as verified. Sessions, cookies, the device list, idle and absolute
  timeouts, and sign-out would need no change.
- *Per-organisation configuration.* A new table, for example `ssoConnections`,
  would hold `orgId`, protocol, issuer or metadata URL, client id, an encrypted
  client secret (`encryptJson`, like integration tokens), the verified email
  domains, and whether SSO is enforced.
- *Domain claim.* An organisation must prove it owns a domain (a DNS TXT record)
  before it can route that domain's sign-ins to its identity provider. Without
  this, any customer could claim `@bigcontractor.com` and take over those
  accounts. This is the part that most needs care.
- *Just-in-time provisioning.* On the first SSO sign-in from a claimed domain,
  `acceptInvitation`'s logic in `team.ts` would create the user and membership with
  a default role (for example Project Manager, the least access). An admin could
  then promote them. Group-to-role mapping can come later.
- *Linking existing accounts.* Someone who already has a password account with the
  same email would be linked by the verified email from the identity provider.
  Under enforced SSO their password would stop working for that organisation.
- *Interaction with `requireMfa`.* A person who signed in through the company's
  identity provider has already passed that provider's MFA policy, which is
  usually Conditional Access or Okta policy. Asking for our TOTP code too would
  annoy users without adding much. The usual rule:
  - SSO sessions satisfy `requireMfa`, marked by `mfaVerifiedAt` and an `sso`
    flag on the session.
  - The organisation's settings page says MFA is then the identity provider's
    responsibility.
  - Password sign-ins to the same organisation still need our second step.
- *Multiple organisations.* A user in two organisations, one with enforced SSO,
  would need the session's organisation context to remember how it was reached.
  `resolveSession` would refuse an SSO-enforced organisation for a session that
  came in by password.

**Cost.** OIDC with Entra ID, Okta and Google is about 1 to 2 weeks with a
well-maintained library such as `openid-client`. That covers per-organisation
configuration screens, domain verification, just-in-time provisioning and tests
against each provider's developer tenant. SAML adds another 1 to 2 weeks, and it
is where most SSO security bugs live (XML signature wrapping), so it should use a
proven library, never a hand-rolled parser. SCIM is a further 1 to 2 weeks. A
hosted broker (WorkOS, Auth0, Stytch, Clerk) cuts this to a few days, for a
per-connection monthly fee and an outside dependency in the sign-in path.

**Recommendation.** Do not build SSO for the pilot. The pilot customers are small
finance teams. Strong passwords, TOTP with recovery codes, an organisation-wide
`requireMfa` switch, session visibility and an audit trail answer the security
questions such teams ask. Build **OIDC first, Entra ID first**, when the first
customer's IT team makes it a condition of purchase. That condition, not a
nice-to-have, is the trigger. Before writing it, compare the broker price with
the 2 to 4 weeks of in-house work. A broker is likely the better choice until
several customers need SSO. Add SAML only for a customer who cannot use OIDC.
Whichever route is chosen, build the domain claim first.

## Known gaps

These are known and deliberate for now, or need changes outside the
authentication code:

- **API routes return 401, not 403,** for a member whose organisation requires two-step
  verification they have not set up. The request is refused either way, because
  there is no context. The fix is one line in `src/server/http.ts` (`apiCtx`):
  return 403 when `session.mfaRequired` is set.
- **The root URL and `/welcome`** do not yet know about `mfaRequired`. Opening `/`
  directly sends such a member to `/welcome` ("You are not part of an organisation")
  instead of `/mfa-required`. Every page inside the app redirects correctly.
  The fix is to check `session.mfaRequired` in `src/app/page.tsx` and
  `src/app/welcome/page.tsx`.
- **Members of more than one organisation** cannot be recovered by any of their
  organisations' admins (see "Admins resetting a member's two-step verification").
  They reset their own password by email, or the operator helps. If such members
  become common, consider a recovery that every organisation they belong to must
  approve.
- **Sign-up reveals that an address has an account** (limited to 10 sign-ups per
  address an hour). Answering neutrally needs email confirmation of every new
  account, which needs email delivery to be set up.
- **Accounts are not confirmed by email.** Someone can sign up with an address they
  do not own. They get an empty organisation of their own and nothing else: they
  cannot join an organisation without its invitation, and that invitation goes to
  the real owner of the address.
- **Reset-request limit.** Three reset requests per email per hour can be used up
  by someone else, which delays a real reset by up to an hour.
- **The idle timeout equals the absolute lifetime** (14 days), so it never ends a
  session first. Lower the idle timeout, or raise the absolute lifetime (to 30 days,
  for example), to make it meaningful.
- **Reset-request timing.** For an existing account a reset request writes a link
  row, which takes slightly longer than for an unknown email. The email itself is
  sent after the response.

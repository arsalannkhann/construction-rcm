# Email providers: what was checked, and what is still unverified

Zephric sends email through **Resend** (invitations, password-reset links,
messages to subcontractors) and receives billing packages through an
**inbound webhook** in Postmark's format. Neither provider has been used from
this repository: there is no Resend key and no Postmark account. This page
records what the code was checked against, on 2026-11-16, in each provider's
public documentation, and what the owner must still verify with a real account.

## Outbound: Resend (`src/server/email.ts`)

| Documented behaviour | What Zephric does |
|---|---|
| Every request must send a `User-Agent` header; without one the API answers 403. | Sends `User-Agent: Zephric/1.0`. |
| `Idempotency-Key` header: the same key and body within 24 hours return the first answer and send nothing new. The same key still in progress is 409 `concurrent_idempotent_requests`; the same key with a different body is 409 `invalid_idempotent_request`. | Every message carries a key: the record's id for messages to subcontractors and invitations, a fresh id per reset link. After a lost answer, a 5xx, a 429 `rate_limit_exceeded` or a 409 `concurrent_idempotent_requests`, it tries once more with the same key. Without a key it never retries. |
| 429 is either a rate limit (`rate_limit_exceeded`, 10 requests a second per team by default) or a spent quota (`daily_quota_exceeded`, `monthly_quota_exceeded`). | Retries the rate limit once. A spent quota is reported as such ("The email account has used up its sending quota") and not retried. |
| The reply address field is `reply_to`. | Sent only when there is one. |

**When no answer comes back** (a timeout after 15 seconds, or a dropped
connection, twice), the provider may still have sent the message. Zephric
records it as **Not confirmed**, not as failed: the application is not put on
hold, the reviewer is told to check with the recipient, and sending the same
text again is refused so the subcontractor cannot get it twice. A refusal from
the provider (a 4xx with an error name) is recorded as **failed** with the
provider's own error name and message.

Tested in `tests/email.test.ts` and `tests/reliability.test.ts` against a stub
that answers as the documentation describes.

**Not verified:** a message actually delivered by Resend; the sending domain's
DNS (SPF, DKIM) passing at real recipients; Resend's answer to a key reused
after 24 hours.

## Inbound: Postmark's webhook (`src/server/services/inbound.ts`)

| Documented behaviour | What Zephric does |
|---|---|
| Postmark authenticates to a webhook with HTTP basic auth written into the URL (`https://user:password@host/path`). It does not sign inbound webhooks. | The password must equal `INBOUND_EMAIL_SECRET` (or the secret is sent as an `x-inbound-secret` header by another provider). The check is constant-time and runs **before the body is read**. A secret in the query string is no longer accepted: query strings end up in access logs. |
| Postmark retries any answer other than 200 up to ten times, from one minute to six hours apart, and stops at once on 403. It waits up to two minutes for an answer. | 403 for what no retry can fix (unknown intake address, a body that is not valid JSON or MIME, a message over 50 MB). 401 for a wrong secret and 503 while intake is not enabled, so messages are retried while the owner fixes the setting. A processed message, accepted or turned away, answers 200. |
| Every inbound message carries `X-Spam-Status`, `X-Spam-Score` and `Received-SPF` headers; Postmark treats a score above 5 as spam. | A message marked `X-Spam-Status: Yes` is logged and turned away silently. One whose `Received-SPF` is `fail` is logged, turned away, and the team is told once a day per sender (it may be a forged supplier address). `softfail`, `neutral` and a missing header are accepted and go through the usual sender check. |
| Attachments may total up to 35 MB per message. | Zephric's own cap is 50 MB per request; each file must still be within the 25 MB upload limit. |

**Hosting limit.** On Vercel a request body over 4.5 MB is refused by the
platform before it reaches Zephric, and is not logged by the app. Attachments
are sent base64-encoded, so that is about 3 MB of attachments. Postmark
retries and then gives up; the sender gets no reply from Zephric. Until the
app runs on hosting without that limit (or intake moves to a provider that
sends attachments by reference), senders must split large packages or upload
them by hand. The Organisation page says so on Vercel.

Tested in `tests/transfer.test.ts` (route order, status codes, spam, SPF,
duplicate delivery, MIME parsing) against Postmark's documented payload.

**Not verified:** a real Postmark inbound stream posting to the live address;
the exact header values Postmark sends for spam and SPF on real mail; how a
real 4.5 MB refusal appears in Postmark's activity log.

## What the owner needs to do

1. **Resend:** create an account, verify a sending domain (DNS records), create
   an API key, and set `RESEND_API_KEY` and `EMAIL_FROM` (an address on that
   domain) in Vercel. Then invite a colleague and confirm the email arrives.
2. **Postmark inbound:** create a server with an inbound stream, set
   `INBOUND_EMAIL_SECRET` in Vercel, and set the stream's webhook URL to
   `https://zephric:<secret>@<the address under Settings → Organisation>`.
   Leave spam filtering on. Send one small test package from an address on
   file and check it under Settings → System status → Email intake.

# The Zephric mobile app

A native Android and iOS app (React Native through Expo, not a web view) for
the work that happens away from a desk: photographing or attaching a pay
application, seeing what is waiting, reading an application's findings and
documents, commenting, asking a subcontractor for corrections, and approving
an application when, and only when, nothing about it needs a desk.

The source is in [`mobile/`](../mobile). It talks only to the Zephric server
(`https://zephric.vercel.app` by default) through the routes under
`/api/mobile/*` and the existing upload and document routes. It has no
database, no business rules and no arithmetic of its own.

**Contents:** [What it does](#what-it-does) ·
[How it shares data with the website](#how-it-shares-data-with-the-website) ·
[Security](#security) · [Capture and offline drafts](#capture-and-offline-drafts) ·
[Approving from a phone](#approving-from-a-phone) ·
[Notifications](#notifications) · [Size](#size) ·
[Building for Android](#building-for-android) ·
[Building for iOS](#building-for-ios) · [The mobile API](#the-mobile-api) ·
[What is and is not verified](#what-is-and-is-not-verified) ·
[Limitations](#limitations)

## What it does

| Tab | What is on it |
|---|---|
| Home | The company name and date; **Send a bill** (the one accent-coloured control); your latest bill as a stamped paper slip; **Find a bill** (opens My uploads); for reviewers and approvers, what is waiting for them; and one line of what the company's bills are doing. |
| Projects | Each project with committed and approved-to-date figures; a project shows its subcontracts, their latest application and recent applications. |
| Bills | Bills by view: for you, in progress, finished, sent by me. Opens a bill. |
| Updates | Your notifications, unread first, with mark-all-read. |
| Me | Who you are, your organisations (switch between them), biometric unlock, two-step verification status, light/dark/system appearance, a link to the website, sign out. |

An **application** shows the requested and verified amounts, the
reconciliation figures (contract sum to date, retainage, balance to finish),
open, accepted and passed findings, the documents (opened in the phone's own
viewer), comments, correction requests and their delivery status, and the
timeline. Every figure comes from the server; the app formats integer cents
and never adds, subtracts or rounds a financial value
([`mobile/src/lib/format.ts`](../mobile/src/lib/format.ts), tested in
`tests/mobile-format.test.ts`).

**Capture** takes photos with the camera, picks photos from the library, or
attaches PDFs and images from Files (which includes Google Drive, Downloads,
email attachments saved to Files and other document providers the phone has).
Photos can be rotated, reordered and removed, and previewed full screen. The
subcontract is optional: "Let Zephric match it" leaves matching to the server,
exactly as an emailed package would be matched.

**My uploads** (Home → Find a bill) is one list of everything the person has
sent or is still sending: drafts on the phone and bills on the server, newest
first, each titled with the name they gave it. The search box matches the
name, description, tags, the typed amount and Zephric's amounts (with or
without `$` and commas), company, project and date; every word must match, in
any order. Under it, one-tap filters for this week, this month and the
company's tags (most used first) narrow the list without scrolling. The rules
are in `mobile/src/lib/uploads.ts`, tested in `tests/mobile-uploads.test.ts`.

**Description, tags and amount.** When sending, a person can add a
description, tags (tapping the company's existing ones, or typing a new one)
and the amount on the receipt. They are stored on the application
(`description`, `tags`, `stated_amount`, migration 0012), kept apart from what
Zephric reads and verifies, and returned in lists and the bill detail.
`GET /api/mobile/tags` offers the company's tags, most used first. A single
photo keeps the typed name ("Concrete.jpg") instead of "Page 1.jpg".

**Look.** Graphite neutrals with one burnt safety-orange accent (`#C2410C`,
`mobile/src/theme.ts`); every status is shown as a rubber stamp
(`mobile/src/ui/bill-slip.tsx`); the words are plain, for people who are not
used to billing software ("bill", "problem", "held back", not "application",
"finding", "retainage").

## How it shares data with the website

There is one server and one database. The mobile routes are thin: each one
resolves the session, builds the same organisation context the website uses,
and calls the same service functions the website's pages and server actions
call (`src/server/services/*`). In particular:

- **Organisation isolation** is the website's: every query is scoped by the
  context's organisation, and another organisation's application or project
  answers 404 (tested in `tests/mobile.test.ts`).
- **Permissions** are the website's role table
  (`src/server/auth/permissions.ts`). The app hides what a role cannot do, but
  the server refuses it regardless: a viewer cannot upload (403), an accountant
  cannot approve (403).
- **Uploads** use the website's staged-upload routes
  (`/api/uploads/:uploadId/parts/:part`, 4 MB parts) and the same intake
  (`createApplication`), so an application captured on a phone goes through
  exactly the reading, matching and reconciliation an uploaded or emailed one
  does.
- **Approvals** call the website's `approveApplication`, which re-runs
  reconciliation and enforces every approval rule before anything is approved
  (see [Approving from a phone](#approving-from-a-phone)).
- **Audit:** everything the app does is recorded in the same audit trail,
  attributed to the signed-in person. Approvals from the phone carry the note
  "Approved in the Zephric mobile app."

## Security

- **Sign-in** is the website's: the same password check, throttling, second
  step (authenticator code or recovery code) and remembered-device rule. An
  organisation that requires two-step verification refuses a member who has
  not set it up (`403 mfa_required`); they are told to set it up on the web.
  See [authentication: sessions](authentication.md#sessions).
- **The session token** is returned once, kept in the phone's secure storage
  (iOS Keychain; Android Keystore-backed encrypted storage) with
  "when unlocked, this device only" access, so it is unreadable while the phone
  is locked and is not included in backups or moved to a new phone. It is sent
  only as `Authorization: Bearer`. The server never reads it from a query
  string or cookie, so links and other websites cannot act with it.
- **Lifetime and revocation** are the website's: 14 days, ended by signing out
  on the phone, by "sign out other sessions" on the website (the phone shows as
  "Zephric app on Android" or "… on iOS" under Signed-in devices), by a
  password change, a reset, or removal from the organisation. The next request
  the phone makes after that is refused, and the app returns to sign-in and
  clears what it held.
- **Signing out** deletes the session on the server, then clears the token,
  the in-memory data cache and downloaded documents. The person chooses
  whether unsent drafts are kept or deleted. Switching organisation clears the
  data cache and documents too, and the cache is keyed by person and
  organisation, so one organisation's records never show under another.
- **Nothing is cached on disk** except drafts the person made and documents
  they opened (in the app's cache directory, removed on sign-out). Every API
  response is `cache-control: no-store, private`.
- **Biometric unlock** (optional, Profile) asks for Face ID, Touch ID or the
  phone's fingerprint or face unlock when the app opens and after a minute in
  the background. It is a local lock on top of the session, not a replacement
  for it.
- **The app switcher.** On Android 13 and later the app tells the system not
  to keep a picture of it for the recent-apps screen
  (`plugins/with-recents-privacy.js`), so the switcher shows a blank card.
  Screenshots the person takes themselves still work. On every platform an
  opaque cover is also drawn when the app leaves the foreground; on Android 12
  and earlier that cover is the only protection, and the system may take its
  picture before the cover is drawn. On iOS the cover has not been checked.
- **Android:** `allowBackup` is off; the app asks only for the camera and
  biometrics; microphone, location, contacts and broad storage permissions are
  blocked in the manifest. Photos and files are read through the system
  pickers, which need no storage permission.

## Capture and offline drafts

Captures are kept on the phone until the server confirms it has them. Nothing
is ever marked sent on the phone's own say-so.

1. A **draft** is created on the phone the moment you start a capture, with an
   id that doubles as the submission's client reference. Photos are scaled to
   2,400 pixels on the long edge and saved as JPEG; PDFs are copied as they
   are. Drafts survive the app being closed, killed or the phone restarting,
   and work with no connection at all.
2. **Send** queues the draft. The app uploads it in 4 MB parts and records
   each part as it lands, so an interrupted upload resumes where it stopped.
   It sends while the app is open: when you tap Send, every 30 seconds, and
   as soon as the connection comes back.
3. When every part is up, the app asks the server to create the application
   with the draft's client reference. The server checks for an application
   this person already created with that reference in the last 30 days and
   returns it instead of creating a second one, so a retry after a lost
   response can never make a duplicate (tested). Photos from one capture are
   combined into one PDF on the server, in the order shown. A *new* capture of
   a file Zephric already has does make a new application, as an emailed
   duplicate would, and the server's checks raise a blocking finding on it
   ("… was already submitted": paying it again would be a duplicate payment),
   so it cannot be approved by mistake.
4. Only the server's answer marks the draft **Received by Zephric**, with a
   link to the application. Then the phone deletes its copies of the files and
   keeps a receipt for 14 days.

If there is no connection the draft waits ("Waiting to send"). If the session
has ended it waits for you to sign in again. If the server refuses it, it is
marked **Not sent** with the server's reason and its files are kept; "Send
again" retries with the same reference.

Limits are the server's: up to 20 files and 25 MB per file.

Drafts belong to the person and organisation that made them. Another person
signing in on the same phone, or the same person in another organisation,
does not see them. If the session ends on its own (expired or signed out
elsewhere), drafts are kept for when that person signs in again; signing out
on the phone asks whether to keep or delete unsent drafts.

**Offline** the app keeps showing what it loaded while it stays open, marked
as offline, and lets you make, edit and queue drafts. Data is held in memory
only, so after the app is closed and opened again without a connection it
shows no records or figures until it reconnects, and then reloads by itself.
It does not approve, request information, comment or compute anything
offline: those need the server, and the buttons say so.

### Sharing from another app

On Android, Zephric is listed in the system Share sheet for PDFs and images,
one or several at a time (from Files, the gallery, an email attachment and
the like). On iOS it is offered under "Open in" / "Copy to" for PDFs and
images; that has not been built or tested (see
[Building for iOS](#building-for-ios)).

- Each file is copied into the app's own storage the moment it arrives,
  because the other app's permission to read it ends soon after. Only PDFs
  and images are kept, up to 25 MB each and 20 at a time; anything else is
  left out and the app says what and why ("One file is not a PDF or an
  image."). On Android the app only takes files another app offers it
  (`content://` addresses from another app's provider), never its own files
  or a plain file path.
- If someone with upload access is signed in and the app is unlocked, the
  files open straight away as a new capture in the organisation they are
  signed in to, with a note naming it. If nobody is signed in, the sign-in
  screen says a shared file is waiting, and the capture opens after signing
  in. Waiting files survive the app being closed and are removed after 7
  days if nobody signs in. Someone whose role cannot upload (a viewer) is
  told so and the files are removed from the phone.
- Nothing is sent until the person checks the capture, optionally chooses
  the subcontract, and presses Send. From there it is an ordinary draft, as
  above.

The code is in `mobile/modules/share-intake` (the Android side, a small
Expo module that takes the shared files from the system),
`mobile/src/lib/shared.ts` (keeping them until someone signs in) and
`mobile/app/+native-intent.tsx` (iOS "Open in").

## Approving from a phone

The phone offers **Approve** only when all of these hold (the server's
`mobileApprovalGate`, `src/server/services/mobile.ts`):

- your role can approve;
- the application is **pending approval** (a reviewer has finished with it);
- it has **no open blocking findings** and **no open warnings**; and
- it has a **verified amount**.

Anything else is sent to the desktop with the reason: a blocking finding needs
a decision with a written reason, a warning must be acknowledged, a review is
unfinished. The app links to the application on the website.

When you approve, the phone sends the application's version and the verified
amount it showed you. The server then:

1. checks the gate again (a phone cannot skip it by calling the route
   directly);
2. calls the website's `approveApplication`, which re-runs reconciliation,
   refuses open blocking findings, and refuses if the application changed
   since the phone loaded it or the amount differs from what you saw
   (`409 conflict`; the phone reloads and shows the current figures).

Rejecting, splitting, overriding a finding, editing figures and settling
waivers stay on the desktop, where every figure can be checked against the
documents. Nothing on the phone certifies legal validity: waiver and
compliance findings are shown as the pre-screen found them, for a qualified
person to decide.

## Notifications

The Activity tab shows the same notifications as the website, with an unread
badge. **Push notifications are not turned on in this version** and the app
says so. Turning them on needs:

1. a Firebase project for Android (`google-services.json`) and an Apple Push
   Notification service key for iOS, both owned by the business;
2. `expo-notifications` in the app, a route to register a device's push token
   against its session, and removal of the token on sign-out;
3. sending from the server's existing notification step, with **no financial
   detail in the notification text** (for example "An application is waiting
   for your approval"), so nothing sensitive appears on a locked screen.

None of this has been built or tested, and no push delivery is claimed.

## Size

Measured on 2026-11-16 from release builds on this machine, the APK from a
clean `prebuild` of this change. See
[What is and is not verified](#what-is-and-is-not-verified) for how.

| Artifact | Size |
|---|---|
| Android release APK, arm64-v8a (the architecture of practically every Android phone in use) | **26,025,539 bytes (24.8 MiB)** |
| The same APK compressed with `gzip -9`, a rough stand-in for the download | 10,568,346 bytes (10.1 MiB) |
| Space used after installing, on the emulator (Android 16): the app's code folder, then its data after one launch | 31,084 KiB (30.4 MiB), then 896 KiB |
| The arm64 release APK before sharing from other apps was added | 26,012,491 bytes (24.8 MiB) |
| The arm64 release APK earlier the same day, before unused native modules were left out | 29,862,371 bytes (28.5 MiB) |
| iOS | Not built (no Xcode on this machine) |

Inside the 24.8 MiB APK: native libraries 19.1 MB (React Native 7.0 MB,
the Hermes engine 2.7 MB, Expo's module core 1.6 MB, the app's generated
native modules 1.5 MB, the C++ runtime 1.3 MB, screens and SVG 2.0 MB, the
rest under 1 MB each), compiled Java and Kotlin 2.6 MB, the app's JavaScript
as Hermes bytecode 2.5 MB, and resources 1.4 MB. Android keeps native
libraries and the bytecode uncompressed inside the APK so it can map them
straight into memory; the store compresses them for the download, which is
why the download is well under half the APK.

Sharing from other apps added 13,048 bytes to the APK. By part: the
JavaScript bytecode grew 12,708 bytes, the compiled Java and Kotlin 5,044
bytes (the share module is plain Kotlin, with no native library), and the
manifest and resources 316 bytes; together that is more than the APK grew
because the parts are padded to alignment boundaries inside it. Both APKs
were built from a clean `prebuild` and signed with a throwaway upload key.

For Android this is under the 50 MB aim and well under the 100 MB limit.
On the emulator the installed code folder is the APK itself (24.7 MiB on
disk) plus 5.6 MiB of code Android compiled ahead of time; native libraries
are read from the APK rather than unpacked. Android may compile more of the
app later, while the phone is idle, so the space grows somewhat with use.
It has not been measured on a physical phone. The figures are from `ls -l`
and `unzip -lv` on the files Gradle produced and `du` on the emulator, not
estimates, except the compressed figure, which is labelled as one. Google Play's own download
estimate needs an App Bundle uploaded to a Play account, which this project
does not have yet.

What keeps it small: Hermes bytecode instead of JavaScript source; R8
shrinking and resource shrinking; no image libraries beyond what React Native
needs (`plugins/with-lean-android.js`); no WebView, Reanimated, Worklets or
Gesture Handler (excluded from autolinking, see below); system pickers
instead of a bundled camera or document scanner; and icons drawn as SVG paths
rather than an icon font.

## Building for Android

Prerequisites:

- Node.js 22 (`nvm use 22`); npm.
- JDK 17 (for example `brew install openjdk@17`), with `JAVA_HOME` pointing at it.
- Android SDK command-line tools with platform 37, build-tools 37.0.0,
  NDK 27.1.12297006 and CMake 3.22.1 (`sdkmanager "platforms;android-37.0"
  "build-tools;37.0.0" "ndk;27.1.12297006" "cmake;3.22.1"`), and
  `ANDROID_HOME` pointing at the SDK. The app targets Android 16 (API 36),
  compiles against API 37 as Expo SDK 58's libraries require, and runs on
  Android 7.0 (API 24) and later.

```bash
cd mobile && npm ci
```

```bash
npx expo prebuild --platform android --clean
```

`prebuild` generates `mobile/android/` from `app.json` and the config plugins
in `mobile/plugins/`; the folder is not committed and can be regenerated at
any time. If Gradle cannot find the SDK, create
`mobile/android/local.properties` containing `sdk.dir=<your SDK path>`.

A release APK for testing on a phone (arm64 only, the architecture of
practically every Android phone sold since 2017):

```bash
cd mobile/android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

The APK is `mobile/android/app/build/outputs/apk/release/app-release.apk`.
Install it with `adb install -r` on that path.

For Google Play, build an App Bundle with every architecture; Play then
delivers each phone only its own:

```bash
cd mobile/android && ./gradlew bundleRelease
```

The bundle is `mobile/android/app/build/outputs/bundle/release/app-release.aab`.

**Signing.** Play requires the business's own upload key. Create it once and
keep it, and its passwords, out of the repository (a password manager or the
CI secret store):

```bash
keytool -genkeypair -v -storetype PKCS12 -keystore zephric-upload.jks -alias zephric-upload -keyalg RSA -keysize 4096 -validity 10000
```

Then put these in `~/.gradle/gradle.properties` (or pass each with `-P`):

```
ZEPHRIC_UPLOAD_STORE_FILE=/absolute/path/to/zephric-upload.jks
ZEPHRIC_UPLOAD_STORE_PASSWORD=...
ZEPHRIC_UPLOAD_KEY_ALIAS=zephric-upload
ZEPHRIC_UPLOAD_KEY_PASSWORD=...
```

`mobile/plugins/with-release-signing.js` signs release builds with that key
when it is configured. Without it, release builds are signed with the debug
key (installable for testing, refused by Play) and Gradle prints a warning.
Raise `android.versionCode` in `mobile/app.json` for every Play upload.

**Pointing at another server.** The default server is `extra.apiUrl` in
`mobile/app.json`. On the sign-in screen, "Server" lets a person enter another
HTTPS address (for a staging deployment); plain HTTP is accepted only in
development builds and only for local network addresses.

**Testing against a server on this computer.** A release build only talks to
HTTPS servers, and test accounts must never be used on the live site. For an
emulator (or a phone on a USB cable), build the local test variant, with the
variable set for both steps (Gradle reads the app's configuration again while
it bundles the JavaScript):

```bash
cd mobile && ZEPHRIC_LOCAL_TEST=1 npx expo prebuild --platform android --clean
```

```bash
cd mobile/android && ZEPHRIC_LOCAL_TEST=1 ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

If the variable differs between the two, the build stops with an explanation
(`mobile/plugins/with-variant-guard.js`) rather than producing half of each
variant. The test variant is called "Zephric Test", installs as its own app
(`com.zephric.app.localtest`) beside the real one rather than replacing it,
starts pointed at `http://localhost:3000`, and may use plain HTTP to the
phone's own localhost and nothing else (`mobile/app.config.js`,
`mobile/plugins/with-local-test-server.js`). Forward the port with
`adb reverse tcp:3000 tcp:3000` (or `tcp:3000 tcp:<your dev server port>`).
Everything else is the release build. Run `prebuild` again without the
variable before building anything to hand out.

**Native modules left out.** `expo-router` brings in Reanimated, Worklets and
Gesture Handler, and `expo` brings in a WebView module for "DOM components";
the app uses none of them (their JavaScript is not in the bundle), so
`package.json` excludes them from autolinking (`expo.autolinking.exclude`).
If a later change starts using one, remove it from that list.

## Building for iOS

Not built or tested: this machine has no Xcode. What it needs:

- A Mac with a current Xcode that Expo SDK 58 supports (see Expo's SDK
  reference), its command-line tools selected, and CocoaPods.
- Membership of the Apple Developer Program (a paid annual membership, the
  business's decision) to sign and distribute, and the bundle identifier
  `com.zephric.app` registered to it.
- Then:

```bash
cd mobile && npm ci && npx expo prebuild --platform ios --clean
```

```bash
cd mobile && npx expo run:ios --configuration Release
```

For TestFlight or the App Store, open `mobile/ios/Zephric.xcworkspace` in
Xcode, choose the team, and Product → Archive. The camera, photo-library and
Face ID usage descriptions and the privacy manifest are already in
`app.json`; the deployment target is iOS 16.4.

Before the first iOS release, check on a real iPhone: sign-in and the second
step, Face ID unlock and its fallback, the app-switcher cover, camera and
photo capture, Files import, document preview, sending on a poor
connection, and "Open in Zephric" for a PDF from Files and from a Mail
attachment, signed in and signed out. iOS receives those through the
document types in `app.json` (`CFBundleDocumentTypes` for PDF and
`public.image`, with `LSSupportsOpeningDocumentsInPlace` off so iOS hands
over a copy in the app's Inbox folder rather than the original). On iOS, drafts are kept in the app's Documents folder, which
the phone's own backup includes; decide whether to exclude it.

## The mobile API

All routes are under `/api/mobile`, take and return JSON, require
`Authorization: Bearer <token>` except sign-in, and answer
`cache-control: no-store, private`. Errors are `{ error, code }`.

| Route | What it does |
|---|---|
| `POST /session` | Sign in with email and password. Returns `{ status: "signed_in", token, expiresAt }` or `{ status: "verify", challenge }` when a second step is needed. `401 bad_credentials`; too many attempts are refused with the website's throttling message (`400`). |
| `POST /session/verify` | The second step: `{ challenge, code }`. `400 wrong_code` (with tries left), `429 locked`, `400 restart`. |
| `DELETE /session` | Sign out: deletes the session on the server. |
| `GET /me` | The person, their organisation and role, their permissions, and their other organisations. |
| `POST /org` | Switch organisation (`{ orgId }`); must be an active member. |
| `GET /home` | Counts, what needs you, recent submissions, unread notifications. |
| `GET /applications?view=` | `attention`, `open`, `decided`, `mine` or `all`. |
| `POST /applications` | Create an application from staged uploads, with a client reference. `201` new, `200` when that reference already made one. |
| `GET /applications/:id` | One application: amounts, findings, documents, comments, messages, timeline, what you can do, and why not. |
| `POST /applications/:id/comments` | Add a comment. |
| `GET`, `POST /applications/:id/request-info` | Zephric's draft of a correction request from the open findings; send it, optionally putting the application on hold. Reports whether the email was sent, recorded but not sent (no email provider), failed or unconfirmed. |
| `POST /applications/:id/approve` | Approve, with `{ expectedVersion, expectedAmount }`. `409 desktop_required` or `409 conflict` as described above. |
| `GET /projects`, `GET /projects/:id` | Projects and one project's subcontracts and applications. |
| `GET /contracts` | Active subcontracts, for choosing one in a capture. |
| `GET`, `POST /notifications` | Notifications; mark read. |

Route tests: `tests/mobile.test.ts`.

## What is and is not verified

Checked on 2026-11-16. "Emulator" below means the Android Emulator on this
Mac (Android 16, API 36, arm64 system image, Pixel 7 screen), never a
physical phone.

**Automated tests** (`pnpm test` at the repository root): the mobile API
routes in `tests/mobile.test.ts` (sign-in, the second step, a member who owes
their organisation two-step verification, bearer-only tokens, sign-out
revocation, organisation isolation, duplicate-safe capture, photos joined
into one PDF, role refusals, the phone approval gate and the amount check,
comments), the app's money and date formatting in
`tests/mobile-format.test.ts`, and the rules for files shared from another
app (which types are taken, the 20-file limit, what the person is told) in
`tests/mobile-shared.test.ts`. `npx tsc --noEmit` in `mobile/` is clean.

**Builds.** The JavaScript bundle (`expo export`) and the Android release APK
(arm64) build from a clean `prebuild`. The signing plugin was checked with a
throwaway upload key: the APK was signed with that key and not the debug key.
The variant guard was checked both ways (a mismatched Gradle run stops with
its message; a matching one builds).

**The release build on the emulator** (package `com.zephric.app`, built
from a clean `prebuild` and signed with a throwaway upload key): it opens to
sign-in pointed at `https://zephric.vercel.app`. The build before sharing
was added also refused a plain `http://` server address there. Both builds'
installed sizes were measured there. Neither was signed in to the live
site: test accounts are not used there.

**The local test variant on the emulator**, against Zephric running on this
Mac with a scratch database of the demo data:

- Sign-in; switching organisation, after which the overview, projects and
  billing show the other organisation's data; all five tabs; light, dark and match-phone appearance,
  with the status and navigation bars following the app's choice.
- An application ready for approval: Approve, the confirmation, the server's
  `200`, "Approved by … Approved in the Zephric mobile app" on the screen and
  in its history, and the overview's pending count going down.
- An application with blocking findings: "Decide on the desktop", no approve
  button, the findings explained. The correction-request draft opens filled
  from the findings; it was not sent, because the local server would have
  used the real email provider.
- A comment posted (`201`) and shown in the comments and history.
- Capture from Files (a sample pay application PDF) and from the camera (the
  emulator's simulated camera), rotating a photo, sending with no
  connection ("Waiting to send"), the app force-stopped and reopened offline
  with the capture still queued and the session still signed in, the
  connection restored and the capture sent: the server created the
  application, read and matched it, and the phone showed Received by Zephric
  with a link to it. The same PDF in a second capture became a second
  application with a blocking "already submitted" finding.
- Sharing from other apps, all through the system Share sheet, where the
  app was listed as "Zephric Test":
  - A PDF shared from the Files app while signed out, with the app not yet
    opened since it was installed: the app opened to sign-in with "A shared
    file is waiting"; after signing in the capture opened with the PDF and
    the note naming the organisation; sent with Zephric left to match it,
    the server created the application (`201`) and the phone showed
    Received by Zephric.
  - Two photos selected and shared from the Gallery app while signed in to
    the demo organisation, with the app in the background: one capture
    with both photos; Lone Star Electric chosen, sent, received, and the
    application opened from the receipt. The local server has no AI
    reading configured, so the photographed pages were not read and the
    application shows "No pay application in the package", which is the
    server's existing handling of photos without AI reading.
  - A PDF, a photo and a spreadsheet shared together from Files: the
    capture held the PDF and the photo, and the app said "One file is not
    a PDF or an image."
  - A photo shared while signed out was still waiting after the app was
    force-stopped and opened again; after signing in it opened as a
    capture, and the server's log shows no upload until Send. That draft
    and the previous one were deleted unsent.
  - Opening the app again from the recent-apps screen after a share,
    including after force-stopping it, did not add the shared file again.
  - A file the app had not been given permission to read (sent from the
    command line) was refused with "One file could not be read; try sharing
    again."
- Opened with no connection: the offline notice and no figures; on
  reconnecting the overview and profile reloaded without a tap.
- Biometric unlock with a simulated fingerprint enrolled on the emulator:
  turning it on, the lock after a minute in the background, and unlocking.
- The recent-apps screen shows a blank card for the app.
- Signing out with an unsent capture asks whether to keep or delete it; kept,
  it was there again after signing back in. Signing out ended the session on
  the server (`DELETE /api/mobile/session 200`); Back afterwards leaves the
  app, and reopening shows sign-in.
- Ending the phone's session from the website while the app was open: the
  app's next request was refused and it returned to sign-in with "Your
  session has ended. Sign in again."
- Two-step sign-in with an authenticator code, on the website and in the
  app (local server, two-step turned on for the test account): a wrong code
  was refused with the tries left, and the current code signed in, on the
  website to the page that had been asked for and in the app to the
  overview, where Profile shows two-step verification as on. After the wrong
  code the Verify button is read out by its name (before a fix in this
  change, screen readers heard it as "busy").

**Not verified:**

- Any physical Android phone, and anything on iOS (not built), including
  "Open in Zephric".
- Sharing to the app: a file over 25 MB, more than 20 files at once,
  sharing from Google Drive, Gmail or other apps that hand over files they
  fetch from the internet, sharing while the app is locked, and sharing to
  someone whose role cannot upload. The type, size and count rules are
  covered by `tests/mobile-shared.test.ts`; the rest was not exercised.
- Signing in with a recovery code in the app. The route uses the website's
  second step, whose recovery codes are tested; the app's recovery-code mode
  was not used on the emulator.
- Sending a correction request, large or many-part uploads, and resuming an
  upload interrupted part-way on a poor connection.
- Picking from the photo library, and Files providers other than the
  phone's own storage (Google Drive and the like).
- Behaviour on Android 7 to 12, other screen sizes, and with large text.
- The space the app uses on a physical phone after installing (measured on
  the emulator only, see [Size](#size)).
- Push notifications (not built).

## Limitations

- **No subcontractor role.** Zephric's roles are the general contractor's own
  staff (owner, admin, controller, accountant, project manager, viewer). A
  subcontractor cannot be given a login that shows only their own
  applications; inviting one as a member would show them the organisation's
  records. Subcontractors keep sending packages by email, and a member can
  capture on their behalf. A subcontractor-scoped portal is a separate piece
  of work: its own role, its own queries filtered to one subcontractor, and
  its own tests for that boundary.
- **No push notifications** (see [Notifications](#notifications)).
- **Sharing from other apps has limits.** Shared files become a capture in
  the organisation you are signed in to when it opens; for another
  organisation, delete that capture, switch organisation in Profile and
  share again. On iOS the app uses "Open in" rather than a share
  extension, so it is not expected to appear where only share extensions
  are listed, such as the Photos app's share sheet (not checked: iOS has
  not been built); the app's own Photos button covers photos.
- **Sending happens while the app is open.** Queued drafts are not uploaded
  by a background task when the app is closed; they send the next time it is
  opened with a connection.
- **A photo being taken when Android closes the app** (a low-memory phone can
  close it while the camera is open) is not recovered; the draft and the
  photos already in it are kept.
- **No crash reporting or analytics** are built in.
- **iOS has not been built** (no Xcode here), and the Android build has been
  run on an emulator, not a physical phone.
- **No store listings** exist; publishing needs the business's Google Play and
  Apple developer accounts.

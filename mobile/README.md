# Zephric mobile

The Android and iOS app. Everything about it (what it does, security, offline
drafts, approvals, sizes, building, signing, the API it uses, what is and is
not verified) is in [docs/mobile.md](../docs/mobile.md).

Quick reference, with Node 22, JDK 17 and the Android SDK installed:

```bash
npm ci
```

```bash
npx tsc --noEmit
```

```bash
npx expo prebuild --platform android --clean
```

```bash
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

`android/` and `ios/` are generated from `app.json`, `app.config.js` and
`plugins/`; change those, never the generated folders. App icons come from
`scripts/make-icons.mjs` (run it from this folder after changing the mark).

`ZEPHRIC_LOCAL_TEST=1` before both `prebuild` and `./gradlew` makes a
"Zephric Test" build (`com.zephric.app.localtest`) for an emulator against a
server on this computer (`adb reverse tcp:3000 tcp:3000`); never distribute
it. The build stops if the variable differs between the two steps.

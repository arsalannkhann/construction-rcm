// The app's configuration is app.json; this file only adds one build variant.
//
// ZEPHRIC_LOCAL_TEST=1 builds a copy for testing on an emulator or a phone on
// a cable against a Zephric server running on this computer, reached through
// `adb reverse tcp:3000 tcp:3000`. That copy is called "Zephric Test", starts
// pointed at http://localhost:3000, and may use plain HTTP to the phone's own
// localhost and nothing else. It installs beside the real app (its own package
// and bundle identifier), so it can never replace or be mistaken for it.
// Everything else is identical to the release.
// Never set the variable for a build that is given to anyone. Set it for both
// `expo prebuild` and Gradle: Gradle reads this file again while bundling, and
// plugins/with-variant-guard.js stops a build where the two differ.
module.exports = ({ config }) => {
  if (process.env.ZEPHRIC_LOCAL_TEST !== '1') return config;
  return {
    ...config,
    name: `${config.name} Test`,
    android: { ...config.android, package: `${config.android.package}.localtest` },
    ios: { ...config.ios, bundleIdentifier: `${config.ios.bundleIdentifier}.localtest` },
    extra: { ...config.extra, apiUrl: 'http://localhost:3000', localTestBuild: true },
    plugins: [...(config.plugins ?? []), './plugins/with-local-test-server'],
  };
};

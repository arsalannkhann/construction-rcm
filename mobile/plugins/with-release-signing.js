// Signs Android release builds with the Zephric upload key when one is
// provided, instead of the debug key the Expo template uses.
//
// The key never lives in the repository. Put these in ~/.gradle/gradle.properties
// (or pass them with -P on the command line):
//
//   ZEPHRIC_UPLOAD_STORE_FILE=/absolute/path/to/zephric-upload.jks
//   ZEPHRIC_UPLOAD_STORE_PASSWORD=...
//   ZEPHRIC_UPLOAD_KEY_ALIAS=zephric-upload
//   ZEPHRIC_UPLOAD_KEY_PASSWORD=...
//
// Without them a release build is still signed with the debug key so it can be
// installed for testing, and the build prints a warning saying so. Google Play
// refuses debug-signed uploads, so a store build cannot slip through unsigned.
const { withAppBuildGradle } = require('expo/config-plugins');

const RELEASE_CONFIG = `
        release {
            if (findProperty('ZEPHRIC_UPLOAD_STORE_FILE')) {
                storeFile file(findProperty('ZEPHRIC_UPLOAD_STORE_FILE'))
                storePassword findProperty('ZEPHRIC_UPLOAD_STORE_PASSWORD')
                keyAlias findProperty('ZEPHRIC_UPLOAD_KEY_ALIAS')
                keyPassword findProperty('ZEPHRIC_UPLOAD_KEY_PASSWORD')
            }
        }`;

const RELEASE_SIGNING = `if (findProperty('ZEPHRIC_UPLOAD_STORE_FILE')) {
                signingConfig signingConfigs.release
            } else {
                logger.warn('Zephric: no upload key configured (ZEPHRIC_UPLOAD_STORE_FILE); this release build is signed with the debug key and cannot be published.')
                signingConfig signingConfigs.debug
            }`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;
    if (gradle.includes('ZEPHRIC_UPLOAD_STORE_FILE')) return cfg;

    const debugConfig = /(signingConfigs \{\n\s+debug \{[^}]*\})/;
    const releaseUsesDebug = /(release \{\n(?:\s*\/\/[^\n]*\n)*\s*)signingConfig signingConfigs\.debug/;
    // Fail the prebuild rather than silently ship a template we no longer understand.
    if (!debugConfig.test(gradle) || !releaseUsesDebug.test(gradle)) {
      throw new Error('with-release-signing: android/app/build.gradle no longer has the expected signing layout; update plugins/with-release-signing.js.');
    }
    gradle = gradle.replace(debugConfig, `$1${RELEASE_CONFIG}`);
    gradle = gradle.replace(releaseUsesDebug, `$1${RELEASE_SIGNING}`);
    cfg.modResults.contents = gradle;
    return cfg;
  });
};

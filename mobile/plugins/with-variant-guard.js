/**
 * The app's configuration (app.config.js) is read twice: by `expo prebuild`,
 * which generates android/, and again by Gradle while it bundles the
 * JavaScript. If ZEPHRIC_LOCAL_TEST differs between the two, the result is
 * half one variant and half the other: for example the test variant's package
 * with the release server, or the release package pointed at localhost.
 *
 * This bakes the variant prebuild generated into app/build.gradle and stops
 * the build when Gradle is run with the other one.
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const MARK = '// Zephric: variant guard';

module.exports = function withVariantGuard(config) {
  const localTest = process.env.ZEPHRIC_LOCAL_TEST === '1';
  return withAppBuildGradle(config, (cfg) => {
    const gradle = cfg.modResults;
    if (gradle.language !== 'groovy') throw new Error('with-variant-guard: expected a Groovy app/build.gradle.');
    if (gradle.contents.includes(MARK)) return cfg;
    const anchor = 'apply plugin: "com.facebook.react"\n';
    if (!gradle.contents.includes(anchor)) throw new Error('with-variant-guard: the React Native plugin line was not found in app/build.gradle; the template changed.');
    const name = localTest ? 'the local test variant (ZEPHRIC_LOCAL_TEST=1)' : 'the release variant (ZEPHRIC_LOCAL_TEST unset)';
    const fix = localTest
      ? 'Set ZEPHRIC_LOCAL_TEST=1 for this Gradle run too, or run `npx expo prebuild --platform android --clean` again without it.'
      : 'Unset ZEPHRIC_LOCAL_TEST for this Gradle run, or run `ZEPHRIC_LOCAL_TEST=1 npx expo prebuild --platform android --clean` to build the test variant.';
    const guard = [
      `${MARK} (mobile/plugins/with-variant-guard.js).`,
      `// This folder was generated for ${name}.`,
      `if ((System.getenv('ZEPHRIC_LOCAL_TEST') == '1') != ${localTest}) {`,
      `    throw new GradleException("android/ was generated for ${name}, but ZEPHRIC_LOCAL_TEST is ${localTest ? 'not 1' : '1'} for this build. ${fix.replace(/"/g, '\\"')}")`,
      '}',
      '',
    ].join('\n');
    gradle.contents = gradle.contents.replace(anchor, `${anchor}\n${guard}`);
    return cfg;
  });
};

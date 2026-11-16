/**
 * Keeps billing figures out of Android's recent-apps screen. Android 13 and
 * later take the thumbnail before JavaScript can draw the privacy cover, so
 * the activity asks the system not to take one at all. Screenshots the
 * person takes themselves still work (unlike FLAG_SECURE).
 *
 * Older Android versions rely on the cover in app/_layout.tsx alone.
 */
const { withMainActivity } = require('expo/config-plugins');

const MARK = 'setRecentsScreenshotEnabled(false)';

module.exports = function withRecentsPrivacy(config) {
  return withMainActivity(config, (cfg) => {
    const activity = cfg.modResults;
    if (activity.language !== 'kt') throw new Error('with-recents-privacy: expected a Kotlin MainActivity.');
    if (activity.contents.includes(MARK)) return cfg;
    const onCreate = /(\n(\s*)super\.onCreate\([^)]*\)\n)/;
    if (!onCreate.test(activity.contents)) throw new Error('with-recents-privacy: super.onCreate(...) not found in MainActivity; the template changed.');
    activity.contents = activity.contents.replace(
      onCreate,
      (_m, line, indent) => `${line}${indent}// Zephric: no recent-apps thumbnail of billing screens (Android 13+).\n${indent}if (android.os.Build.VERSION.SDK_INT >= 33) ${MARK}\n`,
    );
    return cfg;
  });
};

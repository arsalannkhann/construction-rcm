// Keeps the Android build lean. The app shows JPEG photos it took itself and
// hands PDFs to the system viewer, so it needs neither Fresco's animated GIF
// decoder nor its WebP library (Android 7+, our minimum, decodes static WebP
// natively).
const { withGradleProperties } = require('expo/config-plugins');

const PROPERTIES = {
  'expo.gif.enabled': 'false',
  'expo.webp.enabled': 'false',
  'expo.webp.animated': 'false',
};

module.exports = function withLeanAndroid(config) {
  return withGradleProperties(config, (cfg) => {
    for (const [key, value] of Object.entries(PROPERTIES)) {
      const existing = cfg.modResults.find((item) => item.type === 'property' && item.key === key);
      if (existing) existing.value = value;
      else cfg.modResults.push({ type: 'property', key, value });
    }
    return cfg;
  });
};

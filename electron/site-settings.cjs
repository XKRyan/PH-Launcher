const DATA_VERSION = 2;
const CLEAN_DISPLAY_RESET_VERSION = 2;
const CLEAN_DISPLAY_DEFAULTS = Object.freeze({
  mail: false,
  managebac: false,
  edupage: false,
});

function normalizeCleanDisplaySettings(dataVersion, value) {
  const source = value && typeof value === 'object' ? value : {};
  if (Number(dataVersion || 0) < CLEAN_DISPLAY_RESET_VERSION) return { ...CLEAN_DISPLAY_DEFAULTS };
  return Object.fromEntries(
    Object.keys(CLEAN_DISPLAY_DEFAULTS).map((siteId) => [siteId, source[siteId] === true]),
  );
}

module.exports = {
  CLEAN_DISPLAY_RESET_VERSION,
  CLEAN_DISPLAY_DEFAULTS,
  DATA_VERSION,
  normalizeCleanDisplaySettings,
};

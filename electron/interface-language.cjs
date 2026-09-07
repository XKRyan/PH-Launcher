'use strict';
function translate(value, language, catalog = require('../src/locales/en.js')) {
  if (language !== 'en' || typeof value !== 'string') return value;
  const key = value.trim();
  let translated = catalog.exact?.[key];
  if (translated === undefined) for (const [pattern, replacement] of catalog.patterns || []) {
    if (!pattern.startsWith('^') || !pattern.endsWith('$')) continue;
    const regex = new RegExp(pattern);
    if (regex.test(key)) { translated = key.replace(regex, replacement); break; }
  }
  return translated === undefined ? value : value.replace(key, translated);
}
function dialogOptions(options, language) {
  const result = { ...options };
  for (const key of ['title', 'message', 'detail', 'buttonLabel']) if (typeof result[key] === 'string') result[key] = translate(result[key], language);
  if (Array.isArray(result.buttons)) result.buttons = result.buttons.map(value => translate(value, language));
  if (Array.isArray(result.filters)) result.filters = result.filters.map(filter => ({ ...filter, name: translate(filter.name, language) }));
  return result;
}
module.exports = { translate, dialogOptions };

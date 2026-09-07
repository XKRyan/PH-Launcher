const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_AUTO_RETRIES = 1;

function decideAutoRecovery(attempts, now = Date.now(), options = {}) {
  const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : DEFAULT_WINDOW_MS;
  const maxAutoRetries = Number.isFinite(options.maxAutoRetries)
    ? options.maxAutoRetries
    : DEFAULT_MAX_AUTO_RETRIES;
  if (!Number.isFinite(now) || windowMs < 1 || maxAutoRetries < 0) {
    throw new Error('Invalid site recovery policy.');
  }

  const recentAttempts = Array.isArray(attempts)
    ? attempts.filter((attempt) => Number.isFinite(attempt) && attempt >= now - windowMs && attempt <= now)
    : [];
  if (recentAttempts.length >= maxAutoRetries) {
    return { retry: false, attempts: recentAttempts };
  }
  return { retry: true, attempts: [...recentAttempts, now] };
}

module.exports = {
  DEFAULT_MAX_AUTO_RETRIES,
  DEFAULT_WINDOW_MS,
  decideAutoRecovery,
};

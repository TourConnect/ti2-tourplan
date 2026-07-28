/**
 * Force UTC timezone for tests so fixture hashes are consistent across
 * environments (Docker/CI typically use UTC; local dev may use a different TZ).
 * Must run before any code that uses moment() or Date.
 *
 * Note: setting process.env.TZ here can be too late on some platforms (e.g. macOS).
 * The npm "test" script also sets TZ=UTC before Node starts so moment() matches
 * the frozen system time used for OptionInfo DateFrom / SCUqty fixture hashes.
 */
process.env.TZ = 'UTC';

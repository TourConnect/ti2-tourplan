/**
 * Force UTC timezone for tests so fixture hashes are consistent across
 * environments (Docker/CI typically use UTC; local dev may use a different TZ).
 * Must run before any code that uses moment() or Date.
 */
process.env.TZ = 'UTC';

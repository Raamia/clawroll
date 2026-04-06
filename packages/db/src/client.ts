/**
 * Postgres connection.
 *
 * The URL comes from `DATABASE_URL`, with a local default that matches `docker-compose.yml`
 * so a fresh checkout runs without configuration. There is no production default on
 * purpose: a missing `DATABASE_URL` in a deployed environment should fail loudly rather
 * than quietly connect somewhere unintended.
 */

import postgres, { type Sql } from 'postgres';

export const LOCAL_DATABASE_URL = 'postgres://clawroll:clawroll_dev@127.0.0.1:5432/clawroll';

/**
 * Assemble a URL from the parts an RDS-generated secret actually contains.
 *
 * RDS writes a secret with `username`, `password`, `host`, `port` and `dbname`. It does
 * **not** write a `uri`, and asking ECS to inject one is not a no-op — the task dies at
 * `ResourceInitializationError: retrieved secret from Secrets Manager did not contain json
 * key uri`, before the container starts and therefore before anything can be logged. Three
 * deploys failed exactly that way, and because there were no application logs at all it
 * looked like anything but a missing field name.
 *
 * So the fields are injected individually and joined here. The password is percent-encoded:
 * RDS generates it from a character set that excludes quotes and backslashes but not `/`,
 * `@` or `:`, each of which is structural in a connection URL. An unencoded one produces a
 * URL that parses to a different host and fails with an error naming neither the password
 * nor this function.
 */
function urlFromParts(): string | null {
  const user = process.env['DB_USERNAME'];
  const password = process.env['DB_PASSWORD'];
  const host = process.env['DB_HOST'];
  const port = process.env['DB_PORT'] ?? '5432';
  const name = process.env['DB_NAME'] ?? 'clawroll';
  if (!user || !password || !host) return null;
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}`;
}

export function databaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url) return url;

  // Preferred in the deployed environment, where the parts come straight from the secret.
  const assembled = urlFromParts();
  if (assembled) return assembled;

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('DATABASE_URL, or DB_USERNAME/DB_PASSWORD/DB_HOST, must be set in production');
  }
  return LOCAL_DATABASE_URL;
}

export function createSql(url = databaseUrl(), options: { max?: number } = {}): Sql {
  return postgres(url, {
    max: options.max ?? 10,
    // Money code should never see a silently coerced value.
    transform: { undefined: null },
  });
}

export type { Sql };

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

export function databaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url) return url;
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('DATABASE_URL must be set in production');
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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCAL_DATABASE_URL, databaseUrl, sslFor } from './client.js';

/**
 * Connection-string assembly.
 *
 * This exists because of a production failure that no test could have caught in its previous
 * form: the deployed task asked ECS to inject a `uri` key from the RDS secret, RDS secrets
 * have no such key, and the task died at `ResourceInitializationError` *before* the container
 * started — so there were no application logs, and three deploys were spent diagnosing it as
 * anything but a wrong field name.
 *
 * The lesson encoded here is that the URL is now built in code from the fields RDS really
 * provides, and code can be tested.
 */

const KEYS = [
  'DATABASE_URL',
  'DB_USERNAME',
  'DB_PASSWORD',
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'NODE_ENV',
  'DB_SSL',
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('databaseUrl', () => {
  it('prefers an explicit DATABASE_URL', () => {
    process.env['DATABASE_URL'] = 'postgres://someone:pw@example:5432/db';
    expect(databaseUrl()).toBe('postgres://someone:pw@example:5432/db');
  });

  it('assembles a URL from the fields an RDS secret actually contains', () => {
    process.env['DB_USERNAME'] = 'clawroll';
    process.env['DB_PASSWORD'] = 'secret';
    process.env['DB_HOST'] = 'db.internal';
    process.env['DB_PORT'] = '5432';
    process.env['DB_NAME'] = 'clawroll';
    expect(databaseUrl()).toBe('postgres://clawroll:secret@db.internal:5432/clawroll');
  });

  it('percent-encodes a password containing URL structure', () => {
    // RDS excludes quotes and backslashes from generated passwords but not `/`, `@` or `:`,
    // every one of which is structural in a connection URL. Unencoded, `p@ss/word` makes the
    // URL parse to a completely different host, and the resulting error names neither the
    // password nor this function.
    process.env['DB_USERNAME'] = 'clawroll';
    process.env['DB_PASSWORD'] = 'p@ss/wo:rd';
    process.env['DB_HOST'] = 'db.internal';
    expect(databaseUrl()).toBe('postgres://clawroll:p%40ss%2Fwo%3Ard@db.internal:5432/clawroll');

    // And it must still round-trip to the real password.
    expect(decodeURIComponent('p%40ss%2Fwo%3Ard')).toBe('p@ss/wo:rd');
    expect(new URL(databaseUrl()).hostname).toBe('db.internal');
  });

  it('defaults the port and database name', () => {
    process.env['DB_USERNAME'] = 'u';
    process.env['DB_PASSWORD'] = 'p';
    process.env['DB_HOST'] = 'h';
    expect(databaseUrl()).toBe('postgres://u:p@h:5432/clawroll');
  });

  it('falls back to the local default outside production', () => {
    expect(databaseUrl()).toBe(LOCAL_DATABASE_URL);
  });

  it('refuses to guess in production', () => {
    // A missing configuration in production must fail loudly rather than quietly connect
    // somewhere unintended — which, for a system whose database is the record of money, is
    // the worst available outcome.
    process.env['NODE_ENV'] = 'production';
    expect(() => databaseUrl()).toThrow(/must be set in production/);
  });

  it('refuses a partial configuration rather than assembling nonsense', () => {
    // Half the fields is not a connection. Falling through to the local default here would
    // point a production service at localhost.
    process.env['NODE_ENV'] = 'production';
    process.env['DB_USERNAME'] = 'u';
    process.env['DB_HOST'] = 'h';
    expect(() => databaseUrl()).toThrow(/must be set in production/);
  });
});

describe('TLS selection', () => {
  // The failure this prevents reads as a firewall or permissions problem, not a TLS one:
  //   no pg_hba.conf entry for host "10.0.3.211", user "clawroll", ... no encryption
  // RDS Postgres 15+ ships rds.force_ssl=1 in the default parameter group, so an unencrypted
  // connection is refused outright. The local docker-compose Postgres has no certificate at
  // all, so this cannot simply be on everywhere — hence a decision worth pinning down.
  it('requires TLS for a remote host', () => {
    expect(sslFor('postgres://u:p@db.abc123.us-east-1.rds.amazonaws.com:5432/clawroll')).toBe('require');
    expect(sslFor('postgres://u:p@10.0.3.211:5432/clawroll')).toBe('require');
  });

  it('does not require TLS on loopback or the compose host', () => {
    expect(sslFor(LOCAL_DATABASE_URL)).toBe(false);
    expect(sslFor('postgres://u:p@localhost:5432/clawroll')).toBe(false);
    expect(sslFor('postgres://u:p@postgres:5432/clawroll')).toBe(false);
  });

  it('honours an explicit override in both directions', () => {
    process.env['DB_SSL'] = 'off';
    expect(sslFor('postgres://u:p@db.internal:5432/clawroll')).toBe(false);
    process.env['DB_SSL'] = 'require';
    expect(sslFor(LOCAL_DATABASE_URL)).toBe('require');
  });

  it('does not throw on a malformed URL', () => {
    // Better to attempt the connection and let postgres report a real error than to fail
    // here with something about URL parsing.
    expect(sslFor('not a url')).toBe(false);
  });
});

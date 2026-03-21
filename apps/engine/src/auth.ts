/**
 * Agent authentication.
 *
 * ## Why API keys are hashed with SHA-256 and not argon2id
 *
 * The reflex is "never store a fast hash of a secret", and for *passwords* that is
 * exactly right: humans pick low-entropy secrets, so a stolen database must be made
 * expensive to grind. A Clawroll API key is not that. It is 32 bytes from a CSPRNG —
 * 256 bits of entropy — and there is no dictionary, no reuse across sites, and nothing
 * to guess. Preimage resistance is the entire requirement, and SHA-256 provides it.
 *
 * Using argon2id here would also be actively harmful. Authentication happens on every
 * WebSocket connection, and a deliberately slow KDF on a public endpoint is a
 * self-inflicted denial of service: an attacker with no valid key at all can pin CPU
 * simply by connecting. This is the same reasoning GitHub and Stripe apply to their own
 * API tokens.
 *
 * If Clawroll ever grows human passwords, those get argon2id. Keys do not.
 *
 * ## Keys carry a lookup prefix
 *
 * A key looks like `ck_<8-char id>_<43-char secret>`. The prefix is stored in clear so
 * the record can be found with an indexed lookup, and only then is the secret hashed and
 * compared. Without it, verifying a key would mean hashing the candidate against every
 * row in the table.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface AgentRecord {
  readonly agentId: string;
  readonly displayName: string;
  /** Public half of the key, used to find this record. */
  readonly keyPrefix: string;
  /** SHA-256 of the secret half, hex. */
  readonly keyHash: string;
}

export interface IssuedKey {
  readonly record: AgentRecord;
  /** Shown to the agent operator exactly once and never stored. */
  readonly apiKey: string;
}

const KEY_PREFIX = 'ck';

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Mint a key for an agent. The full key is returned once and never persisted.
 *
 * The **prefix is hex, not base64url**, because `_` is both the field separator and a
 * member of the base64url alphabet. A prefix containing one would split into the wrong
 * fields and the key would never authenticate. The secret stays base64url for compactness
 * — `parseKey` rejoins any underscores inside it rather than requiring it be separator-free.
 *
 * This was not theoretical: the first implementation used base64url for both, and roughly
 * half of all issued keys failed to authenticate.
 */
export function issueKey(agentId: string, displayName: string): IssuedKey {
  const keyPrefix = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return {
    apiKey: `${KEY_PREFIX}_${keyPrefix}_${secret}`,
    record: { agentId, displayName, keyPrefix, keyHash: hashSecret(secret) },
  };
}

/**
 * Split a presented key into its lookup prefix and secret, or `null` if malformed.
 *
 * Parses positionally rather than requiring exactly three parts: the secret is base64url
 * and may legitimately contain `_`, so everything after the second separator is the secret.
 */
export function parseKey(apiKey: string): { keyPrefix: string; secret: string } | null {
  const parts = apiKey.split('_');
  if (parts.length < 3) return null;

  const [scheme, keyPrefix] = parts as [string, string, ...string[]];
  const secret = parts.slice(2).join('_');

  if (scheme !== KEY_PREFIX || keyPrefix.length === 0 || secret.length === 0) return null;
  if (!/^[0-9a-f]+$/.test(keyPrefix)) return null;
  return { keyPrefix, secret };
}

/**
 * Constant-time comparison of two hex digests.
 *
 * `a === b` on a hash leaks, through timing, how many leading characters matched — which
 * is enough to reconstruct a valid digest byte by byte given enough attempts. The digests
 * are the same length by construction, but the length check stays because
 * `timingSafeEqual` throws on a mismatch and a thrown auth check is a failed auth check
 * for the wrong reason.
 */
function digestsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export interface AgentDirectory {
  authenticate(apiKey: string): AgentRecord | null;
}

/**
 * In-memory directory, used for local development and tests.
 *
 * M4 replaces this with a Postgres-backed implementation behind the same interface —
 * which is why `authenticate` is defined on an interface rather than as a free function.
 */
export class InMemoryAgentDirectory implements AgentDirectory {
  private readonly byPrefix = new Map<string, AgentRecord>();

  add(record: AgentRecord): void {
    this.byPrefix.set(record.keyPrefix, record);
  }

  /** Convenience for tests and local runs: mint a key and register it in one step. */
  register(agentId: string, displayName: string): IssuedKey {
    const issued = issueKey(agentId, displayName);
    this.add(issued.record);
    return issued;
  }

  authenticate(apiKey: string): AgentRecord | null {
    const parsed = parseKey(apiKey);
    if (parsed === null) return null;

    const record = this.byPrefix.get(parsed.keyPrefix);
    if (record === undefined) return null;

    return digestsMatch(record.keyHash, hashSecret(parsed.secret)) ? record : null;
  }

  get size(): number {
    return this.byPrefix.size;
  }
}

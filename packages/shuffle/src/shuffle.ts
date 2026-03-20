/**
 * Commit-reveal provable shuffle.
 *
 * The players here are programs, and programs will probe the deal for bias. This
 * module exists so that no one — including us — has to be trusted about the shuffle.
 *
 * ## The protocol, and why the ordering is the whole security argument
 *
 * 1. The server generates a 32-byte `serverSeed` and publishes
 *    `commit = SHA256(serverSeed)` in `hand_start` — **before any card is dealt and
 *    before any client seed is collected**.
 * 2. Each seated agent may submit a 32-byte `clientSeed`.
 * 3. `finalSeed = SHA256(serverSeed ‖ clientSeed₁ ‖ … ‖ clientSeedₙ ‖ handId)`,
 *    with client seeds ordered by seat number.
 * 4. The deck is an unbiased Fisher-Yates shuffle of `FULL_DECK` driven by a
 *    keystream derived from `finalSeed`.
 * 5. At hand end the server publishes `serverSeed`. Anyone recomputes the deck and
 *    checks it against the published hole cards and board.
 *
 * Each half of the protocol defeats a different cheat:
 *
 * - **Committing first** stops the *server* from waiting to see client entropy and
 *   then grinding a `serverSeed` that produces a deck it likes. Once `commit` is
 *   published, the server is bound to one seed by preimage resistance.
 * - **Collecting client seeds after** stops an *agent* from grinding its own seed
 *   against a `serverSeed` it already knows.
 *
 * Reverse those two steps and the scheme provides nothing. A `serverSeed` must also
 * never be reused across hands.
 *
 * ## Why HMAC-SHA256 counter mode rather than ChaCha20
 *
 * The keystream is `HMAC-SHA256(finalSeed, counter)` over an incrementing 64-bit
 * big-endian counter. ChaCha20 would be faster, but speed is irrelevant here — we
 * draw a few hundred bytes per hand.
 *
 * What matters is that **a third party has to reimplement this exactly** to verify a
 * hand, in whatever language they happen to use. HMAC-SHA256 is in every standard
 * library on earth; a plain ChaCha20 stream is not, and reaching for a ChaCha
 * dependency is precisely the kind of friction that stops people from checking our
 * work. Verifiability beats throughput.
 *
 * ## Why the shuffle uses rejection sampling
 *
 * `floor(random() * n)` is biased whenever `n` does not divide the generator's range,
 * and a biased shuffle is exactly the accusation this module exists to refute. Each
 * index is drawn by rejection sampling instead, so every permutation of the 52 cards
 * is exactly equally likely. `shuffle.test.ts` measures this directly.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { type Card, DECK_SIZE, FULL_DECK } from '@clawroll/poker';

/** Length in bytes of both server and client seeds. */
export const SEED_BYTES = 32;

export interface ClientSeed {
  readonly seat: number;
  /** 32 bytes, hex-encoded. */
  readonly seed: string;
}

export interface ShuffleCommitment {
  /** `SHA256(serverSeed)`, hex. Published before the deal. */
  readonly commit: string;
  /** The seed itself, hex. Must stay secret until the hand is over. */
  readonly serverSeed: string;
}

export interface ShuffleInputs {
  readonly handId: string;
  /** Hex-encoded 32-byte server seed. */
  readonly serverSeed: string;
  readonly clientSeeds: readonly ClientSeed[];
}

function assertSeed(hex: string, label: string): void {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length !== SEED_BYTES * 2) {
    throw new Error(`${label} must be ${SEED_BYTES} bytes of hex, got ${JSON.stringify(hex)}`);
  }
}

/** `SHA256` of a seed, hex-encoded. This is the value published before the deal. */
export function commitmentFor(serverSeed: string): string {
  assertSeed(serverSeed, 'serverSeed');
  return createHash('sha256').update(Buffer.from(serverSeed, 'hex')).digest('hex');
}

/** Generate a fresh server seed and its commitment. Never reuse a seed across hands. */
export function createCommitment(): ShuffleCommitment {
  const serverSeed = randomBytes(SEED_BYTES).toString('hex');
  return { commit: commitmentFor(serverSeed), serverSeed };
}

/** A random client seed, for agents that do not want to supply their own entropy. */
export function randomClientSeed(): string {
  return randomBytes(SEED_BYTES).toString('hex');
}

/**
 * Derive the final seed that drives the shuffle.
 *
 * `finalSeed = SHA256(serverSeed ‖ (seat ‖ clientSeed)* ‖ handId)` where each seat is
 * a 4-byte big-endian integer and the pairs are ordered by seat ascending.
 *
 * Three details, each load-bearing:
 *
 * - **Sorted by seat**, so the result depends on *which* seats contributed what and
 *   never on the order the server happened to receive them in. Without this a
 *   verifier could compute a different deck from the same published facts and
 *   wrongly conclude the hand was rigged.
 * - **The seat number is hashed, not merely used for sorting.** Otherwise the same
 *   seed contributed from seat 0 and from seat 5 yields an identical deck, and a
 *   published history could misattribute whose entropy was whose without any
 *   verifier being able to detect it. Binding the seat closes that.
 * - **`handId` is appended**, so identical seeds in two different hands still produce
 *   different decks.
 */
export function deriveFinalSeed(inputs: ShuffleInputs): string {
  assertSeed(inputs.serverSeed, 'serverSeed');

  const seats = new Set<number>();
  for (const cs of inputs.clientSeeds) {
    assertSeed(cs.seed, `clientSeed for seat ${cs.seat}`);
    if (!Number.isInteger(cs.seat) || cs.seat < 0) {
      throw new Error(`Seat must be a non-negative integer, got ${cs.seat}`);
    }
    if (seats.has(cs.seat)) throw new Error(`Duplicate client seed for seat ${cs.seat}`);
    seats.add(cs.seat);
  }

  const ordered = [...inputs.clientSeeds].sort((a, b) => a.seat - b.seat);

  const hash = createHash('sha256');
  hash.update(Buffer.from(inputs.serverSeed, 'hex'));
  for (const cs of ordered) {
    const seatBytes = Buffer.alloc(4);
    seatBytes.writeUInt32BE(cs.seat);
    hash.update(seatBytes);
    hash.update(Buffer.from(cs.seed, 'hex'));
  }
  hash.update(Buffer.from(inputs.handId, 'utf8'));
  return hash.digest('hex');
}

/**
 * Deterministic keystream: `HMAC-SHA256(key, counter)` with a 64-bit big-endian
 * counter, concatenated block by block.
 *
 * Anyone reimplementing verification needs exactly this and nothing more.
 *
 * Exported deliberately: this is part of the published verification contract, not an
 * implementation detail. A third party writing their own verifier reimplements this
 * class exactly, so it is documented and testable rather than hidden.
 */
export class SeedStream {
  private buffer: Buffer = Buffer.alloc(0);
  private counter = 0n;

  constructor(private readonly key: Buffer) {}

  private refill(): void {
    const counterBytes = Buffer.alloc(8);
    counterBytes.writeBigUInt64BE(this.counter++);
    const block = createHmac('sha256', this.key).update(counterBytes).digest();
    this.buffer = Buffer.concat([this.buffer, block]);
  }

  nextUint32(): number {
    while (this.buffer.length < 4) this.refill();
    const value = this.buffer.readUInt32BE(0);
    this.buffer = this.buffer.subarray(4);
    return value;
  }

  /**
   * A uniform integer in `[0, range)` by rejection sampling.
   *
   * Values at or above the largest multiple of `range` that fits in 32 bits are
   * discarded and redrawn. Taking `value % range` without that check would make low
   * indices marginally more likely — small, but it is a real edge and the entire
   * point of this module is that there is no edge.
   */
  uniformBelow(range: number): number {
    if (range <= 0) throw new Error(`range must be positive, got ${range}`);
    const limit = Math.floor(0x1_0000_0000 / range) * range;
    for (;;) {
      const value = this.nextUint32();
      if (value < limit) return value % range;
    }
  }
}

/**
 * Shuffle the canonical deck for a hand.
 *
 * Uses Fisher-Yates from the top down over `FULL_DECK` — the canonical ordering
 * pinned in `@clawroll/poker`. Both that ordering and this algorithm are part of the
 * published verification contract: change either and every prior hand becomes
 * unverifiable.
 */
export function shuffleDeck(inputs: ShuffleInputs): Card[] {
  const finalSeed = deriveFinalSeed(inputs);
  const stream = new SeedStream(Buffer.from(finalSeed, 'hex'));
  const deck = [...FULL_DECK];

  for (let i = DECK_SIZE - 1; i > 0; i--) {
    const j = stream.uniformBelow(i + 1);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}

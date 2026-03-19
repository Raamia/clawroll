# Clawroll — Testing Reference

Companion to [`features.md`](./features.md). That document explains what the system *is*;
this one explains how we know it is **correct**, what each suite protects, and what would
have to break for a bug to reach production.

Every feature that lands adds a section here describing its tests and the reasoning
behind them.

---

## Running the tests

```bash
pnpm test
```

Watch mode while working on a package:

```bash
pnpm test:watch
```

Type-check everything without emitting:

```bash
pnpm typecheck
```

Bring up local Postgres and Redis (needed only for suites that touch the database):

```bash
pnpm dev:infra
```

---

## Testing philosophy

Clawroll is a card game attached to a money ledger. Those two halves fail in very
different ways, so they are tested in very different ways.

**The game logic is tested by properties, not by examples.** There are far too many poker
situations to enumerate by hand, and the interesting bugs live in the combinations nobody
thought to write down — a three-way all-in for uneven stacks where two players tie the
side pot and the odd chip has to go somewhere. So instead of asserting outcomes for
specific hands, we assert *invariants that must hold for every hand*:

- Chips are conserved. The sum of all stacks before a hand equals the sum after, minus rake.
- Every hand terminates. No sequence of legal actions leaves the state machine spinning.
- Side pots sum exactly to total contributions. Not approximately — exactly.
- A replayed hand is bit-identical to the original.

Then we generate thousands of random hands and check those hold every time.

**The money logic is tested by adversarial replay.** The dangerous scenarios in a payments
path are not "does a deposit work" but "what happens when the same deposit arrives twice,"
"what if the withdrawal transaction's fate is unknown," and "what if the process dies
between the debit and the send." These get explicit tests that deliberately reproduce the
failure, because they are the ones that lose money.

**Determinism is a testing feature, not just a design nicety.** Because
`packages/poker` is pure and takes its randomness as an input, every test is exactly
reproducible. A failing property test prints the seed, and that seed replays the failure
forever. There are no flaky game-logic tests, by construction.

**What we deliberately do not unit test.** Thin I/O wrappers, config plumbing, and code
whose only behaviour is delegation. Testing those produces assertions that restate the
implementation and break on every refactor without ever catching a defect. Those paths get
covered by integration tests instead.

---

## Test suites

### F0 — Repository scaffold

**Status:** no tests yet — this feature adds no behaviour.

What it does establish is the harness everything else uses:

- **Vitest** as the runner, at the workspace root so one `pnpm test` covers every package.
  Chosen over the built-in `node --test` because TypeScript, coverage, and watch mode work
  without extra loader configuration.
- **Strict TypeScript as the first line of defence.** With `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` enabled in `tsconfig.base.json`, a whole class of bug is a
  compile error rather than a test we would have to remember to write. `pnpm typecheck` is
  part of the definition of green.

**Verified by hand at this stage:**

```bash
pnpm install     # workspace resolves
pnpm typecheck   # base config is valid
pnpm dev:infra   # postgres + redis come up healthy
```

### F1 — Card primitives

**Suite:** `packages/poker/src/cards.test.ts` — 20 tests, no fixtures, no infrastructure.

This file has an unusual job. Most of it is not looking for logic bugs — the logic is four
lines of arithmetic — it is **pinning a published specification** so that a future refactor
cannot silently break every hand history Clawroll has ever published.

| Group | What it protects |
| --- | --- |
| `canonical ordering` | The fairness contract: `2c` is card 0, `As` is card 51, suits run `c,d,h,s` within a rank, ranks run `2..A` ascending, and the deck is exactly 52 distinct cards |
| `rank/suit encoding` | `makeCard` → `rankOf`/`suitOf` round-trips for all 52 pairs, and the 52 encodings are distinct |
| `isCard` | Range and integrality, including `NaN` and non-integers |
| `parse/format round-trip` | `parseCard(cardToString(c)) === c` for all 52 cards; case-insensitivity; compact and spaced lists agree |
| `parse failures are loud` | Six malformed inputs all throw — notably `'10s'`, since ten is `T` |
| `FULL_DECK immutability` | The shared deck is frozen |

**Why the ordering assertions are written out literally.** The obvious way to test
`cardToString(0) === '2c'` is to derive the expectation from `RANK_CHARS` and `SUIT_CHARS`.
That test would pass even if someone reordered those constants — which is precisely the
change that would break verification of every published hand. So the expected strings are
hard-coded. The test is deliberately redundant with the implementation, because its real
job is to make a spec change *impossible to do by accident*.

**Why `FULL_DECK` immutability gets its own test.** It is shared across every hand in the
process. If a shuffle mutated it in place, hands on unrelated tables would start dealing
from a corrupted deck, and the resulting bug report ("cards are wrong sometimes, on other
tables") would be close to untraceable. `Object.freeze` turns that into an immediate throw.

**Not tested here, on purpose.** Rendering performance, and `cardsToString` on large
inputs. Neither has a correctness dimension.

### F2 — Hand evaluator

**Suite:** `packages/poker/src/evaluator.test.ts` — 37 tests, ~0.5s.

The evaluator is the first component where hand-written examples genuinely cannot establish
correctness. There are 133,784,560 distinct seven-card holdings; any set of examples a human
writes will miss the case that matters. So this suite is built in three layers, each catching
what the others cannot.

**Layer 1 — worked examples.** Category detection for all nine categories, the nine-way
ordering, kicker resolution to the third kicker, and the descriptions used in hand histories.
These are the tests that fail with a legible message when something obvious breaks.

**Layer 2 — exhaustive cross-validation.** *This is the strongest check in the file.* For
20,000 random seven-card holdings, the suite computes the best hand by brute force over all
21 five-card subsets and asserts it equals what the seven-card decision cascade returned.
The cascade is a chain of interacting special cases (two sets making a full house, three
pairs where the third pair is still a legal kicker, a flush that outranks the trips sitting
next to it); brute force is obviously correct but slow. Checking the fast path against the
obvious path over 20,000 hands is what makes the cascade trustworthy.

**Layer 3 — statistical validation.** 200,000 random hands are classified and the category
frequencies compared against published seven-card poker probabilities (straight flush
0.031%, quads 0.168%, … pair 43.8%, high card 17.4%). This catches a class of bug the other
two layers structurally cannot: a category being detected slightly too eagerly, or missed in
a rare configuration, while every hand-written example still passes and brute force agrees
because *both* implementations share the misunderstanding. Frequencies are independent of
our code entirely — they come from combinatorics.

**Determinism.** Both random layers use a seeded `mulberry32` PRNG rather than `Math.random`.
A failure reproduces forever from the seed printed in the assertion message, and there are no
flaky evaluator tests by construction.

**Specific edge cases pinned:**

| Case | Why it is easy to get wrong |
| --- | --- |
| The wheel (A-2-3-4-5) | The only place aces play low; must rank as five-high, below a six-high straight |
| The steel wheel (5s4s3s2sAs) | Same, for straight flushes |
| `QcKdAh2s3c` is *not* a straight | The naive "ace wraps" bug |
| Two sets → full house | Seven cards can hold 3+3; the lower set plays as the pair |
| Three pairs → the third pair kicks | With 3 pairs the third pair's rank is still the best available kicker |
| `AcKcQcJc9c` beats `AcKcQcJc8c` | The fifth flush card plays; it is not a tie |
| Identical ranks, different suits | Must be exactly `0` — suits never break ties in Hold'em |

**A bug this suite found.** During development the exhaustive layer passed while a
hand-written example failed — and the *test* turned out to be wrong, not the code
(`2c2d2h` is trip deuces, not quads, so the flush correctly played). That is the layered
design working as intended: brute force is the authority, and a disagreeing example is
evidence about the example.

### F3 — Hand state and dealing

**Suite:** `packages/poker/src/handState.test.ts` — 31 tests, no infrastructure.

Two jobs: pin the parts of dealing that are a **published contract**, and establish the
chip-conservation invariant that every later feature will be measured against.

| Group | What it protects |
| --- | --- |
| `blind posting` | Clockwise blinds; the heads-up inversion; blinds deducted from stacks; a short blind goes all-in rather than into debt |
| `first to act` | Left of the big blind multi-way; the button heads-up; nobody to act when the blinds put everyone all-in |
| `hole card dealing` | The exact deal order, deck consumption, distinct cards, and that the input deck is never mutated |
| `antes` | Antes reach the pot without counting as a street bet |
| `chip conservation` | Stacks + pot equals the starting total, 2- through 9-handed |
| `nextSeatWhere` | Wrap-around, never returning the starting seat, predicate filtering |
| `config validation` | Six malformed configs plus non-integer stacks and duplicate player IDs |

**Why the dealing test hard-codes specific cards.** With an unshuffled `FULL_DECK` and the
button on seat 0, the test asserts seat 1 holds exactly `2c 2s`, seat 2 holds `2d 3c`, and
seat 0 holds `2h 3d`. Those strings encode the whole one-at-a-time-from-the-small-blind
rule. If someone "simplifies" dealing to two cards per player in a single pass, the deck is
identical, every other test still passes, no chips go missing — and **every published hand
history becomes unverifiable**, because a third party reconstructing the deck from the seed
would compute different hole cards. This test is the only thing standing between that
refactor and a silent break of the fairness guarantee.

**Why chip conservation appears this early.** It is the invariant that will eventually catch
side-pot bugs, and side pots are where poker engines die. Establishing it at deal time —
before any betting exists — means that when it later fails, the bug is unambiguously in the
new code rather than in the setup.

**A bug this suite caught before the code ever ran.** Antes are committed and then removed
from `committedThisStreet` so they do not count toward matching a bet. The first
implementation zeroed the field without adding the money to `pot`, silently destroying every
ante in the hand. The conservation test made it immediate and obvious.

**Non-mutation is tested explicitly.** `startHand` receives the shuffled deck by reference.
If it shuffled or spliced in place, the caller's deck — the one recorded for verification —
would no longer match the hand that was dealt.

---

## Invariant catalogue

The running list of properties the system must never violate. Each is enforced by an
automated test; the ones marked *(also in prod)* additionally run as scheduled jobs
against live data, because an invariant worth testing is worth monitoring.

| # | Invariant | Enforced by | Added |
| --- | --- | --- | --- |
| I1 | The canonical deck ordering never changes — `2c` is 0, `As` is 51 | `cards.test.ts › canonical ordering` | F1 |
| I2 | `FULL_DECK` is exactly 52 distinct cards and is immutable | `cards.test.ts › canonical ordering`, `› FULL_DECK immutability` | F1 |
| I3 | Card notation round-trips losslessly for all 52 cards | `cards.test.ts › parse/format round-trip` | F1 |
| I4 | A card list never contains duplicates | `cards.test.ts › parse failures are loud` | F1 |
| I5 | The best five of seven cards always equals brute force over all 21 subsets | `evaluator.test.ts › agrees with an exhaustive search` | F2 |
| I6 | Hand categories occur at their true combinatorial frequencies | `evaluator.test.ts › category frequencies` | F2 |
| I7 | Equal hand scores mean a genuine tie — suits never break ties | `evaluator.test.ts › kickers` | F2 |
| I8 | Stacks + pot always equals the chips players started with | `handState.test.ts › chip conservation` | F3 |
| I9 | Hole cards are dealt one at a time from the small blind, two passes | `handState.test.ts › hole card dealing` | F3 |
| I10 | A player can never be pushed below a zero stack | `handState.test.ts › blind posting` | F3 |
| I11 | The shuffled deck handed to `startHand` is never mutated | `handState.test.ts › hole card dealing` | F3 |

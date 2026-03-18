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

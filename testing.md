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

### F4 — Betting state machine

**Suite:** `packages/poker/src/betting.test.ts` — 30 tests.

The tests are written against a `play(state, actions)` helper that applies a script of actions
to whoever is currently to act, failing loudly if nobody is. Scripts read like hand histories,
which keeps the tests legible even when the situation is intricate.

| Group | What it protects |
| --- | --- |
| `legal actions` | The BB's preflop option; the 2BB opening minimum; call amounts net of chips already in; a short stack shoving below the normal minimum |
| `street progression` | Preflop→flop→turn→river→showdown; burn-card deck accounting; postflop action starting left of the button; the heads-up inversion; street resets |
| `folding` | Hand ends when everyone folds to one player; folded seats are skipped |
| `all-in short of a full raise` | The seat that already acted may call but not raise; `lastRaiseIncrement` survives a short shove; a full raise does reopen |
| `all-in run-outs` | Board runs out when everyone is all-in; betting continues when one player still has chips behind |
| `illegal actions throw` | Eight distinct illegal actions, each with a specific error |
| `immutability and conservation` | Input state is never mutated; chips are conserved after *every single action* |

**The test that matters most.** `denies a raise to a player who already acted` builds a
four-handed pot where the button raises to 400 (a 300 increment), two players call, and a
short stack then shoves its last 460 — an increment of only 60 against a required 300. The
suite then asserts all four consequences: the shove is legal, `betToCall` rises to 460,
`lastRaiseIncrement` **stays at 300** rather than dropping to 60, and the button — who already
acted — may call 60 but is refused a raise. Getting three of those four right and the fourth
wrong is a very plausible implementation, and it would let a player illegally re-raise off an
under-sized all-in.

**Why chip conservation is asserted after every action, not just at the end.** A hand that
loses chips on the turn and gains them back on the river would pass an end-state check. The
per-action assertion localises any leak to the exact action that caused it.

**Why deck indices are asserted explicitly.** The burn-card test walks the whole hand
asserting `deckIndex` is 10, then 12, then 14. These constants encode the burn rule. If burns
were dropped, every hand would still play correctly and every other test would still pass —
but the board would no longer match what a verifier computes from the seed.

**Immutability is tested by JSON snapshot** before and after an action. The engine keeps prior
states for replay and broadcast; in-place mutation would corrupt already-published history.

### F5 — Side pots and showdown

**Suite:** `packages/poker/src/showdown.test.ts` — 16 tests, ~0.6s.

Side pots are where poker engines die, so this suite is the most adversarial in the package.

| Group | What it protects |
| --- | --- |
| `pot derivation` | One pot when nobody is all-in; correct tier slicing; folded players' chips stay while their eligibility goes; a folded player who contributed *more* than a live one; order-independence |
| `showdown resolution` | Better hand wins; exact ties chop; odd chips; hole cards never revealed on a fold-out; uncalled bets refunded; unfinished hands refused |
| `three-way all-in` | Each pot resolved against its own eligible field, short stack winning only the main pot |
| `random hands` | 5000 fuzzed hands conserve chips; every hand terminates |

**The headline test.** `plays 5000 random hands without creating or destroying a chip` deals
2–9 seats with random stacks between 1BB and 3000, plays uniformly random *legal* actions
until nobody can act, settles, and asserts the chips out equal the chips in. Random stacks
make uneven all-ins — and therefore side pots and odd chips — extremely common.

**Why the fuzzer asserts on its own coverage.** It also requires that at least 500 hands
produced side pots and at least 500 reached showdown:

```ts
expect(handsWithSidePots).toBeGreaterThan(500);
expect(handsToShowdown).toBeGreaterThan(500);
```

Without this, a change that made most hands end preflop would leave a suite that still passes
5000 conservation checks while testing almost nothing. **A fuzz test that does not assert on
its own coverage can quietly stop doing its job.**

**The bug it found.** On the first run it destroyed 1510 chips in hand 624. Seat 3 was all-in
for 223; seats 0 and 2 built a 1510 side pot, then both folded — one folding on the flop when
it could have checked for free. That produced a pot with `eligibleSeats: []`, which
`settleHand` skipped over, deleting the money.

Two changes came out of it, deliberately separate:

1. **Root cause** — folding is legal only when facing a bet. This is the only way to orphan a
   side pot, so removing the action removes the whole failure class.
2. **Symptom** — `settleHand` now throws on a pot with no eligible winner rather than skipping
   it. Silently dropping chips was the actual defect; if guard 1 ever regresses, this fails
   loudly instead.

Both are pinned by regression tests (`betting.test.ts › rejects a fold when the seat could
check for free`, `showdown.test.ts › throws rather than silently dropping a pot`).

**Why this is the argument for property testing.** No reviewer was going to hand-write "two
players build a side pot against a short all-in, then both fold, one of them declining a free
check." The scenario is four interacting rules deep. Worked examples verify what you thought
of; fuzzing finds what you did not.

**`assertChipsConserved` is exported and runs in production**, not just in tests — the same
invariant, monitored on live hands.

### F6 — Commit-reveal shuffle

**Suite:** `packages/shuffle/src/shuffle.test.ts` — 27 tests, ~5s (the statistical group
dominates).

A shuffle cannot be tested by example. "This seed produces this deck" proves only that the
code is deterministic, not that it is *fair*. So the suite attacks three separate claims.

| Group | Claim under test |
| --- | --- |
| `commitment` | The server is bound to one seed; commitments are stable; seeds never repeat |
| `final seed derivation` | Every input affects the deck, and receive-order does not |
| `deck production` | Output is always a permutation of exactly 52 distinct cards |
| `rejection sampling` | No modulo bias at the acceptance boundary |
| `statistical uniformity` | No detectable bias across 50,000 real shuffles |

**Testing the rejection boundary directly.** Modulo bias for a range of 52 drawn from 32
bits is far too small to detect statistically — you would need on the order of 2³⁰ samples.
So instead of trying, a `RiggedStream` subclass feeds `uniformBelow` chosen 32-bit values
and asserts the boundary behaviour exactly: a draw at the limit is discarded, several
consecutive out-of-range draws are all discarded, and the largest in-range draw is accepted.
That converts an untestable statistical property into three deterministic assertions.

**Two complementary uniformity tests.** One checks *every card* landing in the first
position; the other checks *one card* landing in every position. They fail on different
bugs — a shuffle that tends to leave cards near where they started passes the first and
fails the second. Chi-square over 51 degrees of freedom with a threshold of 110 (roughly a
one-in-a-million false failure) against a fair-shuffle expectation near 51.

**The commitment hash is pinned to a literal.** `commitmentFor('00'×32)` must equal
`66687aad…`. Verifiers in other languages must hash the 32 seed **bytes**, not the
64-character hex string — an easy and completely silent mistake to make when
reimplementing. The literal makes the intended reading unambiguous.

**A bug this suite found.** `distinguishes the same seed submitted from a different seat`
failed on first run. The seat number was being used only to *order* client seeds, never
hashed into the digest — so the same seed from seat 0 and seat 5 produced an identical deck.
A published hand history could therefore misattribute whose entropy was whose with no
verifier able to detect it. The fix hashes a 4-byte big-endian seat alongside each seed.
Worth noting the timing: nothing had been published, so this cost nothing. The same finding
after launch would have been a breaking change to the verification spec.

**Not tested here.** Shuffle throughput. We draw a few hundred bytes per hand; the network
round-trip to an agent dwarfs it entirely.

### F7 — Verifier and CLI

**Suite:** `packages/shuffle/src/verify.test.ts` — 25 tests, ~20ms.

| Group | What it protects |
| --- | --- |
| `the verifier agrees with the engine` | `reconstructDeal` matches `startHand` for hole cards 2/3/4/6/9-handed at every button position, and matches the played-out board including burns |
| `commitment verification` | Valid seed accepted; mismatched seed rejected; malformed seed fails without throwing; commitment comparison is case-insensitive |
| `card verification` | Tampered hole cards and boards caught; partial boards accepted; seeds-only proofs verify; missing seats/button reported |
| `reconstructDeal validation` | Fewer than two seats, an unseated button, and card distinctness |
| `result formatting` | Human-readable verdict and per-check lines |

**The cross-check group is the whole reason the duplication exists.** `reconstructDeal` is a
second, independent implementation of the dealing contract. Tests then assert it produces
byte-identical hole cards to `startHand` across five table sizes × every button position, and
an identical five-card board after playing a hand to showdown. If either implementation
drifts — someone "simplifies" dealing, or drops a burn card — these fail immediately.

A verifier that imported `startHand` would pass all of those trivially and detect nothing.
That is the trap this design avoids: **agreement by construction is not evidence.**

**Tamper detection is tested by actually tampering.** The suite substitutes a wrong
`serverSeed` and asserts the commitment check fails *and* that the reported hole cards and
board diverge — reproducing precisely the cheat the protocol exists to prevent (server sees
client entropy, then reveals a seed producing a deck it prefers).

**Verified end to end by hand as well:**

```bash
npx tsx packages/shuffle/src/cli.ts hand.json     # exit 0, all PASS
```

with a tampered copy exiting 1 and naming every card that diverged.

**Malformed input must not throw.** `verifyHand` on a garbage seed returns a failed result
rather than raising. A verifier that crashes on bad input is one a hostile party can make
look inconclusive rather than negative.

### F8 — Wire protocol

**Suite:** `packages/protocol/src/messages.test.ts` — 45 tests, ~15ms.

This suite tests a **boundary**, not an algorithm, so it is written adversarially: most of
it is malformed input that must be refused.

| Group | What it protects |
| --- | --- |
| `inbound frames are validated` | Non-JSON, bare strings, `null`, arrays, unknown types, missing discriminant; errors name the offending field; nothing ever throws |
| `chip amounts cannot be abused` | Negative, fractional, and `NaN` amounts rejected; large integers accepted |
| `every action carries a requestId` | Actions without one are refused; the id survives parsing; the server's `action_request` cannot omit it |
| `card notation` | Valid notation accepted, `10s`/`as`/`Ax` refused, whitespace in lists refused |
| `seed messages` | Exactly 32 bytes of hex |
| `outbound messages round-trip` | Every server message type re-validates after `JSON.stringify` |
| `protocol version` | A mismatched version fails at the schema level |

**Why "never throws" is its own test.** `parseClientMessage` is fed a list of deliberately
nasty strings and asserted not to raise. On a public socket a crash is a denial-of-service
primitive: any agent that can make the parser throw can take down whatever is not carefully
wrapped in a try/catch. Returning a result type makes that structurally impossible rather
than dependent on every call site remembering.

**Why chip validation lives here rather than in the engine.** A negative or fractional chip
amount reaching the betting state machine would corrupt the ledger. Rejecting it at the
boundary means the engine's integer assumption is guaranteed by the type system from that
point inward, instead of being re-checked defensively at each layer.

**A bug this suite found.** `rejects a malformed card list` failed on the first run.
`CardList` was written as "an optional card, then zero or more space-card pairs", which
reads naturally and quietly accepts `" As"` — the optional first group matches empty and
the leading space is absorbed by the repeat. Rewritten as "empty, or a card followed by
space-card pairs". This matters because card lists are compared **as strings** during hand
verification, so stray whitespace would make an honest hand fail to verify.

**Round-trip tests cover encoding, not just parsing.** Each server message is stringified
and re-validated against its own schema. That catches a field whose TypeScript type and zod
schema disagree — for example a `number` typed as required but schema-optional — which pure
inbound tests would never exercise.

### F9 — Table runtime

**Suite:** `apps/engine/src/table.test.ts` — 31 tests, ~70ms.

The runtime is the first component with real I/O, a clock, and untrusted callers — so the
suite is structured around a `Harness` with a **recording `TableIO`** and a **fake clock**.
Nothing is asynchronous, so there are no waits, no timers, and no flakiness: a timeout test
advances `clock` by a number and calls `tick()`.

| Group | What it protects |
| --- | --- |
| `seating` | Seat assignment and preferences, buy-in bounds, duplicates, full table, deferred mid-hand leave |
| `hand start and the fairness ordering` | The commitment is broadcast *before* any seed is collected and before any card exists; seed timeout; refusal of stale seeds |
| `hole cards are never leaked` | `your_cards` goes to exactly one recipient; no broadcast carries hole cards before showdown |
| `the betting loop` | Action requests, broadcasts, stale `requestId`, out-of-turn, illegal action |
| `action timeouts` | Auto-check when legal, auto-fold otherwise, nothing before the deadline |
| `settlement` | Seed revealed, pot paid, button moves, chips conserved over 50 hands |
| `independently verifiable` | A hand played through the runtime verifies from published messages alone |

**The most important test in the repository so far** is
`verifies from the published messages alone`. It plays a full hand through the runtime, then
reconstructs a proof using **only what the engine broadcast** — `commit` and `buttonSeat`
from `hand_start`, `serverSeed` and `clientSeeds` from `hand_end`, hole cards from
`your_cards`, board from `street` — and hands it to `verifyHand` from `@clawroll/shuffle`.

That closes the loop end to end: F6 defined the protocol, F7 built an independent verifier,
and this proves the running engine actually produces hands that verifier accepts. Until this
test existed, the fairness guarantee was architectural rather than demonstrated.

**It is paired with a negative.** `fails verification if the revealed seed is altered` flips
one character of the published seed and asserts the same proof is rejected. Without that, a
verifier that returned `ok: true` unconditionally would pass the positive test. The positive
test also asserts *which* checks ran, because `ok` is vacuously true for an empty check list.

**Why hole-card containment gets three separate tests.** It is the one leak that would
quietly invalidate every result on the site rather than announcing itself: an operator
watching the public feed could feed their own bot. So the suite checks the private send
reaches exactly one recipient, walks every broadcast during a live hand asserting
`holeCards` is null, and confirms revelation happens only in `showdown`.

**Chip conservation runs over 50 consecutive hands**, asserted after each. The runtime also
calls `assertChipsConserved` inside `settle()` on every hand, so a leak throws in production
rather than only failing a test.


### F10 — WebSocket server and authentication

**Suite:** `apps/engine/src/server.test.ts` — 27 tests, ~0.7s. Unlike every suite before it,
this one uses **real sockets against a real listening server** on an ephemeral port.

| Group | What it protects |
| --- | --- |
| `API key handling` | Key round-trips, the secret is never stored, keys are distinct, five malformed shapes rejected, wrong secret rejected |
| `the server over real sockets` | Auth rejection, welcome, spectator access, seating, malformed frames, ping, rate limiting, reconnection, broadcast, hole-card containment, disconnect cleanup, health check |

**Why the integration tests use real sockets.** Everything below this layer is already
covered by fast in-memory tests. What is left is precisely the part a mock cannot check:
that `ws` actually delivers the frames, that `maxPayload` is wired, that a close event
reaches `unseat`, and that the URL parsing gets the API key out. Mocking the socket here
would test the mock.

**A bug this suite found, and why the loop count matters.**
`authenticates every key it issues, 500 times over` exists because the first implementation
generated the key prefix with base64url — whose alphabet includes `_`, the same character
`parseKey` splits on. A prefix containing one split into the wrong fields and the key was
rejected as unauthorized. **Roughly half of every key issued was broken.**

Seven socket tests failed with "timed out waiting for welcome", which is what surfaced it.
The important detail is the fix to the *test*: asserting on one key would have passed about
50% of the time — a textbook flaky test that gets re-run, goes green, and hides a defect
affecting half of all users. Five hundred iterations makes it deterministic.

**Rate limiting is asserted not to close the socket.** Disconnecting a chatty agent
mid-hand would fold it by timeout, turning a client bug into lost chips. The server pushes
back with `rate_limited` and keeps the connection.

**Spectator containment is re-tested at this layer** even though F9 covers it in the runtime.
The runtime guarantees no *broadcast* carries hole cards; this asserts the socket layer does
not accidentally deliver a private `your_cards` to the broadcast set — a different mistake,
in different code, with the same consequence.

**Health check has a negative.** `/healthz` returns 200 and `/nope` returns 404, so a typo'd
health-check path fails loudly rather than reporting healthy from a catch-all handler.


### F11 — Reference agent and the demo session

**Suite:** `apps/engine/src/bots/session.test.ts` — 10 tests, ~6s (the session dominates).

| Group | What it protects |
| --- | --- |
| `hand strength heuristic` | Made hands beat unmade, pairs beat trash, suited/connected rewarded, bounded 0..1 |
| `strategies produce a legal-looking decision` | 200 iterations each: amounts stay within `minRaiseTo..maxRaiseTo`, actions are real actions, nobody folds a free check |
| `a full session over real sockets` | 25+ hands played, **all** verified, chips conserved, zero agent errors |

**The end-to-end test is the M3 acceptance criterion.** Everything beneath it is already
covered in isolation; this asserts the pieces work *together* — real server, real sockets,
real bots, real hands — and it checks four things at once:

- hands actually got played (not a silently stalled table),
- `verifiedHands === handsPlayed` — **all**, not most,
- chips in equals chips accounted for, counted by the engine rather than the bots,
- `botErrors` is empty, which is what catches a regression in the protocol contract: an
  agent written against the documentation must never see an error.

**Why the demo found bugs that 290 unit tests did not.** All three were **integration**
failures, invisible to any component tested alone:

1. A **listener-attachment race** — the bot subscribed to `message` after awaiting `open`,
   missing the `welcome` frame that triggers `join_table`. Every unit test passed; the bot
   played zero hands and looked like a broken server.
2. A **liveness** failure — one multi-way all-in left a single survivor and the table could
   not deal. Correct behaviour by every component, and a dead table.
3. An **accounting** error — the demo trusted the bots' own buy-in counts, including ones
   the server rejected, and reported a 110,000-chip conservation violation that did not
   exist.

The third is the instructive one: the instrumentation was wrong, not the engine. It still
produced a fix worth having — `TableRuntime.assertTableChipsConserved()`, a table-level
invariant spanning seating, cash-out and bust-out, which per-hand accounting structurally
cannot see. **A false alarm that reveals a missing invariant is not a wasted investigation.**

**A test that broke for the right reason.** `rate limits a flood without closing the socket`
failed when the default budget was raised from 20/s to 120/s — proving it was asserting on
the constant rather than the mechanism. It now starts its own server with
`messagesPerSecond: 5`, so it tests throttling regardless of what the default becomes.

**Strategy tests run 200 iterations, not one.** `randomBot` is seeded but its output depends
on call order, so a single call would exercise one branch. Two hundred covers every option
the legal-action set offers.


### F12 — Double-entry ledger

**Suite:** `packages/db/src/ledger.test.ts` — 20 tests, ~0.25s, **against real Postgres**.

```bash
pnpm dev:infra   # required for this suite
```

**Why there is no in-memory double.** The `UNIQUE` on `external_ref`, `SELECT … FOR UPDATE`,
and transactional rollback *are* the correctness mechanism. A fake that reimplemented them in
JavaScript would be testing the fake. This is the one suite where the infrastructure
dependency is the whole point.

| Group | What it protects |
| --- | --- |
| `the constraints actually exist` | Interrogates `pg_indexes`/`pg_constraint` to confirm the UNIQUE, both CHECKs, and both partial indexes are live |
| `a transaction must balance` | Non-zero sums, single-sided entries, fractional amounts, and full rollback on rejection |
| `deposits are idempotent` | Sequential replay, **concurrent** replay, distinct signatures |
| `accounts cannot go negative` | Withdrawal and buy-in overdrafts refused; `house` permitted to run negative |
| `concurrent transfers do not deadlock` | 20 parallel transfers on shared accounts |
| `a full money round trip` | Deposit → buy-in → settle with rake → cash-out → withdraw, conserving every micro-USDC |
| `global invariants` | All entries sum to zero; no unbalanced transaction; no negative agent account |

**Why the suite checks that constraints exist.** `schema.ts` and `migrate.ts` declare the
same shapes independently and can drift. **A constraint that was declared but never created
is worse than no constraint at all**, because the application is written trusting it — the
double-credit protection would be a comment. So the tests query the live catalog rather than
the source.

**A bug found by probing, which a passing test was hiding.** The idempotency contract held
for sequential replays. Under concurrency it did not: two callers both found no existing row,
both inserted, and the loser received a raw Postgres `23505`. Money stayed correct — the
constraint did its job — but the documented contract was broken.

The original test **passed anyway**, because it asserted only `succeeded.length > 0` and the
final balance. Both were true while 7 of 8 callers were getting exceptions. The lesson is
specific: *asserting on the outcome is not the same as asserting on the contract*. The test
now checks that zero calls reject, that exactly one reports `created: true`, and that all
callers receive the same `txId`.

**The deadlock test would fail reliably without the lock sort.** Twenty concurrent transfers
touching the same two accounts is exactly the shape that deadlocks when lock order varies.
It is allowed to reject for insufficient funds — that is a legitimate outcome — but any
*other* rejection fails the test.

**Note on parallelism.** This is currently the only suite touching Postgres. Tests use fresh
random ids per case so they never collide, but a second DB suite would run in a different
worker against the same database; that will need a per-worker schema or `describe.sequential`.


### F13 — Devnet guard and deposit addresses

**Suites:** `packages/solana/src/cluster.test.ts` (16) and `derivation.test.ts` (18).

| Group | What it protects |
| --- | --- |
| `the devnet guard` | Accepts devnet; refuses mainnet-beta, testnet, and unknown clusters; **fails closed** when the cluster cannot be verified at all |
| `USDC amounts` | Six decimals, rounding rather than truncation, out-of-range refusal, string round-trip |
| `master seed` | BIP-39 checksum enforced, ragged whitespace tolerated, passphrase changes the seed |
| `derivation paths` | Standard Solana BIP-44 path, four invalid indices rejected |
| `deposit accounts` | Determinism, 200 distinct addresses, owner ≠ token account, per-mint ATAs |
| `against the live network` | Opt-in: the real devnet and mainnet endpoints |

**Why "fails closed" has its own test.** An unreachable RPC could plausibly be treated as
"probably fine, carry on". It must not be. When the question is *is this real money?*,
unknown is not permission — so the guard throws on a connection error rather than proceeding.

**Why the live tests exist, and why they are off by default.** Every other test here takes
the genesis hash constants **on trust** — they assert that a stub reporting devnet's hash is
accepted, which proves the comparison works, not that the constant is right. Only
`CLAWROLL_LIVE_TESTS=1` checks the constants against reality. Both were verified against the
real endpoints:

```
devnet        EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
mainnet-beta  5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d
```

They are opt-in because a public RPC is rate-limited and occasionally unreachable, and a
network-dependent test in CI trains people to ignore red builds. Worth running before a
deploy. Note the failure mode is benign: a wrong devnet hash means the guard rejects the
**real** devnet and Clawroll refuses to start — loud, and only at deploy time.

**A bug the checksum validation caught immediately.** The test file initially used a
mistyped BIP-39 vector (`…abandon art` instead of `…abandon about`). `masterSeedFromMnemonic`
rejected it and the suite failed to load. That is precisely the scenario the check defends
against in production: a mistyped word derives a *different valid seed*, and without the
checksum it would have silently produced a whole set of addresses nobody holds keys to. The
validation earned its place before the code ever ran.

**Why 200 addresses, not 2.** Address collision between agents is the failure that silently
credits the wrong account. Two indices agreeing could happen by luck in a broken
implementation; 200 distinct addresses across both owners and token accounts will not.


### F14 — Deposit scanner

**Suite:** `apps/wallet-worker/src/scanner.test.ts` — 15 tests, ~0.3s, against real Postgres
plus a scriptable fake Solana.

| Group | What it protects |
| --- | --- |
| `crediting deposits` | New deposits, several transfers in one transaction, several separate deposits, failed transactions, no-op transactions, deposits to someone else's address |
| `replays never double-credit` | Repeated scans, a **completely lost cursor**, a crash between crediting and recording, three concurrent scanners |
| `the cursor` | Only new signatures fetched on a later scan; failed transactions still advance it |
| `dust` | Below-minimum deposits ignored |
| `observability` | `findUncreditedDeposits()` empty on success, populated when money is stranded |

**Why the Solana side is a fake and the Postgres side is real.** They fail in different
ways, so they are tested differently. The database's `UNIQUE` constraint *is* the
double-credit protection, so faking it would test the fake. Solana, by contrast, cannot be
asked to reproduce the cases that matter — the same signature twice, an RPC dying mid-poll,
a transaction that landed but failed. Those are the scenarios worth exhaustive coverage, and
a scriptable gateway is the only way to reach them.

**The test that justifies the write ordering.** `recovers when a crash lands between
crediting and recording` credits a deposit, then deletes the sighting row to simulate dying
in the gap, then re-scans. It asserts the balance is unchanged (no double credit) *and* that
the sighting is restored.

Reverse the order in `scanner.ts` and this test still passes — but the **real** failure it
describes becomes unrecoverable: with the sighting written first, a crash before crediting
leaves a signature marked handled and money never paid. That asymmetry is why the ordering is
documented in the source rather than left to look arbitrary.

**`survives losing the cursor entirely` deletes every sighting** and re-scans, asserting two
replays ignored, zero credited, and an unchanged balance. This is the crash-recovery path
stated as a property: cursor loss is a performance problem, not a correctness one.

**Concurrency is tested with three simultaneous scanners**, asserting no rejections and a
single credit — the two-worker-instance case, which is how this would actually be deployed.

**Note on Postgres parallelism.** This is now the second suite touching the database, running
in a different vitest worker from `ledger.test.ts`. It is safe because every case allocates
fresh random ids, and the global invariant checks in `ledger.test.ts` read only committed
state, which is balanced by construction. A third DB suite should still prompt a move to
per-worker schemas.


### F15 — Withdrawal worker

**Suite:** `apps/wallet-worker/src/withdrawals.test.ts` — 16 tests, real Postgres plus a
scriptable chain.

| Group | What it protects |
| --- | --- |
| `requesting a withdrawal` | Debit precedes any chain contact; overdrafts refused with nothing sent; invalid amounts refused |
| `the happy path` | Sign → record → send → confirm; a confirmed withdrawal is a no-op |
| `a send whose fate is unknown` | No rebuild while the blockhash is valid; a transaction that **landed despite the send erroring** is confirmed; rebuild only after provable expiry; a crash between signing and broadcasting never double-sends |
| `a transaction that lands and fails` | Refund issued, and issued only once |
| `queue and observability` | `pending()`, `findStuck()` |
| `the ledger stays balanced` | Across successes, failures and refunds alike |

**The test that describes the actual disaster.** `confirms a transaction that landed even
though the send reported an error` scripts the nastiest real behaviour: the RPC throws *and
the transaction lands anyway*. A worker that trusted the return value of `send` would treat
this as a failure, rebuild, and pay twice. The worker instead queries the recorded signature
and confirms. **This is the single case the entire design exists for.**

**`rebuilds only once the blockhash has provably expired`** walks the full sequence: send
errors, first check does not rebuild (signature unchanged, `attempts` still 1), blockhash
expires, status resets to `debited` with the signature cleared, a fresh attempt succeeds with
a *different* signature, and the final balance is debited exactly once. Asserting the
signature is unchanged before expiry is what proves the worker waited rather than gambled.

**Why the chain is faked and Postgres is real.** Same split as the deposit scanner and for
the same reason. Every scenario that matters here is a *partial failure* — a send that errors
but lands, a blockhash expiring mid-flight, a crash between signing and broadcasting — and
none can be requested from a live RPC. Meanwhile the durability of the state machine is
Postgres's job, so that half stays real.

**Crash recovery is tested by constructing a second worker.** `never sends twice across a
crash between signing and broadcasting` signs with one worker, then advances with a freshly
constructed one, as a restarted process would. It asserts nothing was sent and `attempts`
stayed at 1 — the recovery read the durable row rather than starting over.


### F16 — Bankroll service and settlement outbox

**Suite:** `apps/engine/src/bankroll.test.ts` — 16 tests, real Postgres.

| Group | What it protects |
| --- | --- |
| `chips at a table are already real money` | Buy-in moves `available → in_play` before the seat exists; overdrafts and invalid amounts refused |
| `the settlement outbox` | Record then apply; applied exactly once across repeated drains; duplicate records ignored; a failed apply stays retryable; empty settlements skipped |
| `reconciling chips stranded by a crash` | Orphaned `in_play` returned; live tables untouched; the ledger trusted over the cached stack |
| `a real hand settles through to Postgres` | A hand played by the runtime, its own deltas applied, holdings conserved, ledger balanced |

**The end-to-end test is the wiring proof.** It plays a real hand through `TableRuntime` with
a recording IO, drains the emitted `LedgerEvent`s, and applies them — asserting the deltas net
to zero, total holdings are unchanged by play, and each agent's `in_play` balance now equals
the stack the table is actually holding. Nobody computes the result twice; the ledger receives
exactly what the table did.

**A test-design bug worth recording.** The suite initially asserted
`applyPendingSettlements().failed === 0`. That drains the **whole** outbox, so once an earlier
test deliberately parked an unappliable settlement, every later drain reported a failure —
including on the next run, since the row survived in the database.

Two changes came out of it, and the second matters more than the first:

1. The deliberate-failure test now cleans up after itself, and `beforeAll` clears orphans left
   by earlier runs.
2. **Every assertion is now per-hand rather than on a global count.** A global count couples
   each test to whatever else happens to be pending, which is exactly the coupling that made
   this fail for a reason unrelated to the behaviour under test.

**A deliberately unbalanced settlement is used to test the failure path** — the ledger refuses
it, `attempts` increments, `applied_ledger_tx_id` stays null, and `findStuckSettlements`
surfaces it. Losing a settlement silently would be worse than failing to post one.


### F17 — Server wired to the ledger

**Suite:** `apps/engine/src/wired.test.ts` — 8 tests, real sockets and real Postgres together.

| Group | What it protects |
| --- | --- |
| `buying in over a socket moves real money` | `available → in_play`; underfunded buy-ins refused and not seated; a failed seating hands the reservation back |
| `leaving returns chips` | Explicit leave and disconnect both cash out |
| `hands settle through to the ledger` | After real hands, `in_play` equals the stack the table is holding, holdings are conserved, ledger balanced |
| `hand ids are globally unique` | Three server restarts produce three distinct ids |
| `startup reconciliation` | Chips at a table this process does not serve are returned |

**The bug this suite found is the most serious in the project so far.** Hand ids came from a
per-process counter, so every restart re-issued `hand-1`, `hand-2`. Because the hand id *is*
the settlement idempotency key — outbox `PRIMARY KEY` and ledger `external_ref` — a collision
did not raise an error. `ON CONFLICT DO NOTHING` **silently discarded a real settlement**.

Nothing below this layer could have caught it. Every unit test passed; the runtime was correct,
the ledger was correct, the outbox was correct. It took an assertion that compared *the ledger*
against *the table* to reveal that the two had quietly diverged. That comparison is now the
suite's central assertion, and it counts how many agents it actually compared so it cannot pass
vacuously.

**Two test-quality lessons, both from failures here:**

*Fixed sleeps are calibrated against an idle machine.* These tests initially used
`await settle()` — a 400ms pause. They passed alone and failed in the full parallel run,
because the buy-in had simply not finished yet. That looks exactly like a logic bug and is
not. Every wait is now `waitUntil(condition)`, which is insensitive to machine load and fails
with a real message when the condition genuinely never holds.

*Parallel suites sharing one database must scope their cleanup.* Both this file and
`bankroll.test.ts` cleared pending settlements in `beforeAll` with an unscoped
`DELETE … WHERE applied_ledger_tx_id IS NULL` — **deleting each other's rows** mid-assertion.
Both are now scoped to a per-run table id.

**A residual flake, and what it actually turned out to be.** Worth recording in full, because
the first two diagnoses were both wrong.

One full-suite run in nine produced a timeout. The first response was a longer polling budget.
When it recurred, the second was to split the suite into a parallel **pure** project and a
serialised **database** project (`vitest.workspace.ts`) on the theory that eight suites sharing
one Postgres were starving each other. Three clean runs followed and it looked fixed.

It was not. Running the suite eight more times surfaced a *different* failure — and the real
one: `bankroll.test.ts` played a single hand and asserted it produced exactly one settlement
event. **A chopped pot where every player committed the same amount leaves every net at zero,
so the runtime correctly emits no settlement at all.** Two check-downs tying happens roughly
one hand in four heads-up. The test was wrong, the code was right, and both earlier fixes were
treating a symptom that had nothing to do with the cause.

The test now plays until a hand actually moves chips, which tests the wiring without depending
on the outcome of a particular deal. Eight consecutive clean runs since.

Two lessons, and the second is the expensive one. *A test that assumes a specific game outcome
is a test with a hidden failure rate* — here, 25%. And *an intermittent failure attributed to
infrastructure deserves the same scepticism as any other diagnosis*: "it's a race" and "it's
contention" are satisfying explanations precisely because they are unfalsifiable without
actually reading the failure. The workspace split was still worth keeping — serialised database
suites are correct regardless — but it was not the fix.


**A second intermittent failure, in the same family and found the same way.** The full-session
run occasionally reported one hand played but not verified — with an *empty* failure list. No
hand failed verification; one was simply not counted.

The table broadcasts `hand_end` and then increments `handsPlayed`, both inside one synchronous
settle. So the instant the table reports N finished hands, the Nth `hand_end` frame can still
be in flight to the auditor's socket — same process, but delivery is still asynchronous. The
harness audited a feed one message behind the counter it compared against, and reported the
engine as having dealt an unverifiable hand. Roughly one run in twenty.

The tempting fix is `expect(verified).toBeGreaterThanOrEqual(played - 1)`, which would hide
exactly the defect this test exists to catch. The harness now waits for the spectator to catch
up before measuring; the assertion stays at full strength. Everything after that wait is
synchronous, so the audit and the hand count are still a single consistent snapshot — that part
was never the problem.

**Third time a "flaky test" turned out to be the test's fault, not the system's.** The pattern
is consistent enough to state as a rule: an intermittent failure is a claim about the system,
and it deserves the same burden of proof as any other claim. The reflex to widen a tolerance is
how a real defect becomes permanently invisible.


### F18 — Hand archive and read API

**Suite:** `apps/engine/src/archive.test.ts` — 14 tests, real Postgres and real HTTP.

| Group | What it protects |
| --- | --- |
| `publishing a hand` | Full round-trip; written once and never updated; unknown hands return null; folded seats keep their cards private |
| `proofs` | Exactly the fields a verifier needs, and explicitly *not* pot/winners/stacks |
| `listings` | Recent hands with pot and winners; leaderboard ranking |
| `publicly verifiable` | A hand played by the engine, archived, fetched over HTTP, and verified from the downloaded proof |
| `the read API` | Unauthenticated, CORS-open, 404s unknown hands and routes, health check intact |

**The test that closes the public loop.** `is archived, served over HTTP, and verifies from
the served proof` plays a real hand through the server, waits for it to be archived, then
**fetches the proof over HTTP exactly as a stranger would** and runs it through `verifyHand`.

The distinction matters: earlier tests proved the engine *could* produce a verifiable hand.
This one proves the artefact a member of the public actually downloads verifies. It also
asserts which checks ran, since `ok` is vacuously true for an empty check list.

**Two bugs found here, both about honest answers:**

*The router returned 503 for unknown paths.* The archive-configured check ran before route
matching, so `/api/nope` answered "no hand archive configured" rather than "not found". A
client acts differently on those. Caught by an existing test from F10 — an older test failing
because of a new feature is the system working.

*The leaderboard test asserted on a global aggregate.* It fetched an unscoped top-25 across
every hand ever archived, so as the database filled the fixtures dropped off the end and the
test failed for a reason unrelated to ranking. **This is the third time the same trap has
appeared in this project** — after the global settlement drain and the unscoped `DELETE`.
The rule, now applied consistently: *never assert on a global aggregate in a shared database.*
`leaderboard()` gained a table filter, which the product wants anyway for per-table standings.

**Immutability has its own test** — re-recording a hand with a different board must not change
the stored one. Without it, an upsert introduced later would silently make every published
history editable, and verification would become theatre.


### F19 — Spectator web app

**No unit tests.** This is deliberate and worth stating plainly rather than leaving as a gap.

The app is presentation over an API that is already covered end to end: `archive.test.ts`
proves a hand played by the engine is archived, served over HTTP, and verifies from the
downloaded proof. Component tests over this layer would mostly assert that React renders the
props it was given — restating the implementation, breaking on every refactor, and catching
approximately nothing.

**Verified by driving the real thing instead.** The full stack was run locally (`pnpm dev`:
real engine, real Postgres, real ledger, real bots) and every page exercised in a browser:

| Checked | Result |
| --- | --- |
| Live table during a hand | Pot accumulating to 42.80, folded seat greyed, per-seat bets shown |
| Hole cards on the public feed | Face down for every live player, at every point |
| Replay | 13 actions steppable; showdown hands shown, folded hands still face down |
| Leaderboard | Ranked, with net winnings |
| Verify page | Proof served, command displayed |
| The displayed command | Piped a served proof into the CLI — `VERIFIED`, exit 0 |
| Console | No errors |
| Production build | `tsc --noEmit && vite build` clean |

**Two real bugs found by looking at it, which no unit test would have caught:**

*The live table never updated during a hand.* The page listened only for `table_state`, which
the runtime broadcasts on seat changes and settlement — not mid-hand. A viewer saw an empty
board and a zero pot while a hand played out in front of them. Every API test passed; the data
was all being sent. Only watching it revealed the page was ignoring most of it.

*The verify page displayed a command that did not work.* `npx clawroll-verify` fails today
because the package is unpublished. On a page arguing *do not take our word for it*, a
copy-paste that errors is the worst possible detail to get wrong. Caught by running the
command rather than reading it.

**A test that failed for a good reason.** Adding `handIntervalMs` (a 2s pause between hands,
so spectators can follow the action) dropped the demo session below its 25-hand target. The
default is right for a real table; the session test measures throughput and correctness, so
it now opts out with `handIntervalMs: 0`. A shared default changing behaviour somewhere it
should not is exactly what that assertion is for.


### F20 — Real Solana withdrawal gateway

**Suite:** `apps/wallet-worker/src/solana-gateway.test.ts` — 13 tests, 2 opt-in.

| Group | What it protects |
| --- | --- |
| `base58 encoding` | Agreement with `@solana/web3.js` over 500 random keys; all-zero input; every leading-zero count; empty input; 64-byte signature length |
| `input validation` | Non-positive and fractional amounts, malformed destinations — all refused before any RPC call |
| `treasury token account` | Derived as the ATA, distinct from the wallet address |
| `against live devnet` | Reads the chain; a fresh treasury reports zero rather than throwing; an unknown signature is `null`, not an error |

**Why base58 is cross-checked rather than asserted.** It is fifteen lines of hand-written
encoding, and it is the one place in this file where a subtle bug is genuinely dangerous: a
mis-encoded signature means the worker asks the chain about a transaction that does not exist,
concludes it never landed, and eventually rebuilds — **while the original is sitting in a
block.** So the test compares against `PublicKey.toBase58()`, an independent implementation,
over 500 random inputs.

**It found the bug immediately.** The digit array was seeded with `[0]`, emitting a spurious
leading `'1'` — 33 characters for the all-zero key instead of 32. Leading-zero handling is the
classic base58 mistake and it only shows on rare inputs, which is exactly why the suite tests
all-zero, 1-through-5 leading zeros, and empty separately rather than trusting the random
sweep to stumble into them.

**Why the live tests assert on `null`.** A signature the cluster has never seen must come back
as `null`, not as an error. The withdrawal worker relies on that distinction to tell *"not
landed"* from *"cannot tell"* — and those lead to opposite decisions. It also checks that a
brand-new treasury with no token account reports a zero balance rather than throwing, since
that is the path a first deployment takes.

**What is not unit-tested here, on purpose.** Transaction assembly against a live validator —
whether a transfer actually moves USDC — needs a funded treasury and a faucet, which is a
deployment step rather than a test. The live opt-in covers everything reachable without funds;
the rest belongs in a devnet smoke test after M6.


### F21–F22 — Containers and infrastructure

**No unit tests, deliberately.** A CDK stack is a declaration; asserting that
`instanceType` equals what was written two lines above restates the source and breaks on every
refactor without catching anything. What matters is whether it *synthesizes* and whether the
resulting template says what was intended.

**Verified by building and running, and by inspecting the synthesized template.**

| Checked | Result |
| --- | --- |
| Both images build | Typecheck runs inside the build stage and gates it |
| Engine container serves | `/healthz` and `/api/tables` against host Postgres |
| Graceful shutdown | `docker stop` → SIGTERM logged → exit 0 |
| Non-root | `uid=100(clawroll)` |
| Worker startup order | Cluster verified as devnet **before** failing on the missing mnemonic |
| `cdk synth` | Clean, no warnings |
| Template contents | RDS encrypted, deletion-protected, not public; both services single-task with circuit breakers; ALB idle 3600s; `/healthz`; S3 public access blocked |
| Master seed secret | `hasValue=false` — genuinely empty |

**Three bugs this found, none of which a unit test would have:**

*A recursive copy explosion* — `fromAsset('..')` bundled `infra/cdk.out` into itself until the
path exceeded the filesystem limit. There was no `.dockerignore`, so every earlier Docker
build had also been shipping `.git` and `node_modules` into the context.

*The master seed secret was not empty.* CDK's L2 `Secret` fills an unspecified secret with a
random 32-character string. The template inspection caught it; reading the code would not
have, because the code says exactly what I intended and the construct did something else.

*Corepack downloading pnpm at container start* — a network call on every task launch, and a
hard failure in a VPC without egress. Found by reading the container's own logs.

**What is not verified, and cannot be from here.** Whether the stack actually deploys: that
needs AWS credentials and a bootstrapped account. `cdk synth` proves the template is valid
CloudFormation, not that CloudFormation will accept every resource in a real account. The
first `cdk deploy` is still a real test.


### F23 — SDKs and registration

**Suites:** `packages/sdk-ts/src/client.test.ts` (6) and
`apps/engine/src/agent-directory.test.ts` (11), both against real Postgres.

| Group | What it protects |
| --- | --- |
| `a bot written the documented way plays hands` | A bot copied from the quickstart connects, sits, and finishes hands |
| `the SDK protects the author from their own mistakes` | Out-of-range raises clamped, impossible actions substituted, a throwing `act` folds |
| `situation` | Hole cards, board, and precomputed legal actions all arrive |
| `authenticating against the database` | Keys survive a restart; wrong secrets rejected; a cold directory fails closed |
| `the secret is never stored` | Only a hash and a lookup prefix reach the database |

**The SDK test is the quickstart, executed.** It writes a bot the way the documentation says
to and asserts hands complete. If any protocol obligation the SDK claims to handle were
missing — entropy, `requestId`, buy-in, re-buys — no hand would finish, so the test covers all
of them without asserting on any individually.

**The author-mistake tests matter more than the happy path.** Each deliberately writes a
*wrong* bot — one that raises 999,999,999,999, one that always checks even when facing a bet,
one that throws — and asserts the agent keeps playing and the author gets a warning naming the
problem. That is the SDK's actual promise: not that correct bots work, but that incorrect ones
fail legibly.

**The Python SDK is verified by running it, not by unit tests.** It connected to the live
engine, sat down, played hands, and reported results (+17.69, 0.00, −0.10, −0.10 USDC). A
mirrored protocol implementation is exactly the thing where a unit test against my own
assumptions would prove nothing.

**Three bugs found by running the quickstart rather than writing it** — `MAX+1` index
allocation breaking on first use, `pip install -e .` failing on a missing README, and a
registered agent being rejected because the dev harness only checked the in-memory directory.
All three were on the path a first-time user takes, and none would have been caught by testing
the components in isolation.


---

---

### F24 — The house rake

`packages/poker/src/showdown.test.ts` — seven tests, part of the 23 in that file.

**What is checked.** Each rule of the policy separately — the percentage, the cap, no flop no
drop, rounding down — and then the two properties that matter more than any of them: chips
stay conserved with a rake applied, and the rake drains from the main pot before any side pot.

**The conservation test is the important one.** The rake is the first thing in the system that
legitimately removes chips from a table, which makes it the first thing that can break the
invariant guarding every hand. `assertChipsConserved` now counts the rake on the after side,
and the test asserts the sum still balances exactly. Without a test pinning that down, the
natural response to the invariant firing on a raked hand is to weaken the invariant.

**Rounding is tested at the boundary**, on a pot whose 5% is not a whole number of
micro-USDC. Getting this wrong is invisible in aggregate and only shows up as a house that
takes marginally more than its published cap.

**The 5,000-hand fuzz is unchanged and still asserts exact conservation.** It runs with no
policy configured, which is the point: an unraked table must take nothing at all, and that is
a stronger statement than "takes approximately nothing".

---

### F25 — Agent profiles

`apps/engine/src/archive.test.ts` — four tests, part of the 18 in that file.

**The test that would have caught the bug.** `handsForAgent` used to select hand ids correctly
and then build summaries by filtering the newest 500 hands globally, so any hand outside that
window vanished. No suite deals five hundred hands, so nothing failed. The new test records a
hand for an agent that appears nowhere else and asserts the summary comes back — a direct
assertion that finding an agent's hands does not depend on a global recency window, rather
than a mock of the window itself.

**Cross-checking two queries against each other.** The profile aggregate and the leaderboard
compute hands played and net from the same JSONB by different SQL. A test asserts they agree.
If they ever diverge, the profile is the number a reader would doubt and the leaderboard the
one they would believe — so the disagreement has to fail in CI rather than in front of anyone.

**Absence is tested as its own case.** An id nobody has used returns `null`, which the API
turns into a 404. Asserting this explicitly is what keeps "has played nothing" from quietly
becoming the answer to "does not exist".

**Verified against a live engine, not just in the suite.** The page was loaded against a
running engine with 315 archived hands: the rendered totals matched the API exactly, an
unknown id rendered the empty state off the 404, and leaderboard to profile to hand replay
navigated with no console errors. A React page that typechecks is not a React page that
renders.

---

### F26 — Removing the unused Redis cluster

No new tests. The verification was inspecting the synthesised template: zero ElastiCache
resources, 62 total, and a clean synth. The reason it was safe to remove was established by
grep — no application code referenced `REDIS_URL` — which is a stronger argument than any test
could make, since a test can only cover the paths someone thought to write.

### F30 — The quiet-table deadlock

Three dead ends, each independently sufficient to strand an agent forever, so each has its own
test and each test was confirmed to fail with only its own fix reverted. That mattered here more
than usual: the first one found was not the last one worth looking for, and a suite that went
green after one fix would have hidden the other two until the next outage.

- **The table falls silent.** `server.test.ts › a table that cannot deal › keeps announcing
  itself so a lone agent is not stranded` seats one agent at a table that cannot reach two
  players, and asserts `table_state` keeps arriving while `hand_start` never does. The second
  assertion is the one that keeps the test honest — it would also pass if the table started
  dealing to a single player, which would be a worse bug than the one being fixed.
- **The announcement floods.** `› does not announce while it is still within the deal interval`
  pins the pacing to `handIntervalMs` rather than the 250ms tick. Its first draft measured
  across the *first* deal attempt and failed for the right reason at the wrong moment, which is
  why it now waits out that attempt before taking its baseline.
- **A refusal is permanent, server side.** `› keeps a refused agent subscribed so it can try
  again` fills a one-seat table, has a second agent refused, frees the seat, and asserts the
  refused agent still receives `table_state`.
- **A refusal is permanent, client side.** `client.test.ts › an agent that was turned away ›
  takes the seat once one frees up` drives the same scenario through the real SDK against a
  real server and a real ledger, and asserts the refused agent takes the seat *on its own*.
  With the `joinPending` fix reverted this fails by timeout after 15 seconds rather than by
  assertion — the agent simply never acts, which is exactly how it presented in production.

- **The retry floods.** `client.test.ts › backs off instead of retrying on every table update`
  is the regression test for the outage the first three tests' fix *caused*. It stands a
  one-seat table on a 10ms tick so the engine re-announces continuously, gets an agent refused,
  and asserts it answers at most two of the roughly sixty announcements that follow. Reverting
  the backoff while keeping the retry — the exact code that ran in production — fails it. The
  lesson is in the shape of the gap: three tests all proved an agent *could* recover and not one
  said anything about how often it tried, so the suite stayed green through the thing that took
  the site down.

- **The reconnect fans out.** `client.test.ts › reconnecting › makes one attempt per failure,
  not a fan-out` points an agent at a port that was just released, so every connection is
  refused instantly, and counts reconnect announcements over 2.7 s. Backoff of 500 ms, 1 s,
  2 s gives three; the fan-out version gave two per failure and was past eight. Restoring the
  double report fails it.
- **A redundant join moves money.** `wired.test.ts › a join from an agent that is already
  seated › is refused before any money moves` seats an agent over a real socket, sends the
  same `join_table` again, and asserts the count of ledger transactions touching that agent's
  accounts is unchanged after the refusal. Without the short-circuit it rises by two.
- **A public read hangs.** `server.test.ts › answers 503 rather than hanging when the archive
  is slow` gives the server an archive whose `recent()` never resolves and expects a 503
  inside two seconds. With the deadline removed the test itself hangs — which is the
  production symptom, reproduced in the one place it is cheap.
- **A connection is left inside a transaction.** `session.test.ts › ends a session left idle
  inside a transaction, and the pool recovers` opens a one-connection pool with a 200 ms
  idle-in-transaction limit, sleeps 700 ms inside `begin`, and asserts both that the
  transaction fails *and* that the next query succeeds — the second half is the point, since
  it can only pass if the terminated connection was replaced. `› bounds a statement when
  asked to, and leaves it unbounded otherwise` pins that the statement timeout is opt-in,
  because the pool that runs migrations must be allowed to build an index.

- **The rebalancer measures the wrong balance.** `rebalance.test.ts › it measures what a bot
  can actually spend › tops up a bot whose chips are on the table and whose spendable balance
  cannot cover a seat` gives a bot 10 USDC with 8.5 of it seated and expects a top-up; by
  holdings it is above the floor and the old code left it alone. `› chooses the donor by what
  it can spend, not by what it holds` puts 19.5 of a whale's 20 on a table beside a bot with
  6 in hand, and expects the modest bot to pay and the whale to be untouched on both sides.
- **A winner's stack never comes back.** `client.test.ts › standing up › cashes the stack out
  and sits straight back down` calls `leaveTable()` on a seated agent against a real ledger
  and asserts the round trip: a `cash_out` posted, a second `buy_in` posted, seated again —
  with the server's own "you are no longer seated" state as the only prompt.

**The storm itself is a script, not a test.** `apps/engine/src/bench/storm.ts` (not a test
file, so the suite never runs it) runs twelve
agents reconnecting and re-joining 120 times a second for 25 seconds against a local server
and reports ledger transactions produced, API latency during, and pool state after. It needs
the machine to itself and twenty-five seconds; the numbers it produced are in `features.md`.
It is the check that should have run before the second deploy rather than after the third.

No test covers the whole outage end to end, and none can: it needs a table to run itself down
to one player over days of real play. The four above cover each mechanism that made the outage
irreversible, which is the part that turns a quiet table into a dead one.

### F31 — The room, relit

**Still no unit tests, for the F19 reason.** The revamp touched presentation only: the pages
call the same API, fold the same messages, and derive the same view models. What changed is
markup and CSS, which is the layer a component test can only restate.

**Verified by driving the real thing.** The full stack was run locally (`pnpm dev`: real
engine, real Postgres, real bots on two tables) and every page opened in a browser at desktop
width and at 390px:

| Checked | Result |
| --- | --- |
| Room | Title, live light, table switcher, the felt under the lamp during a hand, stats strip, ten finished hands |
| Replay | Pot headline, the felt, transport bar stepped with the keyboard to the end, sparks and burst at settlement, log and result side by side |
| Leaderboard | Podium with the walking ring on first place, 22 further rows with net bars |
| Agent | Profile hero, four stat tiles counting up, 30 recent hands |
| Verify, empty | Search pill, the note, the three checks |
| Verify, with a proof | Labelled code panel with the command, copy buttons, labelled panel with the coloured JSON |
| Phone | No horizontal overflow on any page (`scrollWidth === innerWidth`); seats collapse to a grid as before |
| Console | No errors on any page |
| Production build | `tsc --noEmit && vite build` clean |
| Hole cards on the public feed | Still face down for every live player |

**Four defects found by looking, none of which a test would have named:**

- *Words ran together in every headline.* An inline-block swallows its trailing space. Seen
  in the first screenshot, invisible in the DOM.
- *The gradient line of the hero was blank.* `background: inherit` under `background-clip:
  text` clips to a transparent fill once a wrapper span sits between the gradient and the
  word. Seen only because the first fix introduced the wrapper.
- *The action log clipped its verbs on a phone.* A `1fr` grid track will not shrink below its
  content's min-content width. Seen at 390px, not at 1280.
- *The room looked like a landing page.* Not a defect a browser reports, but the one the
  reader reported: a hero headline and a window with traffic-light dots around the felt made a
  poker room read as a product. Removed, and the table now sits under a lamp on the page. A
  second pass of every row in the table above followed the change.

**One thing worth knowing about the harness.** The browser pane pauses CSS animations while it
is hidden, so a screenshot taken between actions can catch a page frozen mid-entrance and look
like a broken layout. Two such captures were chased before the cause was clear; a settled
capture is taken with animation and transition durations zeroed by an injected style, which is
a debugging aid and never part of the page.

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
| I12 | Chips are conserved after every individual action, not just per hand | `betting.test.ts › immutability and conservation` | F4 |
| I13 | An all-in short of a full raise never reopens the betting | `betting.test.ts › all-in short of a full raise` | F4 |
| I14 | The big blind always gets its preflop option to raise | `betting.test.ts › legal actions` | F4 |
| I15 | An illegal action always throws — never coerced, never ignored | `betting.test.ts › illegal actions throw` | F4 |
| I16 | One card is burned before the flop, turn and river | `betting.test.ts › street progression` | F4 |
| I17 | `applyAction` never mutates the state it was given | `betting.test.ts › immutability and conservation` | F4 |
| I18 | Chips out equals chips in across a whole hand, settlement included *(also in prod)* | `showdown.test.ts › random hands`, `assertChipsConserved()` | F5 |
| I19 | Derived pots always total exactly the chips committed | `showdown.test.ts › random hands` | F5 |
| I20 | No pot can ever have zero eligible winners | `betting.ts › canFold`, `showdown.test.ts › throws rather than silently dropping` | F5 |
| I21 | Pots depend only on final contributions, never on betting order | `showdown.test.ts › is independent of the order bets arrived in` | F5 |
| I22 | Every sequence of legal actions terminates | `showdown.test.ts › always terminates` | F5 |
| I23 | Odd chips in a split pot go left of the button | `showdown.test.ts › gives an odd chip to the first seat left of the button` | F5 |
| I24 | `commit` is `SHA256` of the raw 32 seed bytes, and binds the server to one seed | `shuffle.test.ts › commitment` | F6 |
| I25 | The deck depends on every input — server seed, each client seed, its seat, and the hand id | `shuffle.test.ts › final seed derivation` | F6 |
| I26 | The deck never depends on the order client seeds were received | `shuffle.test.ts › does not depend on the order client seeds arrived in` | F6 |
| I27 | Every shuffle is a permutation of exactly 52 distinct cards | `shuffle.test.ts › deck production` | F6 |
| I28 | Index selection is free of modulo bias — all 52! permutations equally likely | `shuffle.test.ts › rejection sampling`, `› statistical uniformity` | F6 |
| I29 | A server seed is never reused across hands | `shuffle.test.ts › never repeats a server seed` | F6 |
| I30 | The independent verifier and the engine deal identical cards | `verify.test.ts › the verifier agrees with the engine` | F7 |
| I31 | A revealed seed that does not match its commitment always fails verification | `verify.test.ts › commitment verification` | F7 |
| I32 | Any tampered hole card or board is detected and named | `verify.test.ts › card verification` | F7 |
| I33 | Malformed proof input returns a failed result, never an exception | `verify.test.ts › rejects a malformed server seed without throwing` | F7 |
| I34 | No inbound frame can make the parser throw | `messages.test.ts › never throws, whatever it is handed` | F8 |
| I35 | Negative, fractional and NaN chip amounts never reach the engine | `messages.test.ts › chip amounts cannot be abused` | F8 |
| I36 | Every action must echo the current `requestId` | `messages.test.ts › every action carries a requestId` | F8 |
| I37 | Card lists on the wire are canonical — no stray whitespace | `messages.test.ts › card notation on the wire` | F8 |
| I38 | The shuffle commitment is published before any client seed is collected | `table.test.ts › publishes the commitment before any seed is collected` | F9 |
| I39 | No broadcast ever carries a live player's hole cards | `table.test.ts › hole cards are never leaked` | F9 |
| I40 | A stale or out-of-turn action is refused, never applied | `table.test.ts › the betting loop` | F9 |
| I41 | An illegal action is reported, never silently folded | `table.test.ts › reports an illegal action without folding the agent` | F9 |
| I42 | A wedged agent cannot stall the table *(also in prod)* | `table.test.ts › action timeouts`, `› supplies a seed for any agent that misses the deadline` | F9 |
| I43 | Chips are conserved across consecutive hands *(also in prod)* | `table.test.ts › conserves chips across fifty consecutive hands` | F9 |
| I44 | A hand played by the engine verifies from its published messages alone | `table.test.ts › a hand played through the runtime is independently verifiable` | F9 |
| I45 | Every issued API key authenticates | `server.test.ts › authenticates every key it issues, 500 times over` | F10 |
| I46 | The secret half of a key is never stored | `server.test.ts › never stores the secret half` | F10 |
| I47 | Key comparison is constant-time | `auth.ts › digestsMatch` via `timingSafeEqual` | F10 |
| I48 | An unauthenticated connection can watch but never act | `server.test.ts › lets a spectator watch`, `› rejects a connection with no API key` | F10 |
| I49 | A malformed frame never crashes or closes the connection | `server.test.ts › answers a malformed frame without dropping the connection` | F10 |
| I50 | A rate-limited agent is throttled, never disconnected | `server.test.ts › rate limits a flood without closing the socket` | F10 |
| I51 | `/healthz` never depends on table state | `server.test.ts › serves a health check that does not depend on the table` | F10 |
| I52 | Chips bought onto a table always equal chips on it plus chips carried off *(also in prod)* | `TableRuntime.assertTableChipsConserved()`, `session.test.ts` | F11 |
| I53 | Every hand in a live session verifies from the public feed alone | `session.test.ts › plays hands that all verify` | F11 |
| I54 | An agent written against the docs never receives a protocol error | `session.test.ts › botErrors is empty` | F11 |
| I55 | A strategy never proposes an amount outside the legal range | `session.test.ts › strategies produce a legal-looking decision` | F11 |
| I56 | Every ledger transaction's entries sum to exactly zero *(also in prod)* | `ledger.test.ts › a transaction must balance`, `Ledger.assertBalanced()` | F12 |
| I57 | A deposit signature can never be credited twice, even concurrently | `ledger.test.ts › deposits are idempotent` | F12 |
| I58 | An agent account can never go negative *(also in prod)* | `ledger.test.ts › accounts cannot go negative`, `findNegativeAgentAccounts()` | F12 |
| I59 | Concurrent transfers never deadlock | `ledger.test.ts › concurrent transfers do not deadlock` | F12 |
| I60 | Every ledger amount is a safe integer, enforced by the database | `ledger.test.ts › bounds amounts to what JavaScript can represent` | F12 |
| I61 | Declared constraints exist on the live database | `ledger.test.ts › the constraints actually exist` | F12 |
| I62 | Clawroll never runs against a cluster other than devnet, verified by genesis hash | `cluster.test.ts › the devnet guard` | F13 |
| I63 | An unverifiable cluster stops startup — unknown is not permission | `cluster.test.ts › refuses to start when the cluster cannot be verified` | F13 |
| I64 | A master mnemonic failing its BIP-39 checksum is never used | `derivation.test.ts › master seed` | F13 |
| I65 | Two agents can never share a deposit address | `derivation.test.ts › gives every index a distinct address`, `agents.derivation_index UNIQUE` | F13 |
| I66 | USDC conversion rounds rather than truncating, and refuses unrepresentable amounts | `cluster.test.ts › USDC amounts` | F13 |
| I67 | An on-chain deposit is credited exactly once, however many times it is seen | `scanner.test.ts › replays never double-credit` | F14 |
| I68 | A crash between crediting and recording never loses a deposit | `scanner.test.ts › recovers when a crash lands between crediting and recording` | F14 |
| I69 | Losing the scan cursor costs time, never money | `scanner.test.ts › survives losing the cursor entirely` | F14 |
| I70 | Only `finalized` transactions are ever credited | `gateway.ts › RpcGateway` commitment level | F14 |
| I71 | Money on chain is never left uncredited *(also in prod)* | `scanner.test.ts › observability`, `findUncreditedDeposits()` | F14 |
| I72 | An agent is debited before any withdrawal touches the chain | `withdrawals.test.ts › debits before anything touches the chain` | F15 |
| I73 | A withdrawal signature is recorded before the transaction is broadcast | `withdrawals.test.ts › a send whose fate is unknown` | F15 |
| I74 | A transaction is never rebuilt while its blockhash could still land | `withdrawals.test.ts › rebuilds only once the blockhash has provably expired` | F15 |
| I75 | A transaction that lands despite a send error is confirmed, never re-sent | `withdrawals.test.ts › confirms a transaction that landed even though the send reported an error` | F15 |
| I76 | A withdrawal that fails on chain is refunded exactly once | `withdrawals.test.ts › a transaction that lands and fails` | F15 |
| I77 | Chips at a table are backed by an `in_play` ledger balance at all times | `bankroll.test.ts › chips at a table are already real money` | F16 |
| I78 | A hand's deltas net to zero, so play never changes the ledger's total | `bankroll.test.ts › a real hand settles through to Postgres` | F16 |
| I79 | A settled hand reaches the ledger exactly once, however often drained | `bankroll.test.ts › the settlement outbox` | F16 |
| I80 | A settlement that cannot post is retried, never dropped | `bankroll.test.ts › keeps a settlement retryable when applying it fails` | F16 |
| I81 | Chips stranded by a crash are returned at startup | `bankroll.test.ts › reconciling chips stranded by a crash` | F16 |
| I82 | A buy-in is taken from the ledger before a seat exists | `wired.test.ts › buying in over a socket moves real money` | F17 |
| I83 | A failed seating never leaves money reserved | `wired.test.ts › hands the reservation back when seating fails` | F17 |
| I84 | `in_play` always equals the stack the table is holding | `wired.test.ts › leaves in_play matching the stacks` | F17 |
| I85 | Hand ids are globally unique across restarts and instances | `wired.test.ts › hand ids are globally unique` | F17 |
| I86 | A drained ledger event is retried, never dropped | `server.ts › drainToLedger` `undrained` buffer | F17 |
| I87 | A published hand is written once and can never be edited | `archive.test.ts › is written once and never updated` | F18 |
| I88 | The archive records what was shown publicly, never what the server knew | `archive.test.ts › keeps hole cards null for seats that never showed` | F18 |
| I89 | A proof served over HTTP verifies against `clawroll-verify` | `archive.test.ts › verifies from the served proof` | F18 |
| I90 | The public read API needs no credential | `archive.test.ts › the read API` | F18 |
| I91 | The leaderboard is derived from published hands, not the ledger | `archive.ts › leaderboard()` | F18 |
| I92 | The spectator UI can never display a live player's hole cards | `/spectate` stream contents, `table.test.ts › hole cards are never leaked` | F19 |
| I93 | The verification page never renders its own pass/fail verdict | `Verify.tsx` — by construction | F19 |
| I94 | The command shown to readers actually runs | Verified by piping a served proof into the CLI | F19 |
| I95 | A withdrawal's signature is computable before it is broadcast | `solana-gateway.test.ts › builds a signed transfer whose signature exists before it is sent` | F20 |
| I96 | Base58 encoding matches the canonical implementation exactly | `solana-gateway.test.ts › base58 encoding` | F20 |
| I97 | An unknown signature reads as `null`, never as an error | `solana-gateway.test.ts › against live devnet` | F20 |
| I98 | Only `finalized` counts as landed | `solana-gateway.ts › getSignatureOutcome` | F20 |
| I99 | The container shuts down gracefully on SIGTERM | `docker stop` → exit 0, verified | F21 |
| I100 | Services never run more than one task | `minHealthyPercent: 0`, `desiredCount: 1`, verified in the template | F22 |
| I101 | The master seed secret is created with no value | Template inspection — `hasValue=false` | F22 |
| I102 | The database is encrypted, deletion-protected and not publicly accessible | Template inspection | F22 |
| I103 | API keys survive a restart | `agent-directory.test.ts › survives a restart` | F23 |
| I104 | A cold directory never authenticates — it fails closed | `agent-directory.test.ts › never authenticates an agent it has not loaded` | F23 |
| I105 | A bot written from the quickstart plays hands unmodified | `client.test.ts › a bot written the documented way` | F23 |
| I106 | An author's mistake produces a warning, never an illegal action on the wire | `client.test.ts › the SDK protects the author` | F23 |
| I107 | Two agents can never share a derivation index | `agent_derivation_index_seq` | F23 |
| I108 | A rake never exceeds its configured cap or its percentage of the pot | `showdown.test.ts › rake › takes the configured percentage`, `› never exceeds the cap` | F24 |
| I109 | Chips stay conserved when a rake is taken — the rake leaves the table, it does not vanish *(also in prod)* | `showdown.test.ts › conserves chips once the rake is counted`, `assertChipsConserved()` | F24 |
| I110 | A hand that ends before the flop is never raked | `showdown.test.ts › takes nothing when the hand ended before a flop` | F24 |
| I111 | The rake is drained from the main pot before any side pot | `showdown.test.ts › drains the main pot before any side pot` | F24 |
| I112 | A table with no rake policy takes exactly nothing | `showdown.test.ts › random hands` (5,000-hand fuzz) | F24 |
| I113 | An agent's hands are found regardless of how many hands the room has dealt since | `archive.test.ts › finds an agent whose hands have scrolled past the recent window` | F25 |
| I114 | A profile and the leaderboard always agree on hands played and net | `archive.test.ts › agrees with the leaderboard on hands played and net` | F25 |
| I115 | An unknown agent id is absent, never an agent with no hands | `archive.test.ts › returns null for an id nobody has ever used` | F25 |
| I116 | A table that cannot deal keeps announcing itself, so an unseated agent is never stranded | `server.test.ts › keeps announcing itself so a lone agent is not stranded` | F30 |
| I117 | A quiet table announces on the deal interval, never on the tick interval | `server.test.ts › does not announce while it is still within the deal interval` | F30 |
| I118 | A refused agent stays subscribed to the table it asked for | `server.test.ts › keeps a refused agent subscribed so it can try again` | F30 |
| I119 | A refused agent takes a seat that later frees up, unprompted | `client.test.ts › takes the seat once one frees up` | F30 |
| I120 | A refused agent bounds its retry rate, and resets that bound once seated | `client.test.ts › backs off instead of retrying on every table update` | F30 |
| I121 | A failed reconnect schedules exactly one further attempt, and a stale socket's close schedules none | `client.test.ts › makes one attempt per failure, not a fan-out` | F30 |
| I122 | A join from an already-seated agent produces no ledger transaction | `wired.test.ts › is refused before any money moves` | F30 |
| I123 | A public read answers within `httpQueryTimeoutMs`, with 503 if the archive has not | `server.test.ts › answers 503 rather than hanging when the archive is slow` | F30 |
| I124 | A session idle inside a transaction is ended by Postgres and its pool slot replaced | `session.test.ts › ends a session left idle inside a transaction, and the pool recovers` | F30 |
| I125 | The statement timeout applies only where asked for; the migration pool is never bounded | `session.test.ts › bounds a statement when asked to, and leaves it unbounded otherwise` | F30 |
| I126 | A house bot whose spendable balance is below the floor is topped up, whatever it holds on a table | `rebalance.test.ts › tops up a bot whose chips are on the table and whose spendable balance cannot cover a seat` | F30 |
| I127 | A top-up is funded by spendable balance only; chips on a table are never moved | `rebalance.test.ts › chooses the donor by what it can spend, not by what it holds` | F30 |
| I128 | Standing up posts a cash-out for the stack and the agent re-seats on its own | `client.test.ts › cashes the stack out and sits straight back down` | F30 |
| I129 | A page reveals its content without the animation: `Reveal` shows immediately where `IntersectionObserver` is absent, and never re-hides | `Reveal.tsx` — by construction | F31 |
| I130 | Every animation on the site is neutralised under `prefers-reduced-motion` without changing layout | `styles.css` — the single reduced-motion block | F31 |

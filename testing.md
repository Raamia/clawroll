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

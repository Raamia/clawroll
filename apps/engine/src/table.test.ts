import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionRequestMessage, ServerMessage } from '@clawroll/protocol';
import { verifyHand } from '@clawroll/shuffle';
import { type TableConfig, type TableIO, TableRuntime } from './table.js';

const CONFIG: TableConfig = {
  tableId: 't1',
  smallBlind: 50,
  bigBlind: 100,
  maxSeats: 6,
  minBuyIn: 1_000,
  maxBuyIn: 20_000,
  actionTimeoutMs: 5_000,
  seedTimeoutMs: 2_000,
};

class RecordingIO implements TableIO {
  readonly sent: { agentId: string; message: ServerMessage }[] = [];
  readonly broadcasts: ServerMessage[] = [];

  send(agentId: string, message: ServerMessage): void {
    this.sent.push({ agentId, message });
  }
  broadcast(message: ServerMessage): void {
    this.broadcasts.push(message);
  }

  to(agentId: string): ServerMessage[] {
    return this.sent.filter((s) => s.agentId === agentId).map((s) => s.message);
  }
  privateOf<T extends ServerMessage['type']>(agentId: string, type: T) {
    return this.to(agentId).filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
  publicOf<T extends ServerMessage['type']>(type: T) {
    return this.broadcasts.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
  clear(): void {
    this.sent.length = 0;
    this.broadcasts.length = 0;
  }
}

class Harness {
  readonly io = new RecordingIO();
  readonly table: TableRuntime;
  clock = 1_000_000;
  private ids = 0;

  constructor(config: Partial<TableConfig> = {}) {
    this.table = new TableRuntime(
      { ...CONFIG, ...config },
      {
        io: this.io,
        now: () => this.clock,
        nextId: (prefix) => `${prefix}-${++this.ids}`,
      },
    );
  }

  seatBots(count: number, stack = 10_000): string[] {
    return Array.from({ length: count }, (_, i) => {
      const agentId = `bot${i}`;
      const result = this.table.seat(agentId, `Bot ${i}`, stack);
      if (!result.ok) throw new Error(`could not seat ${agentId}: ${result.message}`);
      return agentId;
    });
  }

  /** Answer every outstanding seed request. */
  submitAllSeeds(agentIds: readonly string[], handId: string): void {
    for (const [i, agentId] of agentIds.entries()) {
      this.table.submitSeed(agentId, handId, String(i + 1).repeat(64).slice(0, 64));
    }
  }

  pendingRequest(agentId: string): ActionRequestMessage | undefined {
    const requests = this.io.privateOf(agentId, 'action_request');
    return requests[requests.length - 1];
  }

  /** Whoever is to act, respond with the first legal option in `preference`. */
  respond(preference: readonly ('check' | 'call' | 'fold')[] = ['check', 'call']): boolean {
    for (const { agentId, message } of [...this.io.sent].reverse()) {
      if (message.type !== 'action_request') continue;
      for (const choice of preference) {
        const legal = message.legal;
        const allowed =
          (choice === 'check' && legal.canCheck) ||
          (choice === 'call' && legal.canCall) ||
          (choice === 'fold' && legal.canFold);
        if (!allowed) continue;
        this.table.submitAction(agentId, {
          handId: message.handId,
          requestId: message.requestId,
          action: choice,
        });
        return true;
      }
      return false;
    }
    return false;
  }

  /** Play a hand from deal to settlement with everyone checking or calling. */
  playHand(agentIds: readonly string[]): void {
    this.table.startHand();
    this.submitAllSeeds(agentIds, this.table.currentHandId!);
    let guard = 0;
    while (this.table.currentPhase === 'betting') {
      if (!this.respond()) break;
      if (++guard > 500) throw new Error('hand did not terminate');
    }
  }
}

describe('seating', () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });

  it('seats an agent and reports the seat', () => {
    const result = h.table.seat('bot0', 'Bot 0', 10_000);
    expect(result).toEqual({ ok: true, seat: 0 });
    expect(h.table.stackOf('bot0')).toBe(10_000);
  });

  it('honours a preferred seat when free', () => {
    expect(h.table.seat('bot0', 'Bot 0', 10_000, 3)).toEqual({ ok: true, seat: 3 });
  });

  it('falls back to any free seat when the preferred one is taken', () => {
    h.table.seat('bot0', 'Bot 0', 10_000, 2);
    expect(h.table.seat('bot1', 'Bot 1', 10_000, 2)).toEqual({ ok: true, seat: 0 });
  });

  it.each([
    ['below the minimum', 10],
    ['above the maximum', 999_999],
    ['fractional', 1_500.5],
  ])('rejects a buy-in %s', (_label, buyIn) => {
    const result = h.table.seat('bot0', 'Bot 0', buyIn);
    expect(result.ok).toBe(false);
  });

  it('rejects seating the same agent twice', () => {
    h.table.seat('bot0', 'Bot 0', 10_000);
    expect(h.table.seat('bot0', 'Bot 0', 10_000).ok).toBe(false);
  });

  it('reports a full table', () => {
    h.seatBots(6);
    const result = h.table.seat('extra', 'Extra', 10_000);
    expect(result).toMatchObject({ ok: false, code: 'table_full' });
  });

  it('defers a mid-hand leave until the hand ends', () => {
    // Chips already committed to a live pot cannot walk away from it.
    const bots = h.seatBots(3);
    h.table.startHand();
    h.submitAllSeeds(bots, h.table.currentHandId!);
    h.table.unseat('bot0');
    expect(h.table.seatOf('bot0')).not.toBeNull();

    let guard = 0;
    while (h.table.currentPhase === 'betting' && h.respond(['fold', 'check', 'call'])) {
      if (++guard > 200) break;
    }
    expect(h.table.seatOf('bot0')).toBeNull();
  });
});

describe('every seat release is uniquely identifiable', () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });

  it('gives repeated sit-and-leave cycles distinct release ids', () => {
    // This is the shape that lost 20 USDC on the deployed room, and it needs no hand to be
    // dealt at all — which is precisely why it went unnoticed.
    //
    // The release ref used to be built at the call site as
    // `release:<table>:<agent>:<handCount>`. handCount is 0 until the first hand and constant
    // between hands, so an agent sitting and leaving twice produced the identical ref twice.
    // The ledger treats a repeated external_ref as an already-posted transaction — correctly —
    // so the second release was silently swallowed while the seat was untracked anyway. The
    // chips stayed in_play with nothing left pointing at them.
    //
    // Nothing throws in that sequence. Only the balance is wrong, and only later.
    for (let i = 0; i < 3; i++) {
      h.table.seat('bot0', 'Bot 0', 10_000);
      h.table.unseat('bot0');
    }

    const releases = h.table
      .drainLedgerEvents()
      .filter((e): e is Extract<typeof e, { type: 'seat_released' }> => e.type === 'seat_released');

    expect(releases).toHaveLength(3);
    expect(new Set(releases.map((r) => r.releaseId)).size).toBe(3);
    // And each carries the chips it is returning, so a duplicate id would double-credit
    // rather than merely lose one.
    for (const release of releases) expect(release.stack).toBe(10_000);
  });

  it('keeps ids distinct across different agents leaving together', () => {
    h.table.seat('bot0', 'Bot 0', 10_000);
    h.table.seat('bot1', 'Bot 1', 10_000);
    h.table.unseat('bot0');
    h.table.unseat('bot1');

    const ids = h.table
      .drainLedgerEvents()
      .filter((e) => e.type === 'seat_released')
      .map((e) => (e as { releaseId: string }).releaseId);

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('hand start and the fairness ordering', () => {
  it('publishes the commitment before any seed is collected', () => {
    // This ordering IS the fairness guarantee. If the server could see client entropy
    // first, it could grind a seed producing a deck it liked.
    const h = new Harness();
    const bots = h.seatBots(3);
    h.io.clear();
    h.table.startHand();

    const started = h.io.publicOf('hand_start');
    expect(started).toHaveLength(1);
    expect(started[0]!.commit).toMatch(/^[0-9a-f]{64}$/);
    expect(h.table.currentPhase).toBe('awaiting_seeds');

    // No cards exist yet — nothing has been dealt.
    expect(h.io.publicOf('street')).toHaveLength(0);
    for (const bot of bots) expect(h.io.privateOf(bot, 'your_cards')).toHaveLength(0);
  });

  it('deals once every seated agent has contributed entropy', () => {
    const h = new Harness();
    const bots = h.seatBots(3);
    h.table.startHand();
    expect(h.table.currentPhase).toBe('awaiting_seeds');
    h.submitAllSeeds(bots, h.table.currentHandId!);
    expect(h.table.currentPhase).toBe('betting');
  });

  it('supplies a seed for any agent that misses the deadline', () => {
    // A wedged bot must not stall the table.
    const h = new Harness();
    const bots = h.seatBots(3);
    h.table.startHand();
    h.table.submitSeed(bots[0]!, h.table.currentHandId!, 'a'.repeat(64));

    h.clock += CONFIG.seedTimeoutMs;
    h.table.tick();

    expect(h.table.currentPhase).toBe('betting');
    expect(h.io.publicOf('hand_end')).toHaveLength(0);
  });

  it('refuses a seed for a hand that is not collecting', () => {
    const h = new Harness();
    h.seatBots(2);
    h.table.submitSeed('bot0', 'nope', 'a'.repeat(64));
    expect(h.io.privateOf('bot0', 'error')[0]).toMatchObject({ code: 'stale_request' });
  });

  it('will not start a hand with fewer than two playable seats', () => {
    const h = new Harness();
    h.seatBots(1);
    expect(h.table.startHand()).toBe(false);
  });
});

describe('hole cards are never leaked', () => {
  // A spectator feed carrying live hole cards would let an operator watch the public
  // stream and feed their own bot — the single change that would quietly invalidate
  // every result on the site.
  it('sends your_cards privately and to nobody else', () => {
    const h = new Harness();
    const bots = h.seatBots(3);
    h.table.startHand();
    h.submitAllSeeds(bots, h.table.currentHandId!);

    for (const bot of bots) {
      const mine = h.io.privateOf(bot, 'your_cards');
      expect(mine).toHaveLength(1);
      expect(mine[0]!.cards).toMatch(/^[2-9TJQKA][cdhs] [2-9TJQKA][cdhs]$/);
    }
    // Three private deliveries, one per bot, and nothing else.
    expect(h.io.sent.filter((s) => s.message.type === 'your_cards')).toHaveLength(3);
  });

  it('never puts hole cards in any broadcast before showdown', () => {
    const h = new Harness();
    const bots = h.seatBots(3);
    h.table.startHand();
    h.submitAllSeeds(bots, h.table.currentHandId!);

    // Walk every public message emitted up to (but excluding) showdown.
    let guard = 0;
    while (h.table.currentPhase === 'betting') {
      const beforeShowdown = h.io.broadcasts.filter((m) => m.type !== 'showdown');
      for (const message of beforeShowdown) {
        if (message.type === 'hand_start' || message.type === 'table_state') {
          for (const seat of message.seats) expect(seat.holeCards).toBeNull();
        }
      }
      if (!h.respond()) break;
      if (++guard > 500) break;
    }
  });

  it('reveals hole cards only in the showdown message', () => {
    const h = new Harness();
    const bots = h.seatBots(2);
    h.playHand(bots);

    const showdowns = h.io.publicOf('showdown');
    if (showdowns.length > 0) {
      for (const hand of showdowns[0]!.hands) {
        expect(hand.cards).toMatch(/^[2-9TJQKA][cdhs] [2-9TJQKA][cdhs]$/);
        expect(hand.description).toBeTruthy();
      }
    }
  });
});

describe('the betting loop', () => {
  it('requests an action from the seat to act', () => {
    const h = new Harness();
    const bots = h.seatBots(3);
    h.table.startHand();
    h.submitAllSeeds(bots, h.table.currentHandId!);

    const requests = h.io.sent.filter((s) => s.message.type === 'action_request');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.message).toMatchObject({ type: 'action_request', street: 'preflop' });
  });

  it('broadcasts each action that is taken', () => {
    const h = new Harness();
    const bots = h.seatBots(3);
    h.table.startHand();
    h.submitAllSeeds(bots, h.table.currentHandId!);
    h.respond(['call']);

    const taken = h.io.publicOf('action_taken');
    expect(taken).toHaveLength(1);
    expect(taken[0]).toMatchObject({ action: 'call', timedOut: false });
  });

  it('rejects a stale requestId', () => {
    // The exact bug the echo exists to prevent: a late reply to a previous decision.
    const h = new Harness();
    const bots = h.seatBots(3);
    h.table.startHand();
    h.submitAllSeeds(bots, h.table.currentHandId!);

    const request = h.io.sent.find((s) => s.message.type === 'action_request')!;
    const stale = request.message as ActionRequestMessage;
    h.table.submitAction(request.agentId, {
      handId: stale.handId,
      requestId: 'req-does-not-exist',
      action: 'call',
    });

    expect(h.io.privateOf(request.agentId, 'error')[0]).toMatchObject({ code: 'stale_request' });
    expect(h.io.publicOf('action_taken')).toHaveLength(0);
  });

  it('rejects an action from a seat that is not to act', () => {
    const h = new Harness();
    const bots = h.seatBots(3);
    h.table.startHand();
    h.submitAllSeeds(bots, h.table.currentHandId!);

    const request = h.io.sent.find((s) => s.message.type === 'action_request')!;
    const other = bots.find((b) => b !== request.agentId)!;
    const message = request.message as ActionRequestMessage;
    h.table.submitAction(other, {
      handId: message.handId,
      requestId: message.requestId,
      action: 'call',
    });
    expect(h.io.privateOf(other, 'error')[0]).toMatchObject({ code: 'illegal_action' });
  });

  it('reports an illegal action without folding the agent', () => {
    // A rejected action is a bug in the agent, not a decision. Folding it would be a
    // silent and very expensive reinterpretation.
    const h = new Harness();
    const bots = h.seatBots(3);
    h.table.startHand();
    h.submitAllSeeds(bots, h.table.currentHandId!);

    const request = h.io.sent.find((s) => s.message.type === 'action_request')!;
    const message = request.message as ActionRequestMessage;
    h.table.submitAction(request.agentId, {
      handId: message.handId,
      requestId: message.requestId,
      action: 'raise',
      amount: 1,
    });

    expect(h.io.privateOf(request.agentId, 'error')[0]).toMatchObject({ code: 'illegal_action' });
    expect(h.io.publicOf('action_taken')).toHaveLength(0);
  });
});

describe('action timeouts', () => {
  it('checks for a seat that can check', () => {
    const h = new Harness();
    const bots = h.seatBots(3);
    h.table.startHand();
    h.submitAllSeeds(bots, h.table.currentHandId!);
    h.respond(['call']);
    h.respond(['call']);
    // Big blind is now to act facing no raise, so a timeout should check.
    h.clock += CONFIG.actionTimeoutMs;
    h.table.tick();

    const taken = h.io.publicOf('action_taken');
    expect(taken[taken.length - 1]).toMatchObject({ action: 'check', timedOut: true });
  });

  it('folds a seat that cannot check', () => {
    const h = new Harness();
    const bots = h.seatBots(3);
    h.table.startHand();
    h.submitAllSeeds(bots, h.table.currentHandId!);
    h.clock += CONFIG.actionTimeoutMs;
    h.table.tick();

    const taken = h.io.publicOf('action_taken');
    expect(taken[0]).toMatchObject({ action: 'fold', timedOut: true });
  });

  it('does nothing before the deadline', () => {
    const h = new Harness();
    const bots = h.seatBots(3);
    h.table.startHand();
    h.submitAllSeeds(bots, h.table.currentHandId!);
    h.clock += CONFIG.actionTimeoutMs - 1;
    h.table.tick();
    expect(h.io.publicOf('action_taken')).toHaveLength(0);
  });
});

describe('settlement', () => {
  it('ends the hand and reveals the server seed', () => {
    const h = new Harness();
    const bots = h.seatBots(3);
    h.playHand(bots);

    const ended = h.io.publicOf('hand_end');
    expect(ended).toHaveLength(1);
    expect(ended[0]!.serverSeed).toMatch(/^[0-9a-f]{64}$/);
    expect(ended[0]!.clientSeeds).toHaveLength(3);
    expect(h.table.currentPhase).toBe('idle');
  });

  it('pays the pot out and returns to idle', () => {
    const h = new Harness();
    const bots = h.seatBots(3);
    h.playHand(bots);
    expect(h.table.handCount).toBe(1);
    expect(h.table.totalChips()).toBe(30_000);
  });

  it('conserves chips across fifty consecutive hands', () => {
    // The headline runtime invariant. `settle()` also calls assertChipsConserved on
    // every hand, so a leak throws rather than merely failing this assertion.
    const h = new Harness();
    const bots = h.seatBots(4, 10_000);
    const total = h.table.totalChips();

    for (let i = 0; i < 50; i++) {
      const stillSeated = bots.filter((b) => h.table.seatOf(b) !== null);
      if (stillSeated.length < 2) break;
      h.playHand(stillSeated);
      expect(h.table.totalChips(), `after hand ${i}`).toBe(total);
    }
    expect(h.table.handCount).toBeGreaterThan(10);
  });

  it('moves the button between hands', () => {
    const h = new Harness();
    const bots = h.seatBots(3);
    h.playHand(bots);
    const first = h.io.publicOf('hand_start')[0]!.buttonSeat;
    h.io.clear();
    h.playHand(bots);
    const second = h.io.publicOf('hand_start')[0]!.buttonSeat;
    expect(second).not.toBe(first);
  });
});

describe('a hand played through the runtime is independently verifiable', () => {
  // The end-to-end payoff of F6 and F7: take only what the engine published and hand
  // it to the standalone verifier. If this passes, the fairness claim is real rather
  // than architectural.
  it('verifies from the published messages alone', () => {
    const h = new Harness();
    const bots = h.seatBots(3);
    h.playHand(bots);

    const started = h.io.publicOf('hand_start')[0]!;
    const ended = h.io.publicOf('hand_end')[0]!;
    const seats = started.seats.filter((s) => s.status !== 'empty').map((s) => s.seat);

    const holeCards = bots.map((bot) => {
      const dealt = h.io.privateOf(bot, 'your_cards')[0]!;
      return { seat: dealt.seat, cards: dealt.cards };
    });

    const streets = h.io.publicOf('street');
    const board = streets.length > 0 ? streets[streets.length - 1]!.board : '';

    const result = verifyHand({
      handId: started.handId,
      commit: started.commit,
      serverSeed: ended.serverSeed,
      clientSeeds: ended.clientSeeds,
      seats,
      buttonSeat: started.buttonSeat,
      holeCards,
      ...(board !== '' ? { board } : {}),
    });

    expect(result.checks.filter((c) => !c.passed)).toEqual([]);
    expect(result.ok).toBe(true);

    // Guard against passing vacuously: `ok` is true for an empty check list too, so
    // assert the hole-card and board checks actually ran.
    const names = result.checks.map((c) => c.name);
    expect(names).toContain('commitment');
    expect(names).toContain('deck');
    for (const { seat } of holeCards) expect(names).toContain(`hole:seat${seat}`);
    if (board !== '') expect(names).toContain('board');
  });

  it('fails verification if the revealed seed is altered', () => {
    // Proves the test above is measuring something: change one byte of the published
    // seed and the same proof must be rejected.
    const h = new Harness();
    const bots = h.seatBots(2);
    h.playHand(bots);

    const started = h.io.publicOf('hand_start')[0]!;
    const ended = h.io.publicOf('hand_end')[0]!;
    const tampered = `${ended.serverSeed.slice(0, 63)}${ended.serverSeed.endsWith('0') ? '1' : '0'}`;

    const result = verifyHand({
      handId: started.handId,
      commit: started.commit,
      serverSeed: tampered,
      clientSeeds: ended.clientSeeds,
    });
    expect(result.ok).toBe(false);
  });
});

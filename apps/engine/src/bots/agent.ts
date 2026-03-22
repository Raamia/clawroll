/**
 * A reference agent, and the strategies it can play.
 *
 * This is the code an agent author reads first, so it is written to be *copied*: a bot is
 * a WebSocket, a `Strategy`, and about thirty lines of dispatch. Everything genuinely
 * hard — legal actions, minimum raises, side pots — arrives precomputed in
 * `action_request` and never has to be re-derived.
 *
 * It doubles as the end-to-end test client. The same class that demonstrates the protocol
 * is the one that proves the stack works, so a protocol change that breaks agent authors
 * breaks the build rather than being discovered by someone else.
 */

import WebSocket from 'ws';
import {
  type ActionRequestMessage,
  type ActionType,
  type ServerMessage,
  parseClientMessage,
} from '@clawroll/protocol';
import { evaluate, parseCards, rankOf, suitOf } from '@clawroll/poker';
import { randomClientSeed } from '@clawroll/shuffle';

export interface Decision {
  readonly action: ActionType;
  readonly amount?: number;
}

export interface BotContext {
  /** The bot's own cards, e.g. `"As Kd"`. Empty before the deal. */
  readonly holeCards: string;
  readonly board: string;
}

export interface Strategy {
  readonly name: string;
  decide(request: ActionRequestMessage, context: BotContext): Decision;
}

/** Always continues for free, never puts in more than it has to. */
export const callingStation: Strategy = {
  name: 'calling-station',
  decide({ legal }) {
    if (legal.canCheck) return { action: 'check' };
    if (legal.canCall) return { action: 'call' };
    return { action: 'fold' };
  },
};

/**
 * Crude but real hand strength: made-hand category once there is a board, and a simple
 * pair/high-card/suited heuristic preflop. Enough to make the bot fold trash and raise
 * strength, which is all a reference implementation needs to demonstrate.
 */
export function handStrength(holeCards: string, board: string): number {
  if (holeCards === '') return 0;
  const hole = parseCards(holeCards);
  const community = board === '' ? [] : parseCards(board);

  if (community.length >= 3) {
    // 0..8 category scaled to 0..1.
    return evaluate([...hole, ...community]).category / 8;
  }

  const [a, b] = hole;
  if (a === undefined || b === undefined) return 0;

  const [high, low] = [rankOf(a), rankOf(b)].sort((x, y) => y - x) as [number, number];
  const paired = high === low;
  const suited = suitOf(a) === suitOf(b);
  const connected = Math.abs(high - low) === 1;

  let score = high / 12 / 2;
  if (paired) score += 0.45;
  if (suited) score += 0.1;
  if (connected) score += 0.05;
  return Math.min(score, 1);
}

/** Folds weak holdings, calls medium ones, raises strong ones. */
export const tightAggressive: Strategy = {
  name: 'tight-aggressive',
  decide(request, context) {
    const strength = handStrength(context.holeCards, context.board);
    const { legal } = request;

    if (strength > 0.62 && (legal.canBet || legal.canRaise)) {
      const target = Math.min(
        legal.maxRaiseTo,
        Math.max(legal.minRaiseTo, Math.round(request.pot * 0.75) || legal.minRaiseTo),
      );
      return { action: legal.canBet ? 'bet' : 'raise', amount: target };
    }
    if (legal.canCheck) return { action: 'check' };
    if (strength > 0.35 && legal.canCall) return { action: 'call' };
    return legal.canFold ? { action: 'fold' } : { action: 'check' };
  },
};

/** Deterministic pseudo-random play, seeded per bot so sessions reproduce exactly. */
export function randomBot(seed: number): Strategy {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };

  return {
    name: `random-${seed}`,
    decide({ legal }) {
      const options: Decision[] = [];
      if (legal.canCheck) options.push({ action: 'check' });
      if (legal.canCall) options.push({ action: 'call' });
      if (legal.canFold) options.push({ action: 'fold' });
      if (legal.canBet || legal.canRaise) {
        const span = legal.maxRaiseTo - legal.minRaiseTo;
        options.push({
          action: legal.canBet ? 'bet' : 'raise',
          amount: legal.minRaiseTo + Math.floor(next() * (span + 1)),
        });
      }
      return options[Math.floor(next() * options.length)] ?? { action: 'fold' };
    },
  };
}

export interface BotOptions {
  readonly url: string;
  readonly apiKey: string;
  readonly tableId: string;
  readonly buyIn: number;
  readonly strategy: Strategy;
  /** Times the bot will re-buy after busting. Defaults to none. */
  readonly rebuys?: number;
}

/**
 * A complete Clawroll agent.
 *
 * The whole protocol obligation is four cases: answer `hand_start` with entropy, remember
 * `your_cards`, answer `action_request` echoing its `requestId`, and track `hand_end`.
 */
export class Bot {
  private socket: WebSocket | null = null;
  private agentId = '';
  private holeCards = '';
  private board = '';
  private seated = false;
  private joinPending = false;
  private rebuysLeft: number;

  readonly handsPlayed: string[] = [];
  readonly errors: string[] = [];

  constructor(private readonly options: BotOptions) {
    this.rebuysLeft = options.rebuys ?? 0;
  }

  async connect(): Promise<void> {
    const socket = new WebSocket(`${this.options.url}/agent?key=${this.options.apiKey}`);
    this.socket = socket;

    // Attach the message handler BEFORE awaiting `open`, not after.
    //
    // The server sends `welcome` the instant the connection is accepted. Awaiting `open`
    // first and subscribing afterwards leaves a window in which that frame arrives with
    // nobody listening — and since `welcome` is what triggers `join_table`, the bot then
    // sits connected and silent forever. It looks like a server bug and it is not; the
    // first version of this file had exactly that race and played zero hands.
    socket.on('message', (data) => this.onMessage(data.toString()));

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
  }

  private onMessage(raw: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      this.errors.push('unparseable frame from server');
      return;
    }

    switch (message.type) {
      case 'welcome':
        this.agentId = message.agentId;
        this.buyIn();
        break;

      case 'table_state': {
        // Busting removes the seat, so this is where a bot notices it is out and decides
        // whether to come back. Without it a table quietly dies: one big multi-way all-in
        // leaves a single survivor and no hand can be dealt to one player.
        const mine = message.seats.find((s) => s.playerId === this.agentId);
        this.seated = mine !== undefined;
        if (this.seated) this.joinPending = false;

        // `joinPending` matters more than it looks. The server sends `table_state`
        // immediately after `welcome`, so the snapshot describing a table this bot is not
        // yet in arrives while its own `join_table` is still in flight. Without the guard
        // the bot reads "not seated", buys in a second time, and gets an error — and any
        // buy-in accounting that trusted the client would be wrong by a whole stack.
        if (!this.seated && !this.joinPending && this.rebuysLeft > 0) {
          this.rebuysLeft--;
          this.buyIn();
        }
        break;
      }

      case 'hand_start': {
        this.holeCards = '';
        this.board = '';

        // `hand_start` is a broadcast, so it also reaches agents who are connected but
        // not in this hand — anyone who busted out or is sitting out. Contributing
        // entropy to a hand you are not in is meaningless, and by the time it arrives the
        // seated players have usually already been dealt, so it comes back as an error.
        // Check membership first.
        this.seated = message.seats.some((s) => s.playerId === this.agentId);
        if (!this.seated) break;

        // Entropy is chosen *after* seeing the server's commitment. That ordering is the
        // fairness guarantee — see packages/shuffle.
        this.send({ type: 'client_seed', handId: message.handId, seed: randomClientSeed() });
        break;
      }

      case 'your_cards':
        this.holeCards = message.cards;
        break;

      case 'street':
        this.board = message.board;
        break;

      case 'action_request': {
        const decision = this.options.strategy.decide(message, {
          holeCards: this.holeCards,
          board: message.board,
        });
        this.send({
          type: 'action',
          handId: message.handId,
          requestId: message.requestId,
          action: decision.action,
          ...(decision.amount !== undefined ? { amount: decision.amount } : {}),
        });
        break;
      }

      case 'hand_end':
        this.handsPlayed.push(message.handId);
        break;

      case 'error':
        this.errors.push(`${message.code}: ${message.message}`);
        break;

      default:
        break;
    }
  }

  private buyIn(): void {
    this.joinPending = true;
    this.send({ type: 'join_table', tableId: this.options.tableId, buyIn: this.options.buyIn });
  }

  private send(message: unknown): void {
    // Validating our own outbound frames means a bug in the reference agent surfaces here
    // rather than as a confusing `malformed_message` from the server.
    const encoded = JSON.stringify(message);
    const check = parseClientMessage(encoded);
    if (!check.ok) {
      this.errors.push(`refused to send an invalid frame: ${check.error}`);
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encoded);
  }

  get name(): string {
    return this.options.strategy.name;
  }

  close(): void {
    this.socket?.close();
  }
}

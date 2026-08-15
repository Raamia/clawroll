import { describe, expect, it } from 'vitest';
import {
  type ActionMessage,
  type ServerMessage,
  ActionRequestMessage,
  CardList,
  CardNotation,
  ClientMessage,
  PROTOCOL_VERSION,
  ServerMessage as ServerMessageSchema,
  encodeServerMessage,
  parseClientMessage,
} from './messages.js';

const frame = (value: unknown) => parseClientMessage(JSON.stringify(value));

describe('inbound frames are validated without exception', () => {
  // Agents are arbitrary programs written by strangers. This is the trust boundary of
  // the whole system, so nothing gets through on the strength of looking plausible.
  it('accepts a well-formed action', () => {
    const result = frame({ type: 'action', handId: 'h1', requestId: 'r1', action: 'call' });
    expect(result.ok).toBe(true);
  });

  it.each([
    ['not JSON at all', '{{{'],
    ['a bare string', '"hello"'],
    ['null', 'null'],
    ['an array', '[]'],
  ])('rejects %s', (_label, raw) => {
    expect(parseClientMessage(raw).ok).toBe(false);
  });

  it('rejects an unknown message type', () => {
    expect(frame({ type: 'drop_table' }).ok).toBe(false);
  });

  it('rejects a message missing its type', () => {
    expect(frame({ handId: 'h1', action: 'fold' }).ok).toBe(false);
  });

  it('reports which field was wrong', () => {
    const result = frame({ type: 'action', handId: 'h1', requestId: 'r1', action: 'shove' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/action/);
  });

  it('never throws, whatever it is handed', () => {
    const nasty = ['', ' ', '\u0000', '[]', '{"type":{"type":"action"}}', 'Infinity', '{"a":'];
    for (const raw of nasty) expect(() => parseClientMessage(raw)).not.toThrow();
  });
});

describe('chip amounts cannot be abused', () => {
  // Chips are integers of micro-USDC. A float or a negative reaching the engine would
  // corrupt the ledger, so the boundary rejects them rather than the engine coping.
  it.each([
    ['a negative raise', -100],
    ['a fractional raise', 250.5],
    ['a NaN raise', Number.NaN],
  ])('rejects %s', (_label, amount) => {
    expect(frame({ type: 'action', handId: 'h1', requestId: 'r1', action: 'raise', amount }).ok).toBe(
      false,
    );
  });

  it('accepts a large integer raise', () => {
    const result = frame({
      type: 'action',
      handId: 'h1',
      requestId: 'r1',
      action: 'raise',
      amount: 5_000_000_000,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a negative buy-in', () => {
    expect(frame({ type: 'join_table', tableId: 't1', buyIn: -1 }).ok).toBe(false);
  });
});

describe('every action carries a requestId', () => {
  // The echo is what makes a stale action impossible to confuse with a fresh one: a
  // slow agent's reply to the previous decision would otherwise be applied to whatever
  // is current — a call meant for a 100-chip flop bet becoming a call of a river shove.
  it('rejects an action with no requestId', () => {
    expect(frame({ type: 'action', handId: 'h1', action: 'call' }).ok).toBe(false);
  });

  it('carries the requestId through to the parsed message', () => {
    const result = frame({ type: 'action', handId: 'h1', requestId: 'abc-123', action: 'call' });
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.message as ActionMessage).requestId).toBe('abc-123');
  });

  it('requires a requestId on every action_request the server sends', () => {
    const withoutId = {
      type: 'action_request',
      handId: 'h1',
      seat: 0,
      street: 'flop',
      board: '2h 5s 9c',
      pot: 300,
      betToCall: 0,
      legal: {
        canFold: false,
        canCheck: true,
        canCall: false,
        callAmount: 0,
        canBet: true,
        canRaise: false,
        minRaiseTo: 100,
        maxRaiseTo: 5000,
      },
      deadline: 1,
    };
    expect(ActionRequestMessage.safeParse(withoutId).success).toBe(false);
    expect(ActionRequestMessage.safeParse({ ...withoutId, requestId: 'r1' }).success).toBe(true);
  });
});

describe('card notation on the wire', () => {
  // Integers are a performance detail of @clawroll/poker. Putting them on the wire
  // would force every agent author in every language to reimplement rank*4+suit
  // correctly before they could read their own hole cards.
  it.each(['As', 'Td', '2c', 'Kh', '9s'])('accepts %s', (card) => {
    expect(CardNotation.safeParse(card).success).toBe(true);
  });

  it.each(['10s', 'as', 'Ax', '1c', 'A', 'AsKd', ''])('rejects %s', (card) => {
    expect(CardNotation.safeParse(card).success).toBe(false);
  });

  it('accepts space-separated card lists including empty', () => {
    for (const list of ['', 'As', 'As Kd', '2h 5s 9c Jd Th']) {
      expect(CardList.safeParse(list).success).toBe(true);
    }
  });

  it('rejects a malformed card list', () => {
    // Leading and trailing spaces matter: hand histories are compared as strings when
    // verified, so stray whitespace would make an honest hand fail.
    for (const list of ['AsKd', 'As  Kd', 'As Kx', ' As', 'As ', ' ']) {
      expect(CardList.safeParse(list).success, JSON.stringify(list)).toBe(false);
    }
  });
});

describe('seed messages', () => {
  it('accepts 32 bytes of hex', () => {
    expect(frame({ type: 'client_seed', handId: 'h1', seed: 'a'.repeat(64) }).ok).toBe(true);
  });

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(66)],
    ['not hex', 'z'.repeat(64)],
  ])('rejects a %s seed', (_label, seed) => {
    expect(frame({ type: 'client_seed', handId: 'h1', seed }).ok).toBe(false);
  });
});

describe('outbound messages round-trip', () => {
  const messages: ServerMessage[] = [
    {
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      agentId: 'a1',
      displayName: 'bot',
      serverTime: 1,
    },
    {
      type: 'hand_start',
      handId: 'h1',
      tableId: 't1',
      buttonSeat: 0,
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      seats: [
        {
          seat: 0,
          playerId: 'a1',
          displayName: 'bot',
          stack: 10_000,
          committedThisStreet: 0,
          status: 'active',
          holeCards: null,
        },
      ],
      commit: 'f'.repeat(64),
      seedDeadline: 2,
    },
    { type: 'your_cards', handId: 'h1', seat: 0, cards: 'As Kd' },
    { type: 'street', tableId: 't1', handId: 'h1', street: 'flop', board: '2h 5s 9c', pot: 300 },
    {
      type: 'hand_end', tableId: 't1',
      handId: 'h1',
      serverSeed: 'b'.repeat(64),
      clientSeeds: [{ seat: 0, seed: 'c'.repeat(64) }],
      stacks: [{ seat: 0, stack: 10_300 }],
    },
    { type: 'error', code: 'stale_request', message: 'that request is no longer current' },
    { type: 'pong', nonce: 'n1', serverTime: 3 },
  ];

  it.each(messages.map((m) => [m.type, m] as const))(
    'encodes and re-validates a %s message',
    (_type, message) => {
      const decoded: unknown = JSON.parse(encodeServerMessage(message));
      expect(ServerMessageSchema.safeParse(decoded).success).toBe(true);
    },
  );

  it('rejects a server message with an unknown error code', () => {
    const bad = { type: 'error', code: 'teapot', message: 'nope' };
    expect(ServerMessageSchema.safeParse(bad).success).toBe(false);
  });
});

describe('protocol version', () => {
  it('is pinned in the welcome message', () => {
    // The server rejects a version it cannot speak at connect time rather than
    // failing later in a way that looks like a game bug.
    const wrong = {
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION + 1,
      agentId: 'a1',
      displayName: 'bot',
      serverTime: 1,
    };
    expect(ServerMessageSchema.safeParse(wrong).success).toBe(false);
  });
});

describe('the client union covers exactly the intended messages', () => {
  it('accepts each client message type', () => {
    const valid: unknown[] = [
      { type: 'join_table', tableId: 't1', buyIn: 10_000 },
      { type: 'client_seed', handId: 'h1', seed: 'a'.repeat(64) },
      { type: 'action', handId: 'h1', requestId: 'r1', action: 'fold' },
      { type: 'leave_table' },
      { type: 'ping', nonce: 'n1' },
    ];
    for (const message of valid) {
      expect(ClientMessage.safeParse(message).success, JSON.stringify(message)).toBe(true);
    }
  });
});

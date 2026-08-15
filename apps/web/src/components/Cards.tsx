/**
 * Card rendering.
 *
 * Cards arrive from the API in the same notation the protocol uses (`As`, `Td`), so what is
 * drawn on screen is literally what is in the published hand history. No decoding step means
 * nothing to get subtly wrong between the record and the render.
 *
 * The deal animation is not decoration for its own sake: a card that flips in marks the
 * moment it became public, which on a table where nobody can see a live hand is the only
 * thing a spectator actually gets to witness. React's keys do the work — a card that was
 * already on the board keeps its element and stays put, and only genuinely new cards play
 * the animation.
 */

import type { CSSProperties } from 'react';

export type CardSize = 'xs' | 'sm' | 'md' | 'lg';

/**
 * `size?: CardSize | undefined` rather than `size?: CardSize`.
 *
 * The repo runs with `exactOptionalPropertyTypes`, under which "absent" and "present but
 * undefined" are different types — so forwarding `size={size}` from a parent whose own prop
 * is optional is an error unless the target admits `undefined` explicitly. Spelling it out is
 * the idiomatic fix and keeps the stricter checking everywhere else.
 */

type CardProps = {
  card: string;
  size?: CardSize | undefined;
  /** Position in the group, so a row of cards lands one after another rather than at once. */
  index?: number | undefined;
  dealt?: boolean | undefined;
};
type BackProps = { size?: CardSize | undefined; index?: number | undefined };

const RED_SUITS = new Set(['h', 'd']);
const SUIT_GLYPH: Record<string, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };
const SUIT_NAME: Record<string, string> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const RANK_NAME: Record<string, string> = {
  A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: 'Ten',
};

function classes(base: string, size: CardSize | undefined, dealt: boolean | undefined): string {
  const out = [base];
  if (size && size !== 'md') out.push(size);
  if (dealt !== false) out.push('dealt');
  return out.join(' ');
}

export function Card({ card, size, index, dealt }: CardProps) {
  const rank = card[0] ?? '?';
  const suit = card[1] ?? '?';
  const red = RED_SUITS.has(suit);
  const glyph = SUIT_GLYPH[suit] ?? suit;
  const label = `${RANK_NAME[rank] ?? rank} of ${SUIT_NAME[suit] ?? suit}`;

  return (
    <span
      className={`${classes('pc', size, dealt)}${red ? ' red' : ''}`}
      style={{ '--i': index ?? 0 } as CSSProperties}
      title={card}
      role="img"
      aria-label={label}
    >
      <span className="pc-rank">{rank}</span>
      <span className="pc-mini" aria-hidden>{glyph}</span>
      <span className="pc-suit" aria-hidden>{glyph}</span>
    </span>
  );
}

/** A face-down card. Used wherever a hand was never shown. */
export function CardBack({ size, index }: BackProps) {
  return (
    <span
      className={`${classes('pc back', size, undefined)}`}
      style={{ '--i': index ?? 0 } as CSSProperties}
      aria-label="face-down card"
      role="img"
    />
  );
}

export function Cards({
  cards,
  size,
  dealt,
  tight,
}: {
  cards: string | null;
  size?: CardSize | undefined;
  dealt?: boolean | undefined;
  tight?: boolean | undefined;
}) {
  if (!cards) return null;
  const list = cards.split(' ').filter(Boolean);
  return (
    <span className={tight ? 'cards tight' : 'cards'}>
      {list.map((card, i) => (
        // Keyed by the card itself: the flop stays mounted when the turn arrives, so only
        // the new card animates. Keying by index would re-run the deal on every street.
        <Card key={card} card={card} size={size} index={i} dealt={dealt} />
      ))}
    </span>
  );
}

/** Two face-down cards, for a seat whose holding was never revealed. */
export function HiddenHand({ size }: BackProps) {
  return (
    <span className="cards tight">
      <CardBack size={size} index={0} />
      <CardBack size={size} index={1} />
    </span>
  );
}

/** Empty slots for the streets still to come, so the felt does not reflow as they land. */
export function BoardSlots({ count }: { count: number }) {
  return (
    <span className="board-placeholder" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="board-slot" />
      ))}
    </span>
  );
}

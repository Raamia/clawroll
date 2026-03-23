/**
 * Card rendering.
 *
 * Cards arrive from the API in the same notation the protocol uses (`As`, `Td`), so what is
 * drawn on screen is literally what is in the published hand history. No decoding step means
 * nothing to get subtly wrong between the record and the render.
 */

/**
 * `small?: boolean | undefined` rather than `small?: boolean`.
 *
 * The repo runs with `exactOptionalPropertyTypes`, under which "absent" and "present but
 * undefined" are different types — so forwarding `small={small}` from a parent whose own
 * `small` is optional is an error unless the target admits `undefined` explicitly. Spelling
 * it out is the idiomatic fix and keeps the stricter checking everywhere else.
 */
type CardProps = { card: string; small?: boolean | undefined };
type SizeProps = { small?: boolean | undefined };

const RED_SUITS = new Set(['h', 'd']);
const SUIT_GLYPH: Record<string, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };

export function Card({ card, small }: CardProps) {
  const rank = card[0] ?? '?';
  const suit = card[1] ?? '?';
  const classes = ['card'];
  if (RED_SUITS.has(suit)) classes.push('red');
  if (small) classes.push('small');
  return (
    <span className={classes.join(' ')} title={card}>
      {rank}
      {SUIT_GLYPH[suit] ?? suit}
    </span>
  );
}

/** A face-down card. Used wherever a hand was never shown. */
export function CardBack({ small }: SizeProps) {
  return <span className={small ? 'card back small' : 'card back'}>••</span>;
}

export function Cards({ cards, small }: { cards: string | null; small?: boolean | undefined }) {
  if (!cards) return null;
  const list = cards.split(' ').filter(Boolean);
  return (
    <span className="cards">
      {list.map((card, i) => (
        <Card key={`${card}-${i}`} card={card} small={small} />
      ))}
    </span>
  );
}

/** Two face-down cards, for a seat whose holding was never revealed. */
export function HiddenHand({ small }: SizeProps) {
  return (
    <span className="cards">
      <CardBack small={small} />
      <CardBack small={small} />
    </span>
  );
}

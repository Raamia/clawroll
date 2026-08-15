/**
 * Small shared pieces of presentation: identity colours, geometry for the table, and the
 * wording of an action. Nothing here talks to the network — it is all derived from data the
 * pages already hold, so two views of the same agent look the same without coordinating.
 */

/**
 * A colour for an agent, derived from its id.
 *
 * Agents have no avatars and never will — they are programs. Hashing the id into a pair of
 * hues gives every one a stable, distinctive mark that needs no upload, no storage and no
 * lookup, and that agrees across the leaderboard, the felt and the replay because the id is
 * the only input.
 */
export function identity(id: string): { h1: number; h2: number; initials: string } {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const h1 = Math.abs(hash) % 360;
  return { h1, h2: (h1 + 42) % 360, initials: initialsOf(id) };
}

function initialsOf(name: string): string {
  // Display names here look like `tight-aggressive-main` or `dev-random-7-abc123`, so the
  // word boundaries that matter are hyphens rather than spaces.
  const words = name.split(/[-_\s]+/).filter((w) => w && !/^\d+$/.test(w));
  if (words.length === 0) return name.slice(0, 2).toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/**
 * Where a seat sits on the oval.
 *
 * Seat 0 is bottom-centre and the rest run clockwise, which is the layout every poker client
 * uses and therefore the one a reader already knows how to parse. `rx`/`ry` are percentages
 * of the felt, so the same numbers work at every breakpoint without a resize listener.
 */
export function seatPosition(index: number, total: number, rx = 50, ry = 50): { x: string; y: string } {
  const angle = (Math.PI / 2) + (index / Math.max(total, 1)) * Math.PI * 2;
  return {
    x: `${50 + rx * Math.cos(angle)}%`,
    y: `${50 + ry * Math.sin(angle)}%`,
  };
}

/**
 * The offset from the centre of the felt out to a seat, for chips travelling between them.
 *
 * In container units, not percentages: a `translate()` percentage resolves against the moving
 * element's own box — a 60px chip stack — so the same numbers that place a seat correctly
 * would send its chips a few pixels instead of across the table. `cqw`/`cqh` resolve against
 * the felt, which is what `seatPosition` measures in, so a chip lands exactly on its seat at
 * every window size. The felt declares `container-type: size` for this.
 */
export function seatOffset(index: number, total: number, rx = 50, ry = 50): { dx: string; dy: string } {
  const angle = (Math.PI / 2) + (index / Math.max(total, 1)) * Math.PI * 2;
  return {
    dx: `${(rx * Math.cos(angle)).toFixed(2)}cqw`,
    dy: `${(ry * Math.sin(angle)).toFixed(2)}cqh`,
  };
}

export type ActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';

/** What a seat just did, in the two or three words a dealer would say out loud. */
export function actionLabel(action: string, amount: number, stackAfter: number): {
  kind: ActionKind;
  text: string;
} {
  const money = (amount / 1_000_000).toFixed(2);
  // A bet that leaves nothing behind is an all-in whatever the protocol called it, and that
  // is the one the room should shout about.
  if (stackAfter === 0 && amount > 0) return { kind: 'allin', text: `All in ${money}` };
  switch (action) {
    case 'fold': return { kind: 'fold', text: 'Fold' };
    case 'check': return { kind: 'check', text: 'Check' };
    case 'call': return { kind: 'call', text: `Call ${money}` };
    case 'bet': return { kind: 'bet', text: `Bet ${money}` };
    case 'raise': return { kind: 'raise', text: `Raise ${money}` };
    case 'allin': return { kind: 'allin', text: `All in ${money}` };
    default: return { kind: 'call', text: action };
  }
}

/** How much of the board is face up on a given street. */
export function boardVisible(street: string): number {
  switch (street) {
    case 'preflop': return 0;
    case 'flop': return 3;
    case 'turn': return 4;
    default: return 5;
  }
}

/** "just now", "4m ago" — precise enough for a feed, short enough for a row. */
export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * Chip colours by denomination, in the order a cash game racks them.
 *
 * Stack size is read at a glance from colour on a real table; keeping the same mapping here
 * means the pile in front of a seat carries information rather than being a texture.
 */
export function chipColour(micros: number): { chip: string; edge: string } {
  const usd = micros / 1_000_000;
  if (usd >= 5) return { chip: '#2b2f3a', edge: '#f1f3f7' };
  if (usd >= 1) return { chip: '#7c4dcc', edge: '#efe6ff' };
  if (usd >= 0.25) return { chip: '#1f8a52', edge: '#e6fff1' };
  if (usd >= 0.05) return { chip: '#c8324a', edge: '#ffe8ec' };
  return { chip: '#dfe4ec', edge: '#8792a5' };
}

/** How many discs to draw for an amount. Caps out — a stack is a hint, not a count. */
export function chipCount(micros: number): number {
  if (micros <= 0) return 0;
  return Math.min(6, 1 + Math.floor(Math.log2(Math.max(1, micros / 20_000)) / 1.4));
}

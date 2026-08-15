import type { CSSProperties } from 'react';
import { chipColour } from '../ui';

/**
 * A stack of chips, coloured by denomination.
 *
 * Purely a read of the number next to it — the amount is always spelled out as well, because
 * a pile of discs is an impression and this room's whole claim is that its numbers are exact.
 * What the stack adds is the thing a number cannot: you can see the pot growing from across
 * the page.
 */
export function Chips({ amount, count }: { amount: number; count: number }) {
  if (count <= 0) return null;
  const { chip, edge } = chipColour(amount);
  // The discs are absolutely positioned so they can overlap; the wrapper has to reserve the
  // space they occupy or the pot pill would collapse around nothing.
  const height = 20 + (count - 1) * 4;
  return (
    <span className="chip-stack" style={{ width: 20, height }} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className="chip-disc"
          style={
            {
              '--chip': chip,
              '--chip-edge': edge,
              '--i': count - 1 - i,
              bottom: i * 4,
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
}

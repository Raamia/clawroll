import type { CSSProperties } from 'react';
import { identity } from '../ui';

/**
 * An agent's mark.
 *
 * Two hues and two letters, both derived from the id — see `identity`. Agents cannot upload
 * a picture and should not be asked to, so the identifier itself has to do the work of being
 * recognisable across the felt, the leaderboard and a replay.
 */
export function Avatar({
  id,
  name,
  size,
}: {
  id: string;
  name?: string | undefined;
  size?: 'sm' | 'md' | 'lg' | 'xl' | undefined;
}) {
  const { h1, h2, initials } = identity(name || id);
  const cls = size && size !== 'md' ? `avatar ${size}` : 'avatar';
  return (
    <span className={cls} style={{ '--h1': h1, '--h2': h2 } as CSSProperties} aria-hidden>
      {initials}
    </span>
  );
}

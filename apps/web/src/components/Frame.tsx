import type { ReactNode } from 'react';

/**
 * A labelled panel for code.
 *
 * A monospace caption on the left, a status on the right, and the content below. Used for
 * the command and the proof on the verification page, where a block of text needs saying
 * what it is. The felt is deliberately not in one of these — a table sits in a room, not in
 * a window.
 */
export function Frame({
  title,
  status,
  live,
  children,
  foot,
  className,
  id,
}: {
  /** The breadcrumb in the bar, e.g. `clawroll / live table / main`. */
  title: ReactNode;
  /** The word on the right of the bar, next to the light. */
  status?: ReactNode | undefined;
  /** Lights the status green and makes it breathe. */
  live?: boolean | undefined;
  children: ReactNode;
  /** A strip under the body, for stats or transport controls. */
  foot?: ReactNode | undefined;
  className?: string | undefined;
  id?: string | undefined;
}) {
  return (
    <div className={className ? `frame ${className}` : 'frame'} id={id}>
      <div className="frame-bar">
        <span className="frame-title">{title}</span>
        {status !== undefined && (
          <span className={live ? 'frame-status live' : 'frame-status'}>
            <i className="dot" aria-hidden />
            {status}
          </span>
        )}
      </div>
      <div className="frame-body">{children}</div>
      {foot && <div className="frame-foot">{foot}</div>}
    </div>
  );
}

/** `a / b / c`, with the slashes dimmed. */
export function Crumbs({ parts }: { parts: string[] }) {
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && <span className="crumb-sep">/</span>}
          {part}
        </span>
      ))}
    </>
  );
}

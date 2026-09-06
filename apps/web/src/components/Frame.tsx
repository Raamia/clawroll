import type { ReactNode } from 'react';

/**
 * A window.
 *
 * The felt, a replay and a proof are all shown inside the same chrome — a title bar with the
 * three dots, a monospace breadcrumb, and a status light on the right. It frames the live
 * content as an instrument being watched rather than a picture on a page, and it gives every
 * page one shape the eye already knows how to read.
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
        <span className="frame-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
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

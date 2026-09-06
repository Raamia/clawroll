import { createElement, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

/**
 * Things that arrive as the reader reaches them.
 *
 * One shared `IntersectionObserver` for the whole page rather than one per element: a list of
 * forty hand rows would otherwise register forty observers that all fire on the same scroll.
 * Each element is watched until it has been seen once and then released — a section that has
 * already revealed itself does not hide again when scrolled past, because that reads as the
 * page flickering rather than as motion.
 *
 * Where the observer is missing (old browsers, some test runners) everything is shown at once.
 * Content must never depend on the animation to become visible.
 */

let observer: IntersectionObserver | null = null;
const pending = new WeakMap<Element, () => void>();

function watch(el: Element, onSeen: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onSeen();
    return () => {};
  }
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        pending.get(entry.target)?.();
        pending.delete(entry.target);
        observer?.unobserve(entry.target);
      }
    },
    // Fire a little before the element is fully on screen, so the motion is already under way
    // by the time the eye lands on it.
    { rootMargin: '0px 0px -8% 0px', threshold: 0.05 },
  );
  pending.set(el, onSeen);
  observer.observe(el);
  return () => {
    pending.delete(el);
    observer?.unobserve(el);
  };
}

export function Reveal({
  children,
  className,
  delay = 0,
  as = 'div',
  style,
}: {
  children?: ReactNode;
  className?: string | undefined;
  /** Milliseconds, for staggering siblings that come into view together. */
  delay?: number | undefined;
  as?: 'div' | 'section' | 'li' | undefined;
  style?: CSSProperties | undefined;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return watch(el, () => el.classList.add('in'));
  }, []);
  return createElement(
    as,
    {
      ref,
      className: className ? `reveal ${className}` : 'reveal',
      style: { '--d': `${delay}ms`, ...style } as CSSProperties,
    },
    children,
  );
}

/**
 * A line of text that arrives one word at a time.
 *
 * Each word is its own inline-block so it can be blurred and lifted independently; the space
 * between them stays a plain text node outside the span, because an inline-block swallows its
 * own trailing whitespace and the words would otherwise run together.
 */
export function Words({ text, from = 0 }: { text: string; from?: number | undefined }) {
  return (
    <>
      {text.split(' ').map((word, i) => (
        <span key={i}>
          {i > 0 && ' '}
          <span className="w" style={{ '--i': from + i } as CSSProperties}>
            {word}
          </span>
        </span>
      ))}
    </>
  );
}

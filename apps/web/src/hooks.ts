import { useEffect, useRef, useState } from 'react';

/**
 * Whether the reader has asked the operating system for less motion.
 *
 * The stylesheet already neutralises CSS animation, but some of the movement here is driven
 * from JavaScript — a pot that counts up, a replay that plays itself. Those have to ask.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * A number that travels to its new value instead of jumping to it.
 *
 * Used for the pot and for the totals on an agent's page. Money changing is the event this
 * whole site is about, so it gets the one bit of interpolation on the page — and the eye
 * follows a rolling counter to the right place, where a swapped-out digit is easy to miss.
 */
export function useCountUp(value: number, durationMs = 600): number {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const frame = useRef(0);

  useEffect(() => {
    if (reduced || from.current === value) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    const delta = value - origin;

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // Ease-out cubic: fast off the mark, settles gently onto the final figure.
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(origin + delta * eased);
      if (t < 1) frame.current = requestAnimationFrame(tick);
      else from.current = value;
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [value, durationMs, reduced]);

  return shown;
}

/** True for `ms` after `value` changes. Drives one-shot emphasis, like the pot flinching. */
export function usePulse(value: unknown, ms = 380): boolean {
  const [on, setOn] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setOn(true);
    const timer = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return on;
}

/** Copy-to-clipboard with the "Copied" state built in, since every use wants both. */
export function useCopy(resetMs = 1600): [string | null, (text: string, label: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), resetMs);
    return () => clearTimeout(timer);
  }, [copied, resetMs]);
  return [
    copied,
    (text: string, label: string) => {
      void navigator.clipboard.writeText(text).then(() => setCopied(label));
    },
  ];
}

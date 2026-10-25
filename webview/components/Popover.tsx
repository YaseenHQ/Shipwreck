import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconCheck } from "../icons";

/**
 * Anchored popover above the composer. Click-outside + Esc close it; arrow
 * keys move between [data-popitem] children; focus returns to the trigger.
 * `anchor` aligns the popover to its trigger: left edge for triggers in the
 * left half of the composer, right edge for triggers in the right half.
 */
export function Popover({
  onClose,
  className,
  children,
  returnFocus,
  anchor,
  autoFocusFirst = true,
}: {
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
  returnFocus?: React.RefObject<HTMLElement | null>;
  anchor?: React.RefObject<HTMLElement | null>;
  autoFocusFirst?: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const a = anchor?.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !a || !parent) return;
    const pr = parent.getBoundingClientRect();
    const ar = a.getBoundingClientRect();
    const max = pr.width - el.offsetWidth - 8;
    const clamp = (v: number) => Math.max(8, Math.min(v, Math.max(8, max)));
    if (ar.left + ar.width / 2 < pr.left + pr.width / 2) {
      el.style.left = `${clamp(ar.left - pr.left)}px`;
      el.style.right = "auto";
    } else {
      el.style.right = `${clamp(pr.right - ar.right)}px`;
      el.style.left = "auto";
    }
  }, [anchor]);

  // Latest onClose via ref: callers pass inline closures, and depending on
  // them would re-run this effect (and its autofocus) on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  useEffect(() => {
    const items = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>("[data-popitem]:not(:disabled)") ?? [],
      );
    const t = setTimeout(() => {
      if (autoFocusFirst) items()[0]?.focus({ preventScroll: true });
      if (ref.current) ref.current.scrollTop = 0;
    }, 0);
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      // The trigger toggles itself; don't count it as an outside click or
      // onClose + the trigger's own click would reopen the menu. Clicks
      // elsewhere in the composer (e.g. the input) likewise keep the menu.
      if (anchorRef.current?.current?.contains(t)) return;
      if ((t as HTMLElement).closest?.(".composer")) return;
      if (ref.current && !ref.current.contains(t)) onCloseRef.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const t = e.target as HTMLElement | null;
        // Native controls keep their own arrow behavior; the popover search
        // input retains arrow navigation through results.
        if (t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
        if (t instanceof HTMLInputElement && !t.classList.contains("pop-search")) return;
        const list = items();
        if (!list.length) return;
        e.preventDefault();
        const i = list.indexOf(document.activeElement as HTMLElement);
        list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
      }
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key, true);
    };
  }, [autoFocusFirst]);

  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;
  useEffect(() => () => returnFocusRef.current?.current?.focus(), []);

  return (
    <div ref={ref} className={`popover ${className ?? ""}`}>
      {children}
    </div>
  );
}

export function PopHead({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="pop-head dim">{children}</div>;
}

export function PopItem({
  icon,
  label,
  description,
  checked,
  right,
  danger,
  className,
  ...rest
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  description?: React.ReactNode;
  checked?: boolean;
  right?: React.ReactNode;
  danger?: boolean;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button data-popitem className={`pop-item ${danger ? "danger" : ""} ${className ?? ""}`} {...rest}>
      {icon && <span className="pop-ic">{icon}</span>}
      <span className="pop-text">
        <span className="pop-label">{label}</span>
        {description && <span className="pop-desc dim">{description}</span>}
      </span>
      {right}
      {checked && <IconCheck size={13} className="pop-check" />}
    </button>
  );
}

export function Tooltip({
  label,
  kbd,
  className,
  children,
}: {
  label: string;
  kbd?: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [show, setShow] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const start = () => {
    timer.current = window.setTimeout(() => setShow(true), 400);
  };
  const stop = () => {
    clearTimeout(timer.current);
    setShow(false);
  };
  return (
    <span
      className={`tip-wrap ${className ?? ""}`}
      onMouseEnter={start}
      onMouseLeave={stop}
      onFocus={start}
      onBlur={stop}
    >
      {children}
      {show && (
        <span className="tip" role="tooltip">
          {label}
          {kbd && <kbd>{kbd}</kbd>}
        </span>
      )}
    </span>
  );
}

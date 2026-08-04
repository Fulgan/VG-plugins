// The ONE overlay owner for true modals, plus the confirmation affordance built on it.
//
// TWO SHELLS, ONE BEHAVIOUR. `<dialog>.showModal()` is unavailable on the browsers this app's build target
// names (Firefox 98 / Safari 15.4 shipped it; the target floor is firefox78 / safari14), and a build target
// transpiles syntax without telling you anything about DOM availability — so the absence arrives at runtime,
// on a device, after every check has passed. The element tree is therefore identical in both shells and the
// branch decides only how the dialog is OPENED: `showModal()` puts it in the top layer with a native
// `::backdrop`, otherwise the `open` attribute makes it visible and a scrim div stands in for the backdrop.
//
// Everything that matters is written here unconditionally rather than borrowed from the native path — focus
// trap, focus restore, scroll lock, Escape routing — because the fallback silently loses whatever it is
// allowed to borrow, and the fallback is the shell no desktop test exercises.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/** Does this browser have the modal half of `<dialog>`? Read per instance, not at module load: the test
 *  harness installs a stub, and a module-level constant would be captured before it lands. */
const hasNativeModal = () =>
  typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal === "function";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  /** Escape, the close button, and a Cancel choice all route here — one exit, so a double-close can't happen. */
  onClose: () => void;
  label: string;
  children: ReactNode;
  /** Extra class on the dialog box, for per-dialog sizing. */
  className?: string;
}

export function Modal({ open, onClose, label, children, className }: ModalProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  // Decided once per instance so the shell can't change under a mounted modal.
  const [native] = useState(hasNativeModal);
  // `onClose` identity changes freely in the callers; the effect must not tear down and re-open the dialog
  // every time it does, so it is read through a ref.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const d = ref.current;
    if (!d || !open) return;

    const returnTo = document.activeElement as HTMLElement | null;
    if (native) d.showModal();
    else d.setAttribute("open", "");

    // The rest of the page keeps its scrollbar under the fallback shell, and `showModal` does not lock it
    // either — a modal that scrolls the page behind it reads as a rendering fault.
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Focus the first control, or the box itself when there is none, so the keyboard starts inside.
    const first = d.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? d).focus();

    // Escape: native reports it as `cancel` (and would close without telling us), the fallback only as a
    // keydown. Both are routed to the single `onClose`.
    const onCancel = (e: Event) => { e.preventDefault(); closeRef.current(); };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== "Tab") return;
      // Focus trap. Native `showModal` provides one; the fallback does not, and relying on the native
      // freebie is how the fallback ends up letting Tab walk into the page behind it.
      // No visibility filter here on purpose: `offsetParent` is null for a `position: fixed` element as well
      // as for a hidden one, so filtering on it drops controls that are perfectly focusable. The selector
      // above already excludes what cannot take focus (`[disabled]`, `tabindex="-1"`).
      const items = [...d.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const firstEl = items[0], lastEl = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === firstEl || active === d)) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && active === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    d.addEventListener("cancel", onCancel);
    d.addEventListener("keydown", onKeyDown);

    return () => {
      d.removeEventListener("cancel", onCancel);
      d.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = priorOverflow;
      if (native) { if (d.open) d.close(); }
      else d.removeAttribute("open");
      // Put the caret back where it was.
      returnTo?.focus?.();
    };
  }, [open, native]);

  // NB no backdrop/scrim click handler, in either shell, and that is deliberate: a stray click must not
  // discard an editor's unsaved text. `showModal` does not close on backdrop click either, so the two
  // shells agree by both doing nothing.
  return (
    <>
      {open && !native && <div className="modal-scrim" aria-hidden="true" />}
      <dialog ref={ref} className={`modal-box${className ? " " + className : ""}`} aria-label={label} tabIndex={-1}>
        {open && children}
      </dialog>
    </>
  );
}

export interface ConfirmOpts {
  title: string;
  /** Second line — the price and what you hold of that currency, from `affordLine`. */
  detail?: ReactNode;
  confirmLabel?: string;
  /** Red confirm button for a destructive answer (delete, overwrite). */
  danger?: boolean;
}

interface Pending { opts: ConfirmOpts; settle: (ok: boolean) => void }

/**
 * A promise-returning confirmation. Replaces `window.confirm`, which this app may not use: it is the one
 * overlay nobody styled and the one that cannot show an item's price beside the wallet.
 *
 * Returns the asker plus the element to render — no context provider, so there is no ordering problem
 * between a provider and the component that needs it (`App` owns two of these itself).
 *
 * ⚠️ `confirm()` blocked the event loop and this does not, so a caller can be re-entered while the question
 * is on screen. Callers claim their busy latch AROUND the await, never after it — a guard has to measure the
 * operation, not the call. A second ask while one is pending answers NO rather than replacing
 * the question, so a stray double-click cannot silently retarget a confirmation the user is already reading.
 */
export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  const ask = useCallback((opts: ConfirmOpts | string): Promise<boolean> => {
    const o = typeof opts === "string" ? { title: opts } : opts;
    if (pendingRef.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const p: Pending = { opts: o, settle: (ok) => { pendingRef.current = null; setPending(null); resolve(ok); } };
      pendingRef.current = p;
      setPending(p);
    });
  }, []);

  const ui = (
    <Modal open={!!pending} onClose={() => pending?.settle(false)} label={pending?.opts.title ?? "Confirm"} className="modal-confirm">
      <div className="modal-title">{pending?.opts.title}</div>
      {pending?.opts.detail != null && <div className="modal-detail">{pending.opts.detail}</div>}
      <div className="modal-actions">
        <button onClick={() => pending?.settle(false)}>Cancel</button>
        <button className={pending?.opts.danger ? "danger" : "apply"} onClick={() => pending?.settle(true)}>
          {pending?.opts.confirmLabel ?? "Confirm"}
        </button>
      </div>
    </Modal>
  );

  return { ask, ui };
}

/**
 * Escape closes. The ONE owner for the floating panels that are NOT modals — an anchored dropdown and a
 * pinned side panel, which keep their own positioning because promoting them to the top layer would
 * unanchor one and make the other block the grid it exists to be read beside.
 */
export function useEscape(onClose: () => void, active = true) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") ref.current(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}

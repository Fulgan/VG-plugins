// jsdom 29 ships `<dialog>` the ELEMENT but not its modal API: `showModal` and `close` are simply absent
// (`open` reflects, so the gap is invisible until something calls the method). Modal picks its shell by
// feature-detecting `showModal`, so without a stub every test here would silently exercise only the
// FALLBACK shell — the one path a real desktop browser never takes.
//
// The stub lives here rather than as a branch in Modal: a production feature-detect written to satisfy a
// test environment is a lie about the platform, and the shell choice is exactly what these tests need to be
// able to drive both ways.
if (typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

/** Drop the stub for a test that needs the no-native-dialog shell (an older Safari or Firefox). */
export function withoutNativeDialog(run: () => void | Promise<void>) {
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  const showModal = proto.showModal, close = proto.close;
  delete proto.showModal; delete proto.close;
  try { return run(); } finally { proto.showModal = showModal; proto.close = close; }
}

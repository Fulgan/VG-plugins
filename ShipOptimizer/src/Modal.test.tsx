// @vitest-environment jsdom
//
// Modal is the one overlay owner and it has TWO shells. Every behavioural test therefore runs against
// BOTH — native `showModal` and the fallback `open` attribute — because the whole risk in that design is a
// behaviour that only the native path happens to provide. A test that exercised one shell would pass while
// the browsers the build target names lost focus trapping, Escape, or scroll lock.
import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Modal, useConfirm } from "./Modal";
import { withoutNativeDialog } from "./test-setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const mount = (ui: React.ReactNode) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(ui); });
};

afterEach(() => {
  act(() => { root?.unmount(); });
  host?.remove();
  root = null; host = null;
  document.body.style.overflow = "";
});

const dialog = () => document.querySelector("dialog.modal-box") as HTMLDialogElement;
const press = (key: string, target: EventTarget) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

// Run one body against both shells, so neither can drift.
const bothShells = (name: string, body: () => void) => {
  it(`${name} — native shell`, body);
  it(`${name} — fallback shell (safari14/firefox78)`, () => withoutNativeDialog(body));
};

describe("Modal shells", () => {
  bothShells("opens and shows its children", () => {
    mount(<Modal open onClose={() => {}} label="T"><button>inside</button></Modal>);
    expect(dialog().hasAttribute("open")).toBe(true);
    expect(dialog().textContent).toContain("inside");
  });

  bothShells("renders nothing while closed", () => {
    mount(<Modal open={false} onClose={() => {}} label="T"><button>inside</button></Modal>);
    expect(dialog().hasAttribute("open")).toBe(false);
    expect(dialog().textContent).not.toContain("inside");
  });

  bothShells("Escape routes to onClose exactly once", () => {
    const onClose = vi.fn();
    mount(<Modal open onClose={onClose} label="T"><button>inside</button></Modal>);
    press("Escape", dialog());
    // Once, not twice: the native shell would also fire `cancel` and self-close if it were not intercepted,
    // and both paths funnel into the same single onClose.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  bothShells("locks body scroll while open and restores it after", () => {
    mount(<Modal open onClose={() => {}} label="T"><button>inside</button></Modal>);
    expect(document.body.style.overflow).toBe("hidden");
    act(() => { root!.render(<Modal open={false} onClose={() => {}} label="T"><button>inside</button></Modal>); });
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  bothShells("moves focus in, and restores it to the opener on close", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    mount(<Modal open onClose={() => {}} label="T"><button>inside</button></Modal>);
    expect((document.activeElement as HTMLElement)?.textContent).toBe("inside");

    act(() => { root!.render(<Modal open={false} onClose={() => {}} label="T"><button>inside</button></Modal>); });
    // No previous popin in this app restored focus; the fallback shell gets nothing for free here.
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  bothShells("traps Tab inside the dialog", () => {
    mount(
      <Modal open onClose={() => {}} label="T">
        <><button>first</button><button>last</button></>
      </Modal>,
    );
    const [first, last] = [...dialog().querySelectorAll("button")] as HTMLButtonElement[];
    last.focus();
    press("Tab", last);
    expect((document.activeElement as HTMLElement)?.textContent).toBe("first");
    press("Tab", first); // shift+Tab from the first wraps to the last
    act(() => { first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
    expect((document.activeElement as HTMLElement)?.textContent).toBe("last");
  });

  it("fallback shell renders its own scrim; the native shell uses ::backdrop instead", () => {
    withoutNativeDialog(() => {
      mount(<Modal open onClose={() => {}} label="T"><button>inside</button></Modal>);
      expect(document.querySelectorAll(".modal-scrim").length).toBe(1);
    });
    act(() => { root?.unmount(); });
    host?.remove(); root = null; host = null;
    mount(<Modal open onClose={() => {}} label="T"><button>inside</button></Modal>);
    expect(document.querySelectorAll(".modal-scrim").length).toBe(0);
  });

  bothShells("a scrim/backdrop click does NOT close — a stray click must not discard edits", () => {
    const onClose = vi.fn();
    mount(<Modal open onClose={onClose} label="T"><button>inside</button></Modal>);
    const scrim = document.querySelector(".modal-scrim");
    act(() => { (scrim ?? dialog()).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onClose).not.toHaveBeenCalled();
  });
});

// A harness for the hook: renders the confirm UI and exposes `ask` so a test can drive the promise.
function Harness({ onReady }: { onReady: (ask: (o: string) => Promise<boolean>) => void }) {
  const { ask, ui } = useConfirm();
  onReady(ask);
  return <>{ui}</>;
}

describe("useConfirm", () => {
  const setup = () => {
    let ask!: (o: string) => Promise<boolean>;
    mount(<Harness onReady={(a) => { ask = a; }} />);
    return () => ask;
  };
  const click = (label: string) => {
    const btn = [...document.querySelectorAll("dialog.modal-box button")].find((b) => b.textContent === label);
    expect(btn, `no "${label}" button`).toBeTruthy();
    act(() => { (btn as HTMLButtonElement).click(); });
  };

  it("resolves true on Confirm and false on Cancel", async () => {
    const get = setup();
    let p = get()("Buy it?");
    await act(async () => {});
    expect(dialog().textContent).toContain("Buy it?");
    click("Confirm");
    expect(await p).toBe(true);

    p = get()("Buy it?");
    await act(async () => {});
    click("Cancel");
    expect(await p).toBe(false);
  });

  it("Escape answers NO — cancel ≡ no, so the safe answer needs no handler of its own", async () => {
    const get = setup();
    const p = get()("Delete it?");
    await act(async () => {});
    press("Escape", dialog());
    expect(await p).toBe(false);
  });

  it("closes after answering, so the next question starts from nothing on screen", async () => {
    const get = setup();
    const p = get()("Buy it?");
    await act(async () => {});
    click("Confirm");
    await p;
    await act(async () => {});
    expect(dialog().hasAttribute("open")).toBe(false);
  });

  // The hazard this whole design carries: `window.confirm` froze the event loop, so a second ask could not
  // exist. An awaited dialog can be re-entered, and answering NO is the only safe reply — replacing the
  // question would retarget a confirmation the user is already reading.
  it("a second ask while one is pending answers NO and leaves the first question up", async () => {
    const get = setup();
    const first = get()("Buy A?");
    await act(async () => {});
    const second = get()("Buy B?");
    expect(await second).toBe(false);
    expect(dialog().textContent).toContain("Buy A?");
    click("Confirm");
    expect(await first).toBe(true);
  });
});

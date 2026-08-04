import { Component, type ErrorInfo, type ReactNode } from "react";

// The last line of defence against a blank page.
//
// React unmounts the WHOLE tree when a render throws, and with nothing above the app to catch it the result is
// an empty document — no message, no way back except a manual reload, and no clue what happened. That is the
// worst possible failure mode here because the bridge is expected to come and go: the game restarts, the plugin
// reloads, and a component holding data that has just gone away is exactly when a render throws.
//
// It deliberately does NOT try to recover by re-rendering the same tree — whatever threw would throw again.
//
// The fallback text states only what is KNOWN: the page stopped, the game was not touched, and here is the
// message. It must not name a cause. A boundary catches a bad read from the bridge and a plain coding mistake
// through the same path and cannot tell them apart, so a confident explanation is wrong about half the time and
// sends the reader looking in the wrong place.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; where: string | null }> {
  state: { error: Error | null; where: string | null } = { error: null, where: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ShipOptimizer crashed:", error, info.componentStack);
    // The component stack is shown, not just logged. Without it a report is "the page broke" plus a message that
    // may name nothing recognisable, and the next question is always "where?" — the top few frames answer it, and
    // they are also what distinguishes our own code from a browser extension throwing inside our render.
    const where = (info.componentStack ?? "")
      .split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 6).join("\n");
    this.setState({ where: where || null });
  }

  render() {
    const { error, where } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <h2>This page stopped working</h2>
        <p>
          Nothing was changed in the game, and no data was lost. Reloading usually gets the page back. If it
          keeps happening, the message below is what to report.
        </p>
        <pre className="crash-msg">{error.message}</pre>
        {where && <pre className="crash-msg crash-where">{where}</pre>}
        <button type="button" onClick={() => location.reload()}>Reload</button>
        <p className="crash-hint">Full details are in the browser console.</p>
      </div>
    );
  }
}

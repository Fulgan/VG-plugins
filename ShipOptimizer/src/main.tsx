import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './ErrorBoundary'
import { hydrateFromBridge } from './storage'
import { claimPairingCode } from './pair'
import { applyDesign, DEFAULT_DESIGN } from './designs'

// Pinned to the default, not to whatever is stored: no UI selects a design, so a stored id would strand a
// browser in a look it has no way to leave. Applied before the first paint — doing it in a component effect
// would show one frame of the base look and then swap, which reads as a flash on every load.
applyDesign(DEFAULT_DESIGN)

// Pull the bridge's copy of the client state into the local cache BEFORE the first render: the tabs read
// their persisted state synchronously in `useState` initializers, so hydrating first is what lets
// server-side storage work without async plumbing (or a write-before-hydrate race) in every consumer.
// It self-limits (see HYDRATE_TIMEOUT_MS) and never rejects, so an offline bridge just means a local start.
// A `#/pair?c=CODE` link (the QR a phone scans) is claimed BEFORE anything renders and before hydration: the
// claim is what produces this device's token, and every tab reads the connection synchronously in a `useState`
// initializer. Doing it in a component would also put it below the hooks, which is the fault class B7 was.
const root = createRoot(document.getElementById('root')!)
claimPairingCode()
  .then(hydrateFromBridge)
  .finally(() =>
    root.render(
      <StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    ),
  )

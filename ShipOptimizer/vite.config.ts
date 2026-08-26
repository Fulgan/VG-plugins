// `vitest/config` rather than `vite`: the same defineConfig plus the `test` block below, which vite's own
// type does not know about.
import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Every top-level path the bridge answers on. The dev server proxies these through to Hypercom so the app can
// talk to it as though it had been served by it, which is what a production build gets for free.
//
// It is a LIST rather than a catch-all because Vite owns this origin too: `/@vite`, `/@fs`, `/src` and the
// module graph all have to keep reaching Vite. A blanket proxy would swallow the dev server's own plumbing.
const BRIDGE_PATHS = [
  '/arena', '/aspects', '/buy', '/catalog', '/client', '/combat', '/cycles', '/debug', '/diag', '/events',
  '/factions', '/galaxy', '/images', '/inventories', '/item', '/ledger', '/loadout', '/log', '/materials',
  '/missions', '/move', '/officers', '/openapi', '/pair', '/recruits', '/reputation', '/routes', '/sell',
  '/ship', '/ships', '/shops', '/skills', '/stat', '/status',
]

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // `''` as the prefix: these are not `VITE_` vars and must never reach the client bundle. They configure the
  // dev SERVER, which runs in node. The token in particular exists precisely so it does not travel.
  const env = loadEnv(mode, process.cwd(), '')
  const bridgePort = env.VG_BRIDGE_PORT || '8777'
  const token = env.VG_BRIDGE_TOKEN || ''

  // BINDING IS OPT-IN. Vite's default is loopback, and it stays that way unless a host is named: widening the
  // bind silently would put an unauthenticated dev server on whatever network the machine is attached to.
  // `tools/dev-remote.ps1` writes this as the tailnet address, which is reachable only by the owner's devices.
  const host = env.VG_DEV_HOST || undefined

  return {
    plugins: [react()],
    server: {
      host,
      // A named host arrives in the `Host` header and Vite rejects anything it was not told about. The tailnet
      // suffix rather than one machine, so the same config survives the address changing.
      allowedHosts: ['.ts.net', 'localhost'],
      proxy: Object.fromEntries(BRIDGE_PATHS.map((p) => [p, {
        target: `http://127.0.0.1:${bridgePort}`,
        changeOrigin: true,
        configure: (proxy: { on: (e: string, cb: (req: { path: string; setHeader: (k: string, v: string) => void }) => void) => void }) => {
          proxy.on('proxyReq', (proxyReq) => {
            if (!token) return
            // BOTH GATES, because the bridge has two. Most routes read the `x-auth-token` header; the ones a
            // browser cannot put a header on (`<img>` sources and the `EventSource` feed) read `?token=`
            // instead. A proxy can satisfy either, and satisfying only one leaves the icons blank.
            proxyReq.setHeader('x-auth-token', token)
            if (!/[?&]token=/.test(proxyReq.path))
              proxyReq.path += (proxyReq.path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
          })
        },
      }])),
    },
    build: {
      // The UI is meant to be opened on a phone or tablet as well as the PC, and those run whatever browser
      // came with the device. Vite's default target assumes a recent one; a phone a couple of years behind
      // meets syntax it cannot parse and shows a BLANK page (no error, nothing rendered). Naming the oldest
      // engines explicitly costs a little output size and buys the failure not happening.
      target: ['es2020', 'safari14', 'chrome87', 'firefox78'],
    },
    test: {
      // jsdom lacks `<dialog>`'s modal API; the stub belongs to the harness, not to the component. See
      // src/test-setup.ts. Note the target above is exactly why Modal cannot rely on showModal in the first
      // place: safari14 and firefox78 both predate it.
      setupFiles: ['./src/test-setup.ts'],
    },
  }
})

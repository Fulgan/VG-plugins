// `vitest/config` rather than `vite`: the same defineConfig plus the `test` block below, which vite's own
// type does not know about.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
})

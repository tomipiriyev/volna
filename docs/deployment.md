# Deployment

The app is a static site (`npm run build` → `dist/`). There is no server-side
component; models and simulations stay in the browser.

## Secure context

WebGPU and `crypto.subtle` (project hashing) require a secure context:
HTTPS, or `http://localhost` during development.

## Cross-origin isolation (multi-threaded solver)

The multi-threaded solver is an Emscripten pthreads build. It needs
`SharedArrayBuffer`, which browsers expose only when the page is
cross-origin isolated:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

- `require-corp` is used rather than `credentialless`, because Safari does
  not support `credentialless`.
- Every resource the page loads must be same-origin or send CORP/CORS
  headers. The app self-hosts all scripts, wasm and fonts, so it loads no
  third-party assets.
- The headers are set in `vite.config.ts` for `npm run dev` and
  `npm run preview`. `app/public/_headers` covers Netlify and Cloudflare
  Pages, and `deploy/nginx.conf` is a sample for nginx. GitHub Pages uses a
  service worker instead (see below).

## Fallback without isolation

If the page is not isolated (`crossOriginIsolated === false`), the solver
worker loads the single-thread build (`antsim-st.wasm`). The same
calculations run on one core. The capability panel and the solver status
line state which build is active and why.

`npm run preview:noiso` serves the production build without the headers,
and the e2e suite checks the fallback there.

## GitHub Pages

The public site is published by `.github/workflows/pages.yml` on every push to
`main`: it builds the wasm solver, runs `npm run build:pages` (served from
`/volna/`, output in `dist-pages/`) and deploys the result.

GitHub Pages cannot set response headers. The Pages build therefore registers a
small service worker (`app/public/coi-sw.js`, `app/src/platform/coi.ts`) that
adds the isolation headers to same-origin responses:

- A visitor's first load registers the worker and reloads once. Later visits are
  isolated at once.
- If the worker cannot run, or the page still is not isolated after the reload,
  the app starts normally with the single-thread solver and does not reload again.
- Other builds never register it; hosts that can set the headers do not need it.

A fork under another repository name must change `base` in `vite.config.ts`
(and the URL in `playwright.config.ts` and `app/e2e/pages.spec.ts`).

## Memory

The solver worker is terminated after each run, because WebAssembly memory
cannot shrink. The wasm heap is capped at 4 GB (wasm32). The app applies a
lower, configurable cap before allocating, sized from the memory estimate.

# @orca-web/web

Mobile-first client. React + Vite + TypeScript + Tailwind; three.js arrives with the
plater (M4) and is shared with the G-code preview (M5). `npm run build` emits `dist/`, which the API
serves as static assets — there is no second web server.

Primary target is a 390px-wide viewport with thumb interaction. Desktop is the degraded
case.

```bash
docker compose up -d api          # the API + slicer on :8080
npm run dev -w @orca-web/web      # Vite on :5173, proxying the API paths
npm run build -w @orca-web/web    # typecheck + bundle into dist/
```

## Layout

```
src/
  api/        http.ts (the error contract), catalog.ts (384 printers / 392 filaments),
              jobs.ts (upload, submit, SSE), plater.ts (bed, model bytes, arrange,
              thumbnail)
  state/      progress.ts (the sparse progress stream), selection.ts (the drill-down and
              the job descriptor), plate.ts (what is on the plate and where the engine
              will be told it is), recent-models.ts (content ids, so a re-slice uploads
              nothing)
  three/      plater-scene.ts (the WebGL plate, Z-up, millimetres), touch-controls.ts
              (one finger orbits, two pan and zoom, a tap selects), geometry.ts (STL/3MF
              loading, precise transformed bounds, lay-flat)
  ui/         App.tsx and one component per screen or picker; primitives.tsx holds the
              touch vocabulary every one of them is built from
```

three.js is loaded with the plater, not with the app: `PlaterScreen` and everything under
`three/` are a lazy chunk, and `state/plate.ts` — which the job descriptor is built from —
has no three.js import at all. First load is 73 kB gzipped; the renderer's 141 kB arrives
when the plate is opened.

Four constraints are enforced by tests rather than by convention:

- `no-hover.test.ts` — no hover-dependent styling anywhere, and every `<button>`/`<a>`
  carries the 48px `tap` utility.
- `state/progress.test.ts` — the bar stays indeterminate until a real number arrives,
  never goes backwards, and keeps every warning (SPEC deviation #10).
- `state/selection.test.ts` — the machine `PresetRef` comes from the nozzle variant, and
  models are always referenced by content id.
- `state/plate.test.ts` — `pos` translates the model's file coordinates rather than
  placing its centre, every instance gets its own assemble index, `arrange` is false
  whenever positions are sent, and the hand-written Euler XYZ agrees with three.js to
  twelve decimal places.

The pixel-level checks (no horizontal overflow at 390px, ≥44px targets) run in Chromium
against the real container, together with M4's position-fidelity check:

```bash
docker compose up -d api
node test/e2e/plater.mjs
```

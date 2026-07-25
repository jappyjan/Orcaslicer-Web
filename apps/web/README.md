# @orca-web/web

Mobile-first client. React + Vite + TypeScript + Tailwind; three.js arrives with the
plater (M4) and the G-code preview (M5). `npm run build` emits `dist/`, which the API
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
              jobs.ts (upload, submit, SSE)
  state/      progress.ts (the sparse progress stream), selection.ts (the drill-down and
              the job descriptor), recent-models.ts (content ids, so a re-slice uploads
              nothing)
  ui/         App.tsx and one component per screen or picker; primitives.tsx holds the
              touch vocabulary every one of them is built from
```

Three constraints are enforced by tests rather than by convention:

- `no-hover.test.ts` — no hover-dependent styling anywhere, and every `<button>`/`<a>`
  carries the 48px `tap` utility.
- `state/progress.test.ts` — the bar stays indeterminate until a real number arrives,
  never goes backwards, and keeps every warning (SPEC deviation #10).
- `state/selection.test.ts` — the machine `PresetRef` comes from the nozzle variant, and
  models are always referenced by content id.

The pixel-level checks (no horizontal overflow at 390px, ≥44px targets) run in Chromium
against the real container; see the M3 section of the root README.

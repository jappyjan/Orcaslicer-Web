# @orca-web/web

Mobile-first client. React + Vite + TypeScript + Tailwind; three.js arrives with the
viewport and is shared by the plate and the G-code preview. `npm run build` emits `dist/`,
which the API serves as static assets — there is no second web server.

Primary target is a 390px-wide viewport with thumb interaction. Desktop is the degraded
case.

## The shape of it

One 3D viewport filling the window, with every control floating over it — the arrangement
OrcaSlicer's desktop build and SimplyPrint's web slicer both use — and a `Prepare` /
`Preview` switch between the plate and the toolpath.

```
┌───────────────────────────────────────────┐
│ cube20.stl        [Prepare|Preview]       │  the bar
│ ┌────┐                                    │
│ │Add │                                    │
│ │Move│                                    │
│ │Rot.│          the canvas, full-bleed    │  ┌──────────────┐
│ │Scl.│                                    │  │ dock         │
│ │Arr.│                                    │  │  print       │
│ └────┘                                    │  │  objects     │
│ ┌────────┐                                │  │  transform   │
│ │ 3D Top │                                │  │ ── Slice ─── │
│ └────────┘                                │  └──────────────┘
└───────────────────────────────────────────┘
       ^ below 60rem the dock is a bottom sheet with three heights
```

`Workspace.tsx` owns it, and three things make it work at 390px rather than being a
desktop layout shrunk:

- **The dock is one column at every size** — a card on the right above 60rem, the same
  column as a bottom sheet below it. Peek / half / full, dragged or tapped by a 48px
  handle. There is no second, mobile-only information architecture to keep in step.
- **The free rectangle is published, not assumed.** Whatever the panels are not covering
  is measured and exposed as `--free-*` properties and through `useViewportInsets()`.
  Overlays position against it, and the scene offsets its projection into it, so the plate
  is never centred underneath the sheet. `bed.ts:fitDistance` frames to that rectangle.
- **The toolbar is labelled.** The desktop original is icon-only with tooltips; a tooltip
  needs a pointer. Every `ToolButton` is a 48px icon with its name printed under it.

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
  ui/         Workspace.tsx (the shell: bar, rail, dock, free rectangle), PrepareView /
              PreviewView (one per stage), *Stage.tsx (the canvases — the only lazy
              pieces), *Panel.tsx (what the dock holds), the pickers, and primitives.tsx,
              which holds the touch vocabulary every one of them is built from
```

three.js is loaded with the viewport, not with the app: `PlaterStage`, `PreviewStage` and
everything under `three/` are a lazy chunk, so the chrome is usable — choose a printer, a
filament, a quality preset — while the renderer is still arriving. Nothing in the dock
imports it: `state/plate.ts` builds the job descriptor without three.js, and
`state/plate-editor.ts` reaches the one function that genuinely needs it (`measure`, the
bounds of a _rotated_ mesh) through the same dynamic import the stage uses.

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

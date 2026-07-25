# Repository layout

Decided in M0. Everything later milestones add should have an obvious home here; if
it does not, that is a signal to revisit this document rather than to invent a
parallel structure.

```
.
├── Dockerfile               # one image: pinned OrcaSlicer binary + Node 22
├── docker-compose.yml       # smoke / help-check services (api arrives with M1)
├── package.json             # npm workspaces root; all dev tooling lives here
├── tsconfig.base.json       # the single compiler-options source of truth
├── tsconfig.json            # solution file: project references for `tsc --build`
├── eslint.config.js         # flat config, one rule set for every workspace
├── vitest.config.ts         # one runner, all workspaces
├── AGPL-NOTICE.md
│
├── apps/
│   ├── api/                 # @orca-web/api  — Fastify, job orchestration        (M1)
│   │   └── src/
│   │       ├── engine/      #   the SlicerEngine port + orca/ adapter
│   │       ├── geometry/    #   mesh IO: bake a rotation into an STL before staging  (M4)
│   │       ├── queue/       #   the JobQueue port + in-process / bullmq adapters
│   │       ├── profiles/    #   the ProfileResolver port + the catalog-backed adapter
│   │       ├── catalog/     #   start-up load + response/ETag caching for GET /catalog
│   │       ├── storage/     #   SQLite metadata, content-addressed models, artefacts
│   │       ├── jobs/        #   orchestration and the SSE event bus
│   │       └── http/        #   Fastify routes, error mapping, static.ts serves the client
│   │           └── routes/  #     one module per feature-sized group of routes       (M4)
│   └── web/                 # @orca-web/web  — React + Vite + Tailwind             (M3)
│       └── src/
│           ├── api/        #   the API client: error contract, catalog, jobs + SSE
│           ├── state/      #   pure logic: progress model, selection → descriptor, the plate
│           ├── three/      #   the WebGL plater: scene, touch gestures, mesh loading (M4)
│           └── ui/         #   one component per screen; primitives.tsx = touch vocabulary
│
├── packages/
│   ├── shared/              # @orca-web/shared  — types crossing the HTTP boundary
│   └── catalog/             # @orca-web/catalog — READS the generated artefacts    (M2)
│
├── tools/
│   └── extractors/          # @orca-web/extractors — WRITES them, build-time only (M2)
│
├── scripts/                 # shell entry points run inside the container
│   ├── smoke.sh
│   └── check-cli-help.sh
│
├── test/
│   ├── e2e/                 # browser acceptance: a real phone viewport, a real slice (M4)
│   ├── fixtures/            # committed test inputs (cube20.stl, 684 bytes)
│   └── golden/              # byte-exact expected outputs (orca-slicer --help)
│
├── docker/
│   └── extra-ca-certificates/  # optional, empty by default
│
└── docs/
    ├── SPEC.md              # authoritative brief
    ├── REPO-LAYOUT.md       # this file
    └── adr/                 # architecture decision records, written before the code
```

## Why this shape

**npm workspaces, three groups.** `apps/*` are deployables, `packages/*` are libraries
consumed by them, `tools/*` are build-time-only programs whose output is data, not a
running service. **Nothing in the request path may import `tools/*`.** That rule exists
because those programs parse C++ source, walk a 79 MB profile tree and fetch over the
network; none of that belongs in a running server, and keeping them in `tools/` makes
the violation visible in an import statement rather than in a stack trace.

**`packages/catalog` reads what `tools/extractors` writes.** M2 originally put the
read-only query API next to the extractors. The API needs it at runtime — that is the
whole point of `GET /catalog` — so leaving it there would have made `apps/api` import
`tools/*` and break the rule above. The read side was therefore split into
`@orca-web/catalog`: it holds the generated-artefact types, the `/generated` path
scheme, the preset-id/structural-key contract, and `ProfileCatalogQuery`, and it does
exactly one kind of I/O — `readFileSync` on an already-generated JSON file. The
extractors depend on it (they write the shapes it defines); nothing depends on the
extractors at runtime.

Two consequences worth stating, because they are what the rule is actually protecting:

- `apps/api` cannot accidentally acquire a C++ parser or a network fetch through a
  transitive import. `@orca-web/catalog` has no dependencies at all.
- The runtime image contains `packages/catalog/dist` and `/generated`, but not
  `tools/extractors`. The Dockerfile enforces it by omission.

**A single `packages/shared`, not one package per concept.** The API and the web client
have to agree on job descriptors, progress events, artefact names and preset references.
One package with one entry point keeps the dependency graph a straight line
(`shared -> api`, `shared -> web`) and avoids the version-skew games that appear the
moment two internal packages depend on each other. `@orca-web/catalog` is a second
package rather than part of `shared` because it is not just types: it carries the query
implementation and reads files, and `apps/web` must not.

**Both extractors in one `tools/extractors` package.** The config-schema extractor and
the profile-catalog extractor both parse pinned upstream artefacts and both need the
same "which OrcaSlicer version am I targeting" plumbing. Splitting them would duplicate
that for no benefit.

**One root `tsconfig.base.json`, per-package `tsconfig.json` with project references.**
`npm run typecheck` at the root is `tsc --build`, so incremental builds and cross-package
type checking work without a bundler. `apps/web` is deliberately _not_ in the root
solution: Vite uses bundler module resolution and DOM libs, which conflict with the
Node-oriented base config, so it carries its own compiler options and is checked by its
own `build` script.

**One root `vitest.config.ts`.** `npm test` at the root runs every workspace's unit
tests in one process. Milestones add project entries instead of competing config files:
M1's container-backed `integration` project, and M3's jsdom `web` project (rooted at
`apps/web`, the only one that loads a Vite plugin). `apps/web` is excluded from the
`unit` project's globs rather than being allowed to run twice.

**`scripts/` is not a workspace.** These are container entry points invoked by
`docker compose run`, not npm packages — `smoke.sh` and `check-cli-help.sh`, and nothing
else. Both preset flatteners that used to live here are gone: the M0 stopgap
`resolve-profile.mjs` (it resolved `inherits` within a preset's own directory, wrong for
1939 of the 11 286 edges in 2.4.2) and its interim successor `flatten-preset.mjs`. They
existed only because the M0/M1 image shipped no `node_modules` and no compiled `dist/`.
The image now builds the Node workspaces and bakes the generated catalog in, so
`smoke.sh` calls `packages/catalog/dist/flatten-cli.js` — the same
`ProfileCatalogQuery.flattenForSlicer` the API's `CatalogProfileResolver` uses. One
resolver, tested once, exercised by both the smoke test and production.

**Ports and adapters inside `apps/api/src`.** Each `*/port.ts` is an interface plus its
error types and nothing else; adapters sit beside it and are selected in exactly one
place (`app.ts`, or a `create.ts` for the ones chosen by environment variable). The rule
that makes it worth the directories: nothing outside `engine/orca/` may import from it,
so "what would a second slicer cost?" has a file-list answer rather than a guess. The two
boundaries that carry a decision record are `SlicerEngine` (ADR 0001) and `JobQueue`
(ADR 0002).

**`docs/adr/` for decisions, not designs.** One file per boundary, written _before_ the
implementation it constrains (working agreement), and kept short enough that the next
person actually reads it before changing the shape of something.

**Two runtime directories with opposite lifetimes.** `/work` holds one disposable
sandbox per job and is emptied on every exit path plus at boot; `/data` holds the SQLite
database, the content-addressed model library and published artefacts, and is the only
thing that needs a volume. Artefacts are copied out of the sandbox into `/data` before
cleanup, which is why a download still works a week after the slice.

**…and a third that is neither: `/generated`.** The config schema and profile catalog,
written by `tools/extractors` in the Dockerfile's `generate` stage and read once at
start-up (`ORCA_GENERATED_DIR`). It is part of the image, not of the deployment: it
never changes without the OrcaSlicer version changing, needs no volume, and is why the
running container needs no network. 26 MB for 2.4.2.

**`apps/api/src/geometry/` sits above the engine boundary, not inside `engine/orca/`.**
M4 needed rotation and scale, and the engine's plate description carries positions and
nothing else — so anything but a translation has to be baked into the geometry before the
slicer sees it. That is a property of _the plate description_, not of OrcaSlicer, and every
CLI-driven slicer in the family shares it. The module reads STL and 3MF meshes, applies a
3×3, and writes a binary STL with real facet normals (SPEC deviation #11); `jobs/` calls it
while staging models into the sandbox, so the library blob is never touched.

**`apps/web/src/three/` is the only place three.js appears.** `state/plate.ts` — which the
job descriptor is built from — deliberately does not import it, so the 600 kB renderer stays
off the path between opening the app and slicing; it is loaded with the plater screen
instead. The Euler convention `plate.ts` writes out by hand is asserted against three's own
in `plate.test.ts`, which is what makes that safe.

**`test/e2e/` is not a vitest project.** It needs a browser and a running container, and it
is the milestone's acceptance criterion rather than a unit test: `node test/e2e/plater.mjs`
drives the app at 390 × 844 with touch emulation, slices for real, and parses the extrusion
coordinates back out of the G-code. Keeping it out of `npm test` keeps `npm test` runnable
with no Docker and no browser.

**`test/` at the root, not per-package.** `test/fixtures/cube20.stl` and
`test/golden/orca-slicer-help.txt` describe the _container_, not any one workspace, and
they are copied into the image. Per-workspace unit tests live next to their sources as
`*.test.ts`.

## Conventions

- Package names are scoped `@orca-web/*`; the npm scope is never published.
- Every workspace is `"private": true` and `"type": "module"`.
- Source in `src/`, build output in `dist/`, both gitignored except `src`.
- Tests are `src/**/*.test.ts`, colocated with what they test.
- Anything generated from a pinned OrcaSlicer version goes in `/generated` (gitignored)
  and is produced by `tools/extractors` at build time — never hand-edited, never
  committed.

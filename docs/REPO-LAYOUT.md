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
│   └── web/                 # @orca-web/web  — React + Vite + Tailwind + three.js (M3+)
│
├── packages/
│   └── shared/              # @orca-web/shared — types crossing the HTTP boundary
│
├── tools/
│   └── extractors/          # @orca-web/extractors — build-time only             (M2)
│
├── scripts/                 # shell/JS entry points run inside the container
│   ├── smoke.sh
│   ├── check-cli-help.sh
│   └── resolve-profile.mjs
│
├── test/
│   ├── fixtures/            # committed test inputs (cube20.stl, 684 bytes)
│   └── golden/              # byte-exact expected outputs (orca-slicer --help)
│
├── docker/
│   └── extra-ca-certificates/  # optional, empty by default
│
└── docs/
    ├── SPEC.md              # authoritative brief
    └── REPO-LAYOUT.md       # this file
```

## Why this shape

**npm workspaces, three groups.** `apps/*` are deployables, `packages/*` are libraries
consumed by them, `tools/*` are build-time-only programs whose output is data, not a
running service. Keeping the M2 extractors in `tools/` rather than `packages/` makes it
structurally obvious that nothing in the request path may import them: they parse C++
source and a 79 MB profile tree, and their results are baked at build time and cached.

**A single `packages/shared`, not one package per concept.** The API and the web client
have to agree on job descriptors, progress events, artefact names and the profile
catalog shape. One package with one entry point keeps the dependency graph a straight
line (`shared -> api`, `shared -> web`) and avoids the version-skew games that appear
the moment two internal packages depend on each other.

**Both extractors in one `tools/extractors` package.** The config-schema extractor and
the profile-catalog extractor both parse pinned upstream artefacts and both need the
same "which OrcaSlicer version am I targeting" plumbing. Splitting them would duplicate
that for no benefit. If one grows a heavy dependency the other does not need, split
then.

**One root `tsconfig.base.json`, per-package `tsconfig.json` with project references.**
`npm run typecheck` at the root is `tsc --build`, so incremental builds and cross-package
type checking work without a bundler. `apps/web` is deliberately _not_ in the root
solution: Vite uses bundler module resolution and DOM libs, which conflict with the
Node-oriented base config, so it carries its own compiler options and is checked by its
own `build` script.

**One root `vitest.config.ts`.** `npm test` at the root runs every workspace's unit
tests in one process. Later milestones add project entries (jsdom for `apps/web`, a
container-backed project for the M1 real-slice integration test) instead of competing
config files.

**`scripts/` is not a workspace.** These are container entry points invoked by
`docker compose run`, not npm packages. They must keep working in an image that has no
`node_modules` — the M0 image ships the slicer, Node and these scripts, and nothing else.
`scripts/resolve-profile.mjs` is an explicit stopgap that M2 folds into
`tools/extractors` and deletes.

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

# @orca-web/web

Mobile-first client. Empty until **M3**.

Settled stack (see `docs/SPEC.md`): React + Vite + TypeScript + Tailwind, three.js for
the plater (M4) and the G-code preview (M5). `npm run build` emits `dist/`, which the
API serves as static assets — there is no second web server.

Primary target is a 390px-wide viewport with thumb interaction. Desktop is the
degraded case.

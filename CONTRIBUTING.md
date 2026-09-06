# Contributing to Draft Canvas

Thanks for taking a look. Draft Canvas is a small, opinionated tool, and this doc is meant to keep
it that way — quick to read, quick to act on.

## Running it locally

```bash
git clone https://github.com/acltabontabon/draft-canvas.git
cd draft-canvas
npm install
npm run dev        # http://localhost:5180
```

Node `>=22.14.0` (matches CI). No backend, no environment variables, no accounts to set up — clone
and go.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Type-check and produce a production build in `dist/` |
| `npm run lint` | oxlint |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run e2e` | Browser tests (Playwright — run `npm run e2e:install` once first) |
| `npm run e2e:offline` | The same suite against a built, offline-served app |
| `npm run check` | Lint, build, and unit tests together — **run this before opening a PR** |

Focused runs, when you're iterating on one thing:

```bash
npx vitest run tests/history.test.ts    # one unit test file
npx vitest run -t 'coalesces'           # by test name
npx playwright test e2e/editing.spec.ts # one e2e spec
```

## Conventions

npm (not yarn/pnpm), 2-space indent, single quotes, semicolons, trailing commas. oxlint, no
Prettier. TypeScript with project references. Comments explain *why*, not *what* — several existing
ones record a bug found the hard way; don't remove those. See [`AGENTS.md`](AGENTS.md) for the
fuller set of load-bearing rules (where node appearance lives, why text is only ever wrapped once,
why `src/document/` can't import React, and so on) before touching core rendering, storage, or the
document model.

## Submitting a change

1. Fork, branch, make your change.
2. `npm run check` — fix anything it catches. Don't work around a real failure to get green output.
3. Open a PR against `main` with what changed and why. Small, focused PRs are easier to review than
   one PR doing three things.
4. **Discuss anything large before writing it.** If a change touches the document schema, the
   relationship model, or adds a new node/connector concept, open an issue first. It's a much
   cheaper conversation before the code exists than after.

## UI changes

Verify in the browser, not just in your head — both themes (light/dark), and if it touches
Presentation Mode or the Intentional Roughness presets, check those too. Keyboard reachability
matters: most of Draft Canvas is designed to be usable without a mouse. Above all, keep it fast —
the product's whole reason for existing is that opening it should feel closer to grabbing a marker
than opening a modeling tool. If a change makes the common path slower or busier to look at, that's
a real cost, not a style nitpick.

## Architecture-semantic changes

This is the part of Draft Canvas most worth getting right, and the part where "looks nice" isn't a
strong enough reason on its own. Before adding or changing a rule in
`src/document/connectorSemantics.ts`'s capability matrix (see
[`docs/SEMANTICS.md`](docs/SEMANTICS.md) for what's there today):

> When adding architecture-aware behavior, optimize for technical correctness and developer
> intuition. Draft Canvas should be opinionated where the underlying technology is opinionated, and
> permissive where multiple architectures are valid.

Concretely:

- A new rule should be technically defensible — grounded in how the technology actually works
  (a queue really doesn't publish into a topic), not just a relationship that would look tidier.
- Guide, never block. The matrix's job is to narrow and nudge (a sensible default, an optional
  "this looks unusual" note), never to reject a connection the user drew on purpose.
- If a pairing is genuinely ambiguous, leave it unopinionated rather than guessing — an absent
  matrix entry falls back to full, unrestricted freedom, and that's a legitimate outcome, not a gap
  to fill reflexively.
- Don't add a feature — semantic or otherwise — merely because another diagramming tool has it.
  Draft Canvas is deliberately not draw.io, Lucidchart, or a UML/BPMN tool.

## Keeping Draft Canvas fast and simple

The whole product bets on staying lightweight. A dependency, a setting, or a new concept all cost
something — read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)'s "Deliberately not built" before
proposing something in that direction (accounts, cloud sync, collaboration, AI generation, icon
packs, and a few others are deliberately out of scope). If you're unsure whether an idea fits, open
an issue and ask — that's exactly what issues are for.

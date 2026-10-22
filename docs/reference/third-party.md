# Third-party acknowledgements

Thank you to the authors and maintainers of the open-source projects Draft Canvas builds on.

- Draft Canvas's own code is [Apache 2.0](../../LICENSE). Third-party components keep their own licenses.
- [THIRD_PARTY_LICENSES.txt](../../THIRD_PARTY_LICENSES.txt) holds the generated notices for the web
  editor, desktop front end and Rust crates. The apps link it from **About → Licences**.
- [NOTICE](../../NOTICE) holds project notices and logo attributions.

## In the editor

| Project | Used for |
| --- | --- |
| [React and React DOM](https://github.com/react/react) | User interface |
| [React Flow](https://github.com/xyflow/xyflow) (`@xyflow/react`, `@xyflow/system`) | Interactive canvas and connection handles |
| [React Aria Components](https://github.com/adobe/react-spectrum) | Accessible components and dialogs |
| [Zustand](https://github.com/pmndrs/zustand) | Editor and interface state |
| [idb](https://github.com/jakearchibald/idb) | IndexedDB document storage |
| [fflate](https://github.com/101arrowz/fflate) | ZIP backups and compressed collaboration invites |
| [Marked](https://github.com/markedjs/marked) | Markdown in Text shapes; documentation pages on the website |
| [refractor](https://github.com/wooorm/refractor) and [Prism](https://github.com/PrismJS/prism) | Syntax highlighting in code blocks |
| [Simple Icons](https://github.com/simple-icons/simple-icons) | Technology logos |
| [D3](https://github.com/d3/d3) | Drag and zoom, through React Flow |
| [Workbox](https://github.com/GoogleChrome/workbox) | Offline service worker |

## Desktop and agents

| Project | Used for |
| --- | --- |
| [Tauri](https://github.com/tauri-apps/tauri) and its [plugins](https://github.com/tauri-apps/plugins-workspace) | Desktop shell, dialogs, window state, single instance, opening links, updates |
| [Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk) | MCP server for coding agents |
| [Tokio](https://github.com/tokio-rs/tokio) | Async runtime, local IPC and sidecar I/O |
| [axum](https://github.com/tokio-rs/axum), [hyper](https://github.com/hyperium/hyper) and [tungstenite](https://github.com/snapview/tungstenite-rs) | Local-network collaboration relay |
| [socket2](https://github.com/rust-lang/socket2) and [if-addrs](https://github.com/messense/if-addrs) | Relay sockets and local network addresses |
| [Serde](https://github.com/serde-rs/serde) and [serde_json](https://github.com/serde-rs/json) | Serialization |
| [notify](https://github.com/notify-rs/notify) | File change notifications |
| [ts-rs](https://github.com/Aleph-Alpha/ts-rs) | TypeScript types from Rust payloads |
| [toml_edit](https://github.com/toml-rs/toml) | Editing agent config while keeping comments and order |
| [thiserror](https://github.com/dtolnay/thiserror) | Rust errors |
| [uuid](https://github.com/uuid-rs/uuid), [RustCrypto SHA-2](https://github.com/RustCrypto/hashes) and [subtle](https://github.com/dalek-cryptography/subtle) | Identifiers, content hashes, constant-time comparison |
| [base64](https://github.com/marshallpierce/rust-base64), [dunce](https://gitlab.com/kornelski/dunce) and [semver](https://github.com/dtolnay/semver) | Encoding, Windows paths, update versions |
| [objc2](https://github.com/madsmtm/objc2), [windows-rs](https://github.com/microsoft/windows-rs) (`windows-sys`) and [libc](https://github.com/rust-lang/libc) | macOS, Windows and system calls |

## Build, test and deploy tools

Not bundled in the apps.

| Project | Used for |
| --- | --- |
| [TypeScript](https://github.com/microsoft/TypeScript) and [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | Type checking |
| [Vite](https://github.com/vitejs/vite), its [React plugin](https://github.com/vitejs/vite-plugin-react) and [Vite PWA](https://github.com/vite-pwa/vite-plugin-pwa) | Dev servers, builds, service worker generation |
| [Oxc / oxlint](https://github.com/oxc-project/oxc) and [tsx](https://github.com/privatenumber/tsx) | Linting and TypeScript scripts |
| [Vitest](https://github.com/vitest-dev/vitest) | Unit tests and coverage |
| [Playwright](https://github.com/microsoft/playwright) | Browser tests, screenshots, performance harnesses |
| [GitHub Actions cache](https://github.com/actions/cache) | Reusing the pinned Rust audit tool between CI runs |
| [axe-core](https://github.com/dequelabs/axe-core) and its [Playwright integration](https://github.com/dequelabs/axe-core-npm) | Accessibility checks |
| [React Testing Library](https://github.com/testing-library/react-testing-library), [jest-dom](https://github.com/testing-library/jest-dom) and [user-event](https://github.com/testing-library/user-event) | Component tests |
| [jsdom](https://github.com/jsdom/jsdom) and [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB) | Test environments |
| [fast-check](https://github.com/dubzzz/fast-check) and [Proptest](https://github.com/proptest-rs/proptest) | Generated test cases |
| [Mermaid](https://github.com/mermaid-js/mermaid) | Checking Mermaid import and export in tests |
| [DOMPurify](https://github.com/cure53/DOMPurify) | HTML sanitization used by Mermaid in tests |
| [ELK.js](https://github.com/kieler/elkjs) and [Ajv](https://github.com/ajv-validator/ajv) | Layout comparison harness; agent schema tests |
| [tempfile](https://github.com/Stebalien/tempfile), [muda](https://github.com/tauri-apps/muda) and [tokio-tungstenite](https://github.com/snapview/tokio-tungstenite) | Rust tests: temp folders, menu shortcut parsing, relay client |
| [Wrangler](https://github.com/cloudflare/workers-sdk) | Cloudflare deploys of the website and relay |

Direct dependencies are in the [root](../../package.json), [website](../../www/package.json),
[desktop](../../src-tauri/Cargo.toml) and [MCP](../../src-tauri/mcp/Cargo.toml) manifests. The
notice generator covers the root production npm tree and Cargo metadata only; website and dev-only
npm packages are outside it.

## Maintaining attributions

Add credits and notices in the same change that adds or updates a dependency or asset.

1. Add a row above: upstream repository and what Draft Canvas uses it for.
2. For packages, run `npm run licenses` (needs installed npm dependencies and a working Cargo
   toolchain), review the output for missing license text, commit `THIRD_PARTY_LICENSES.txt`, then
   run `npm run licenses:check`.
3. For copied code, SVGs, fonts or other assets, record the upstream version or commit, source,
   license and modifications next to the files, and keep required notices with them. The generator
   does not find these.
4. Keep required upstream NOTICE text. Do not hand-edit `THIRD_PARTY_LICENSES.txt`; it is overwritten.

### Simple Icons and brand assets

- The full [Simple Icons](https://github.com/simple-icons/simple-icons) catalog ships from the pinned
  npm package as a small name index plus lazily loaded path groups.
- [`scripts/technology-catalog.mjs`](../../scripts/technology-catalog.mjs) generates it;
  [`src/nodes/technology.ts`](../../src/nodes/technology.ts) recognizes technologies. After changing
  the pinned version, run `npm run icons:generate`; `npm run icons:check` and unit tests catch stale assets.
- Builds prepend the asset credits and the generated
  [per-icon source, guidelines and license index](../../src/nodes/technologyCatalog/NOTICE.txt) to the
  licences shown in **About → Licences**.
- Simple Icons is [CC0-1.0](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md), but
  individual icons can have other licenses and brand guidelines; see the
  [upstream disclaimer](https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md).
  Keep each bundled logo's notices. Brand names and logos belong to their owners and imply no endorsement.
- The Apache Kafka logo is the Apache Software Foundation's, under Apache-2.0; see the
  [ASF logo guidance](https://apache.org/logos) and [NOTICE](../../NOTICE).

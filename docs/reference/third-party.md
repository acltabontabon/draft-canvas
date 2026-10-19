# Third-party acknowledgements

Draft Canvas is made possible by open-source contributors. Thank you to the authors and maintainers
of the libraries, tools and assets we use.

Draft Canvas's own code is licensed under [Apache 2.0](../../LICENSE). Third-party components retain
their own licenses. [THIRD_PARTY_LICENSES.txt](../../THIRD_PARTY_LICENSES.txt) contains generated
package license notices for the web editor, desktop front end and Rust dependencies. It ships with
the apps and is linked from **About → Licences**. The project's [NOTICE](../../NOTICE) records
project notices and any additional attributions maintained there.

## Projects used in the app

These credits cover the editor's direct runtime dependencies and prominent supporting projects.
The generated notices include additional transitive dependencies. Build and test tools are credited
separately below; being listed here does not mean a tool is bundled in the editor.

| Project | Used for |
| --- | --- |
| [React and React DOM](https://github.com/react/react) | User interface and DOM rendering |
| [React Flow](https://github.com/xyflow/xyflow) | Interactive node canvas |
| [React Aria Components](https://github.com/adobe/react-spectrum) | Accessible interface components and dialogs |
| [Zustand](https://github.com/pmndrs/zustand) | Editor and interface state |
| [idb](https://github.com/jakearchibald/idb) | Browser document storage through IndexedDB |
| [fflate](https://github.com/101arrowz/fflate) | ZIP exports |
| [refractor](https://github.com/wooorm/refractor) and [Prism](https://github.com/PrismJS/prism) | Syntax highlighting and language grammars for code blocks |
| [Simple Icons](https://github.com/simple-icons/simple-icons) | Bundled technology logos in the canvas, suggestions and image exports |
| [D3](https://github.com/d3/d3) | Drag, zoom and related interaction utilities used through React Flow |
| [Workbox](https://github.com/GoogleChrome/workbox) | Generated service worker and offline app-shell caching |

## Desktop and agent integration

| Project | Used for |
| --- | --- |
| [Tauri](https://github.com/tauri-apps/tauri) and its [plugins](https://github.com/tauri-apps/plugins-workspace) | Desktop application, dialogs, window state, single-instance behavior, opening links and updates |
| [Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk) | Desktop MCP server for coding agents |
| [Tokio](https://github.com/tokio-rs/tokio) | Asynchronous runtime, local IPC and sidecar I/O |
| [Serde](https://github.com/serde-rs/serde) and [serde_json](https://github.com/serde-rs/json) | Serialization and JSON handling |
| [notify](https://github.com/notify-rs/notify) | Filesystem change notifications |
| [ts-rs](https://github.com/Aleph-Alpha/ts-rs) | TypeScript bindings generated from Rust payloads |
| [toml_edit](https://github.com/toml-rs/toml) | Agent configuration edits that preserve comments and formatting |
| [thiserror](https://github.com/dtolnay/thiserror) | Structured Rust errors |
| [uuid](https://github.com/uuid-rs/uuid) and [RustCrypto SHA-2](https://github.com/RustCrypto/hashes) | Identifiers and file-content hashes |
| [base64](https://github.com/marshallpierce/rust-base64), [dunce](https://gitlab.com/kornelski/dunce) and [semver](https://github.com/dtolnay/semver) | Binary encoding, Windows path handling and update version comparisons |
| [objc2](https://github.com/madsmtm/objc2), [windows-rs](https://github.com/microsoft/windows-rs) and [libc](https://github.com/rust-lang/libc) | Platform bindings for macOS and Windows integration and native system calls |

## Build, documentation and test tools

| Project | Used for |
| --- | --- |
| [TypeScript](https://github.com/microsoft/TypeScript) and [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | Type checking and third-party type declarations |
| [Vite](https://github.com/vitejs/vite) and its [React plugin](https://github.com/vitejs/vite-plugin-react) | Editor and website development servers and builds |
| [Vite PWA](https://github.com/vite-pwa/vite-plugin-pwa) | Workbox integration and offline build configuration |
| [Oxc / oxlint](https://github.com/oxc-project/oxc) and [tsx](https://github.com/privatenumber/tsx) | Linting and TypeScript script execution |
| [Vitest](https://github.com/vitest-dev/vitest) | Unit tests and V8 coverage reporting |
| [Playwright](https://github.com/microsoft/playwright) | Browser tests, screenshots and performance harnesses |
| [axe-core](https://github.com/dequelabs/axe-core) and its [Playwright integration](https://github.com/dequelabs/axe-core-npm) | Automated accessibility checks |
| [React Testing Library](https://github.com/testing-library/react-testing-library), [jest-dom](https://github.com/testing-library/jest-dom) and [user-event](https://github.com/testing-library/user-event) | Component tests, DOM assertions and simulated interactions |
| [jsdom](https://github.com/jsdom/jsdom) and [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB) | DOM and browser storage environments for tests |
| [fast-check](https://github.com/dubzzz/fast-check) and [Proptest](https://github.com/proptest-rs/proptest) | Generated test cases for TypeScript and Rust |
| [Mermaid](https://github.com/mermaid-js/mermaid) | Validating Mermaid import/export examples in tests |
| [ELK.js](https://github.com/kieler/elkjs) | Development-only automatic-layout comparison harness |
| [Ajv](https://github.com/ajv-validator/ajv) | Agent schema validation in tests and the comparison harness |
| [Marked](https://github.com/markedjs/marked) | Rendering Markdown documentation for the website |
| [tempfile](https://github.com/Stebalien/tempfile) and [muda](https://github.com/tauri-apps/muda) | Temporary directories and native menu shortcut validation in Rust tests |

The root [package manifest](../../package.json), separate [website manifest](../../www/package.json),
[desktop manifest](../../src-tauri/Cargo.toml) and [MCP manifest](../../src-tauri/mcp/Cargo.toml)
record direct dependencies; their lockfiles pin resolved versions. The package notice generator
reads the root production npm dependency tree and Cargo metadata. Website and development-only npm
dependencies are outside that npm scan; review notices separately if their code is redistributed.

## Maintaining attributions

Keep credits and notices with the change that introduces or updates a third-party dependency or asset:

1. Add a project credit here with its upstream repository and what Draft Canvas uses it for.
2. For package dependencies, run `npm run licenses` and commit the generated
   `THIRD_PARTY_LICENSES.txt`. Use an installed npm dependency tree and a working Cargo toolchain
   with the desktop dependencies available so both sections can be generated. Review the output
   for missing license text, then run `npm run licenses:check`.
3. For copied code, SVGs, fonts or other assets outside the package dependency tree, record the
   upstream version or commit, source, license and any modifications alongside the files. Preserve
   required copyright and notice text and ensure it travels with the distributed asset. The package
   notice generator does not discover these files automatically.
4. Retain upstream notices where required, including applicable NOTICE content. Keep human-maintained
   credits separate from `THIRD_PARTY_LICENSES.txt`, which is overwritten by the generator.

### Simple Icons and brand assets

Draft Canvas includes the full catalog from [Simple Icons](https://github.com/simple-icons/simple-icons)
through the pinned npm package, as a small name index and separate lazy local path groups. Its
license is included in the generated package notices, and
[NOTICE](../../NOTICE) credits Simple Icons, the Apache Software Foundation's Apache Kafka logo,
and the bundled logos with individual attribution or license terms. Builds prepend these asset
credits, plus the complete generated [per-icon source, guidelines and license index](../../src/nodes/technologyCatalog/NOTICE.txt),
to the package licences available through **About** › **Licences**.
The catalog is generated by [technology-catalog.mjs](../../scripts/technology-catalog.mjs) and
recognized through [technology.ts](../../src/nodes/technology.ts). After changing the pinned package,
run `npm run icons:generate`; `npm run icons:check` and the unit suite detect stale assets.

The Simple Icons project is released under
[CC0-1.0](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md), but individual icons
can have different licenses and brand guidelines. Its
[upstream disclaimer](https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md)
explains where to find those details. Check the icons actually bundled and retain their applicable
notices; the package license alone does not describe every logo's terms. Brand names and logos
belong to their respective owners; their use does not imply endorsement of Draft Canvas.

The Apache Kafka logo is attributed to the Apache Software Foundation under Apache-2.0; see the
[ASF logo guidance](https://apache.org/logos) and the project's [NOTICE](../../NOTICE).

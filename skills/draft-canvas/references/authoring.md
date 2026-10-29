# Author a repository diagram

Read the survey’s **read next** files, then follow the entry point through the main request and its
handled failures. Stop when the requested scope is supported by evidence. Edit `request.json`:

- **Confirm every element** in code. Delete false positives and details outside the requested scope;
  add what the survey missed. A survey finding is a hint, not a fact.
- **Fill every `TODO:`.** Descriptions: one sentence, a verb first ("Takes orders and reserves
  stock."). Relationship labels: a verb phrase from the caller's side, ≤ 32 characters ("Places
  order", "Publishes OrderPlaced"). `technology`: one product, optionally versioned ("Spring Boot
  3"), so its logo shows. Add `semantic` and `kind` when the code says
  ([vocabulary.md](vocabulary.md) maps code to them).
- **Sharpen the evidence**: add `symbol` and `line` for what you read; `basis: "inferred"` for what you
  concluded without seeing it.
- **C4 levels** ([modeling.md](modeling.md#pick-the-views)). The draft picks the top view
  from the count; change it if what you learned says otherwise — up to ~8 containers read as one
  container view, more open on a context view with the containers inside. For a detailed architecture map, give the
  container that holds the main path's logic — the one that orchestrates calls, owns the business
  rules or has modules of its own — a component view (`inside`, `level: "component"`, 5–10 parts),
  and up to two more if they earn it. Do not add depth to a requested overview or a targeted edit.
  One store per owning service when services own separate schemas.
- **Flows — the presentation.** Separate dependency structure from runtime events: subscribing to
  state is setup, not an action replayed after every edit. Show notification in the event’s direction,
  and spotlight concurrent effects instead of inventing an order between them. The main request path in code order: open with
  `{spotlight: [ids], caption}`, then one step per call with a caption saying what happens there. It
  lives in the view where its calls are: in the top view, name it in `layout.primaryFlow`; under a
  context view, list it **first** in the container view's flows (the app lays each inside view out
  around its first flow) and give the top view a short "at a glance" flow as `primaryFlow`. A
  component view gets its own flow, first, for the same request one level down. A call made twice
  over one relationship (get the cart … empty the cart): step it the first time, and light it again
  later with `{spotlight: ["<relationship id>"], caption}` — never a second relationship in the same
  direction. One `variantOf` flow per failure path the code handles on purpose — retry, dead letter,
  compensation, fallback, a rejection the caller shows — not every error that merely propagates; start
  it where the paths part and end it with a `{spotlight}` on where the failure lands, never by stepping
  a relationship backwards. Never invent an order.
- **Compensating actions.** When code documents a recovery operation, draw it as a separate
  relationship with `semantic: "compensates"`, `compensationFor` set to the original relationship
  id, and `compensationName` for the business action. Use `label` for its wire operation and
  `compensationProtocol` (`http`, `calls` or `grpc`) when known. It stays an ordinary editable
  relationship; `compensationVisible: false` folds only its line. `read_diagram` returns these fields,
  and `update_diagram` can change them. Do not infer a recovery from a failure path alone.
- **Notes where they explain a decision, risk or uncertainty**, each with an `about`: `decision` (a choice the code or an ADR makes),
  `warning` (a risk you can see), `question` (what the code can't tell you), `code` (≤ 15 lines that say
  more than a sentence). A `label` is Markdown — a legend, an endpoint table, a runbook checklist or a
  `> [!WARNING]` callout — and, placed beside its element (`attach: false`), takes a `style`
  ([mcp-playbook.md](mcp-playbook.md#styled-labels)).


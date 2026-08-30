# Flows and Presentation Mode

A Flow is a named, ordered path through connections you've already drawn. It doesn't add anything
to your architecture — it's a way of narrating it. Draw the system once; tell as many stories over
it as you need.

## The mental model

- **Canvas** — what exists. Nodes and connectors, drawn once.
- **Flow** — the order in which you want to explain some of those connectors, for one scenario.
- **Presentation Mode** — plays a Flow back, step by step.

Nothing about a Flow duplicates a node or a connector. A step is just a reference to a connector
that's already on the canvas, plus an optional caption. Deleting a connector drops it from any
Flow that used it; nothing crashes or dangles.

## Explain a flow

1. Draw your architecture — the usual nodes and connectors.
2. Select a connector and, in the Inspector, add it to a Flow (an existing one, or "New flow…").
   Give the Flow a name — *"Checkout — Happy path"*.
3. Select the next connector in the story and add it to the same Flow. Repeat for as many steps as
   the scenario needs. The Flow panel (toolbar → Flows) shows every step in order, with move-up /
   move-down and remove controls.
4. Optionally add a caption to a step — *"Authorize payment"* — distinct from the connector's own
   label, which describes what the connection represents in general. The caption is what's
   happening *at this point in this particular story*; if you leave it blank, playback shows the
   connector's label instead.
5. Press **Present**. If the diagram has more than one Flow, pick which one to walk through.
6. Step through it: **→** or **Space** for the next interaction, **←** for the previous one,
   **Esc** to exit. The active connector and its two endpoints stay lit; everything else quietens
   without disappearing, so you never lose the surrounding architecture.

## Multiple scenarios, one diagram

The same architecture usually has more than one story worth telling:

- Checkout — Happy path
- Checkout — Payment declined
- Payment timeout
- Retry
- Async fulfillment

Each is its own Flow. They can share early steps and diverge later — *Happy path* and *Declined*
might both start `Client → API → Payment` and then part ways. Switching which Flow is selected
never changes a node or a connector; it only changes which order you're walking through them in.

## Synchronous vs. asynchronous

A connector defaults to a solid line — a synchronous, request/response-style interaction. Mark it
**Async** (in the Inspector) for a dashed line instead — a queue publish, an event, a
fire-and-forget call, a webhook. That's the whole model: a visual distinction, not a protocol
taxonomy. Label it however you like — `publish`, `event`, `consume`, `scheduled` — free text on the
connector's own label.

## Flow kind

For more nuance than plain solid/dashed, a connector can carry a **Flow kind** (in the Inspector,
next to Connection type): `Sync`, `Async`, `Event`, `Callback`, `Conditional`, `Retry`, `Failure`,
`Fallback`. Each gets a subtle line treatment — a dotted line and a small dot for an event, a
dash-dot pattern for a retry, a hollow arrowhead for a callback's return path, a small diamond for
a conditional branch — so the *shape* of a flow reads at a glance without leaning on colour or a
label. It's still just line style: choosing a kind never renames the connector, never recolours it,
and (with one exception) never touches whether it's marked async — the exception is choosing the
`Async` kind itself, which turns on the dashed line as a starting point, the same way choosing a
connection type fills in a default label. This is deliberately a small, fixed vocabulary, not a
protocol taxonomy — if a diagram needs more than these eight words to explain a flow, the label and
the caption are still the right place for that detail.

## Callbacks and back-and-forth

A reply is just another connector, drawn in the other direction and optionally added as its own
Flow step. Marking the return connector's Flow kind as `Callback` gives it a hollow arrowhead, so
the two directions read as distinct even before the parallel-lane routing (which keeps them from
overlapping) or the arrow direction is noticed:

```
1. Client → API         "Place order"
2. API → Payment        "Authorize"
3. Payment → API        "Authorization result"
4. API → Client          "Order confirmed"
```

Presentation Mode makes the direction change obvious at each step — a subtle pulse travels along
the active connector — without needing sequence-diagram lifelines.

## Conditions

A connector can carry a free-text condition chip — `[approved]`, `[timeout]`, `[retry exhausted]`
— shown as a small tag near its label. Conditions are display-only: nothing is evaluated, and nothing
executes. Branching is handled the simple way — two Flows that share their early steps and diverge
where the condition differs, rather than a decision-diamond node:

```
Checkout / Happy path      1 → 2 → 3 → 4 → 7
Checkout / Declined        1 → 2 → 3 → 5 → 6
```

## What this isn't

Flows are a communication layer, not a modeling language. There's no expression evaluator, no
executable conditions, no simulation, and no formal message schema — and no plan to add any. If a
diagram starts feeling like it needs BPMN gateways or UML lifelines to explain, that's a sign to
simplify the Flow, not to add ceremony to the tool.

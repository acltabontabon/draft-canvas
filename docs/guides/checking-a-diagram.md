# Checking a diagram

Draft Canvas checks a diagram by reading it: what the drawing itself says is unfinished or
tangled, whether the evidence it cites still holds, and whether your own rules do. Nothing here
changes a diagram, and none of it asks a model.

## In the editor

When the drawing has something to say, the status bar shows a count, such as **2 to check**. Click
it, or choose **Check this diagram** from the command palette (`⌘K`), to open the list.

- Each row is one finding, in every view of the file: a queue nothing consumes, a database two
  services write, services that call each other in a loop, connectors that lead nowhere.
- Click a row to go to the shape or connector it is about, into another view if that is where it is.
- A finding is something to look at, not a verdict. Change the diagram and the list follows; a
  diagram with nothing to report shows no count at all.

The list reads the drawing alone. It is never saved with the diagram, shared, exported or undone.
Evidence and your own rules are checked from the command line, where there is a repository to
hold them against.

## From the command line

`draftcanvas` is the headless side of Draft Canvas: a command-line tool that reads `.draftcanvas`
files with the same code the editor uses and tells you what it finds. It never changes a diagram,
has no network code and runs no other program, so it is safe to point at a checkout in CI.

It is one file that runs on Node 20 or later. Each release attaches it as
`Draft-Canvas_<version>_cli.mjs`, listed in the release's `SHA256SUMS.txt` and covered by the same
build attestation as the installers:

```bash
gh release download v2.0.0 --repo acltabontabon/draft-canvas --pattern 'Draft-Canvas_2.0.0_cli.mjs'
gh attestation verify Draft-Canvas_2.0.0_cli.mjs --repo acltabontabon/draft-canvas
node Draft-Canvas_2.0.0_cli.mjs --help
```

Or build it from this repository with `npm run cli:build`, which writes `dist-cli/draftcanvas.mjs`.

The examples below call it `draftcanvas`.

## What a diagram says

```bash
draftcanvas inspect orders.draftcanvas
```

`inspect` prints the architecture the diagram describes: every part, what it is, the boundaries
around it and what connects to what, in every view. `--json` gives the same as data.

A Junction is not a part. `A → Junction → B` is read as one relation from A to B, and a relation a
Junction divides says so. A connector that ends at a linked Junction ("continues at A") carries on
from the Junction's counterpart, in the same view or another, so the two halves are one relation.
One whose counterpart is not drawn yet is left out, and is not an error.

## Checking it

```bash
draftcanvas check orders.draftcanvas
draftcanvas check orders.draftcanvas --repo .
```

Without `--repo`, `check` reads the drawing alone and reports what the diagram itself says is
unfinished or tangled: a queue nothing consumes, a database two services write, services that call
each other in a loop, connectors that lead nowhere.

With `--repo`, it also holds the diagram's [evidence](#evidence) against the files in that folder.

Each finding has a class that says how much is actually known:

| Class | Means |
| --- | --- |
| `drift` | The diagram and its evidence disagree, and what was read is enough to say so |
| `potential-drift` | They may disagree; someone has to look |
| `stale` | The evidence is still there but is not where it was |
| `ambiguous` | More than one reading fits, so none was chosen |
| `unsupported` | The evidence is of a kind or size that is not read |
| `tool-error` | The check could not finish. An incomplete read is never reported as drift |
| `advisory` | A pattern in the diagram a reader will want to know about |

A finding also has a severity: `error`, `warning` or `info`. `check` exits with `1` when a finding
reaches `--fail-on`, which is `error` unless you say otherwise; `--fail-on never` always exits `0`.

`--json` prints a report with a `schema` field (`draftcanvas.check/1`) and a stable `id` on every
finding, so a script can tell a new finding from one it has seen.

## Evidence

A shape or connector can cite where it comes from in a repository: a file, and optionally a name
in that file and a line. An agent connected over MCP records evidence when it draws from code;
see [Bring your own agent](connect-an-ai-agent.md).

`check --repo` reads each cited file and reports:

- A file that is gone. If one file of the same name exists elsewhere, it is offered as where the
  file may have moved; if several do, none is picked.
- A name that is no longer in the file, matched as a whole word.
- A name or a line that has moved within the file.

What this can claim is deliberately narrow. A name found in a file means the reference is intact.
It does not mean the code calls or implements anything, and nothing here says a relationship is
verified. Evidence marked as inferred never fails a check with an error.

### Docker Compose

When a part of the diagram cites a Compose file, or is named exactly as one of its services,
`check --repo` also compares the two:

- A service the file declares that no part is named for.
- A `depends_on` between two drawn parts with nothing drawn between them.

Both are `potential-drift` and never fail a check: a Compose file is one setup, not the
architecture. A Compose file the diagram does not claim is ignored. The file is parsed, never run:
no variable is expanded and no `include` or `extends` is followed.

## Your own rules

Put a `draftcanvas.json` at the top of the repository (or name one with `--config`) to check rules
of your own:

```json
{
  "version": 1,
  "rules": [
    { "id": "clients-use-the-gateway", "type": "must-go-through",
      "from": { "kind": "actor" }, "to": { "kind": "api" }, "via": { "kind": "gateway" } },
    { "id": "payments-owns-its-data", "type": "must-not-depend",
      "from": { "boundary": "Orders" }, "to": { "boundary": "Payments", "kind": "database" },
      "because": "ADR 12" },
    { "id": "one-writer", "type": "no-shared-store", "severity": "warning" }
  ],
  "waivers": [
    { "finding": "3f2a9c0e51b7d844", "reason": "Until the read model ships", "expires": "2027-06-30" }
  ]
}
```

| Rule | Holds when |
| --- | --- |
| `must-not-depend` | Nothing in `from` has a relation to anything in `to`; with `"transitive": true`, none reaches it at any distance |
| `must-go-through` | No relation joins `from` and `to` directly: one end is always something in `via` |
| `no-cycle` | The parts in `among` (all of them, if left out) form no loop |
| `no-shared-store` | No data store in `store` (all, if left out) is written by more than one part |
| `crossing-only-via` | Every relation across the named `boundary` has something in `via` at one end |
| `must-have` | Every part in `of` has what `require` names: `technology`, `description`, `evidence` or `boundary` |

A selector picks parts by `kind` (a shape type such as `service`, or a kind such as `gateway`,
`api` or `cache`), `name` and `boundary` (`*` stands for anything), `technology`, and `scope`
(`internal` or `external`). Every field given must match.

- A broken rule is a `violation`, at the rule's `severity` (`error` unless it says otherwise).
- A rule that matches nothing says so, so a misspelt name does not pass for ever.
- Rules are data. There is no expression language and nothing in a rule file is run; a file with
  an unknown field or rule type is refused.
- A waiver sets one finding aside by its `id`, must give a `reason`, and may expire. After its last
  day the finding is reported again, along with the waiver. A waiver for something no longer found
  is reported too.

Rules live beside the code, not in the diagram, so they are reviewed like code. In CI on a pull
request, read the rule file from the base branch with `--config`: a file from the branch under
review could waive what it introduces.

## What a change would touch

```bash
draftcanvas impact orders.draftcanvas "Orders API"
```

`impact` takes a part's id or its label and lists what its work reaches, what reaches it, the
boundaries its connectors cross, what it shares with other parts, the flows that run over it, and
what the [outage walk](outage.md) says fails if it stops.

All of it is read from the drawing: what is drawn as connected, not what was measured. Where the
drawing says nothing, so does `impact`.

## What changed

```bash
draftcanvas diff before.draftcanvas after.draftcanvas
```

`diff` reports three things:

- **What changed in the file**, element by element, matched by id as
  [history](history.md#compare-two-versions) does. Moves and restyles are included.
- **What changed in the architecture**, as statements: a part added or removed, a relation that
  became asynchronous, a data store that gained a user, a relation that now crosses a boundary. A
  diagram that was only rearranged says so. A diagram drawn again with new ids is still read as
  the same parts when their names and places make that unambiguous.
- **Findings** the change introduced or resolved.

## Reviewing a pull request

```bash
draftcanvas review --base origin/main --output review.md
```

`review` compares every diagram in the repository with the same file at the base revision and
writes Markdown: per diagram, what changed in the architecture and which findings the change
brought in or settled. Diagrams that did not change are left out. It exits `1` when a new finding
reaches `--fail-on`.

- The base revision is read from the repository's own history with a Git library. No `git`
  program runs, so no hook, filter or setting in the repository takes part, and nothing is fetched:
  in CI, fetch the base branch before the review.
- Every name in the report is escaped. A label in a diagram from a fork cannot add a link, an
  image, a mention or markup to the page.
- Run it in the main checkout. A linked worktree or a submodule keeps its history elsewhere, and
  `review` will not follow that.

### As a GitHub Action

```yaml
on: pull_request
permissions:
  contents: read
jobs:
  architecture:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the base revision has to be in the checkout
      - uses: acltabontabon/draft-canvas@v2.0.0
```

The action downloads the command-line tool attached to the release it is pinned to, checks it
against that release's checksum and build attestation, runs `review` against the pull request's
base commit and writes the report to the job summary. It fails the step when a new finding
reaches `fail-on` (`error` unless you say otherwise).

| Input | Default | |
| --- | --- | --- |
| `version` | the tag the action is pinned to | The release whose tool to use, such as `v2.0.0` |
| `base` | the pull request's base commit | The revision to compare with |
| `repo` | `.` | The checked-out repository |
| `fail-on` | `error` | `error`, `warning`, `info` or `never` |
| `cli-path` | | An already-built `draftcanvas.mjs` to use instead of downloading one |

- Use the `pull_request` event with read permissions. The action runs nothing from the repository
  under review, so a pull request from a fork is safe to review; it needs no secrets.
- The only thing that leaves the runner is the download of the release file. No diagram, finding or
  file from your repository is sent anywhere; the report stays in the job summary.
- Pin it to a release tag, or to a commit with `version` set, so the tool it runs cannot change
  under you.

## A picture

```bash
draftcanvas render orders.draftcanvas --output orders.svg --theme light
```

`render` writes SVG; `--view` takes the ids of the shapes that own a view, joined with `/`.

The same file gives the same bytes on every machine. With no browser to measure text, `render`
uses a fixed table of character widths, so where long text wraps can differ slightly from the
editor; shapes and connectors are where the file says.

## Exit codes

| Code | Means |
| --- | --- |
| `0` | It ran, and nothing reached the threshold |
| `1` | `check` found something at or above `--fail-on` |
| `2` | The input was wrong: an unknown option, a file that is not a diagram |
| `3` | It could not finish: a folder that can't be opened, an output that can't be written |

## What it will not do

- Read outside the folder `--repo` names, or follow a link that leads out of it.
- Read a file over 2 MB or one that is not text, or list more than 50,000 files. It says when it
  stopped at a limit.
- Print the contents of a file. Findings carry paths, names and line numbers only.
- Write anything but the file `--output` names, and never over the diagram.

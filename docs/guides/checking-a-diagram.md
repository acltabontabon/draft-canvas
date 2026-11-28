# Checking a diagram

`draftcanvas` is the headless side of Draft Canvas: a command-line tool that reads `.draftcanvas`
files with the same code the editor uses and tells you what it finds. It never changes a diagram,
has no network code and runs no other program, so it is safe to point at a checkout in CI.

It is built from this repository and is not published as a package yet:

```bash
npm run cli:build
node dist-cli/draftcanvas.mjs --help
```

The examples below call it `draftcanvas`.

## What a diagram says

```bash
draftcanvas inspect orders.draftcanvas
```

`inspect` prints the architecture the diagram describes: every part, what it is, the boundaries
around it and what connects to what, in every view. `--json` gives the same as data.

A Junction is not a part. `A → Junction → B` is read as one relation from A to B, and a relation a
Junction divides says so. A connector that ends at a linked Junction ("continues at A") is left
as it is drawn: the link is a way to travel, not a relationship.

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

## What changed

```bash
draftcanvas diff before.draftcanvas after.draftcanvas
```

`diff` lists what changed between two versions in the diagram's own terms (parts added, connectors
changed, shapes moved between views), matched by id as [history](history.md#compare-two-versions) does, and the
findings the change introduced or resolved.

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

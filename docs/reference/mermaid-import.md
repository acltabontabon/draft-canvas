# Mermaid import

Draft Canvas imports Mermaid `flowchart`, `graph` and `sequenceDiagram`, and lays the result out
itself. To import, see [saving and sharing](../guides/saving-and-sharing.md#importing-a-mermaid-flowchart).

## Supported syntax

| Mermaid | Draft Canvas |
| --- | --- |
| `[text]`, `(text)`, `([text])`, `>text]`, `[/text/]`, `[\text\]` and the trapezoids | Service |
| `[(text)]` cylinder | Data Store |
| `[[text]]` subroutine | Queue |
| `((text))`, `(((text)))` circle | Person (an actor) |
| `{text}`, `{{text}}` decision | Junction, carrying the text |
| `-->`, `==>`, and their longer spellings | Connector |
| `---` (no head) | Undirected connector |
| `-.->` dotted | Asynchronous connector |
| `-->\|label\|`, `-- label -->`, `-. label .->`, `== label ==>` | Connector label |
| `A --> B --> C`, `A & B --> C` | Each arrow in the chain or fan |
| Two or more arrows from the same shape to the same shape | One connector: labels joined with ` / `, solid and headed if any of them was; listed in the notice |
| `subgraph id [Title] … end`, nested | Boundary, nested |
| `TD`/`TB` and `LR` | The reading direction of the layout |
| `"quoted"` labels, `<br>` line breaks, `#quot;`-style entities | The text, as Mermaid shows it |
| `%%` comments, a ```` ```mermaid ```` fence in Markdown | Ignored and unwrapped; in a file with several, the first flowchart is read |

## Skipped syntax

The import notice lists unsupported directives. Styling (`classDef`, `class`, `:::class`,
`style`, `linkStyle`), `click`, accessibility metadata, subgraph directions and invisible `~~~`
links are skipped. Arrows to subgraphs are skipped too.

- `@{ shape: … }` nodes become plain shapes.
- Circle and cross arrowheads become plain arrows; two-headed arrows become one-way.
- `RL` and `BT` become left-to-right and top-to-bottom.
- HTML tags and control characters in labels are removed.
- An arrow from a shape to itself is left out and listed as not drawn.
- Subgraphs nested more than 32 deep keep their shapes in the 32nd boundary; the notice says so.
- A title longer than 200 characters (from the file name or front matter) is shortened, and a file
  with no title is named "Imported diagram".
- A layout that cannot be arranged readably is refused in plain words, with no element ids.
- Other diagram kinds, including `classDiagram` and `stateDiagram`, are refused.

## Sequence diagrams

A `sequenceDiagram` becomes one [sequence](../guides/sequence-diagrams.md). Nothing is inferred:
work starts and ends only where the text says so.

| Mermaid | Sequence |
| --- | --- |
| `participant A`, `participant A as Name` | Participant (a Service) |
| `actor A` | Participant (an Actor) |
| `A->>B`, `A->B` | Call |
| `A-)B`, `A--)B` | Asynchronous message |
| `A-->>B`, `A-->B` | Reply, answering the latest unanswered call between the two |
| `+` / `-` after the arrow, `activate` / `deactivate` beside a message | Work starts on the receiver / ends on the sender |
| `create participant B` then a message to it | Create |
| `destroy B` then a message | Destroy |
| `Note over A,B`, `Note left of A`, `Note right of A` | Note |
| `box Name … end` | Participant group |
| `box Aqua Name`, `box rgb(…) Name` | Participant group named what follows the colour, as Mermaid reads it: a first word only when a browser takes it for a colour (`box Bluebird Team` keeps both words). The colour is not kept |
| `alt`/`else`, `opt`, `loop`, `par`/`and` (and `par_over`), `critical`/`option`, `break` | Frame, with its branches and conditions |
| `title` or `title:`, in the diagram or its front matter | The sequence's name |
| `;` between statements (`A->>B: hi; B-->>A: ok`) | Two statements, as Mermaid reads them, even within a message's words or quotes; the `;` of an entity code (`#59;`) is text |
| A line, or a statement after a `;`, that starts with `%%` | A comment to the end of the line, ignored; a `%%` later in a statement is text, as Mermaid reads it |

Listed in the import notice and not drawn: `autonumber`, a `rect` background (what is inside it is
kept), `link`/`links`/`properties` on a participant, `activate`/`deactivate` with no message beside
it, lines it cannot read, and a second `sequenceDiagram` in the same text (everything from it on). A two-way arrow (`<<->>`) is drawn as one call, a lost message
(`-x`) as a call, and a message with a circle where it meets a lifeline (`A->>()B`, `A()->>B`) as
an ordinary message. A sequence holds at most 40 participants and 600 messages, notes and frames.

## Limits

| Item | Maximum |
| --- | --- |
| Input text | 512 KB |
| Shapes | 300 |
| Arrows | 600 |
| Subgraphs | 60 |
| Shape labels | 120 characters |
| Arrow / subgraph labels | 80 characters |

Long labels are shortened, and a bracketed label over 600 characters is not read. Input over the
other limits is refused before layout.

# Mermaid import

For the import workflow, see [saving and sharing](../guides/saving-and-sharing.md#importing-a-mermaid-flowchart).
Draft Canvas accepts Mermaid `flowchart` and `graph`; it lays out the result itself.

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
| `subgraph id [Title] … end`, nested | Boundary, nested |
| `TD`/`TB` and `LR` | The reading direction of the layout |
| `"quoted"` labels, `<br>` line breaks, `#quot;`-style entities | The text, as Mermaid shows it |
| `%%` comments, a ```` ```mermaid ```` fence in Markdown | Ignored and unwrapped |

## Skipped syntax

The import notice lists unsupported directives. Styling (`classDef`, `class`, `:::class`,
`style`, `linkStyle`), `click`, accessibility metadata, subgraph directions and invisible `~~~`
links are skipped. Arrows to subgraphs are skipped too.

- `@{ shape: … }` nodes become plain shapes.
- Circle and cross arrowheads become plain arrows; two-headed arrows become one-way.
- `RL` and `BT` become left-to-right and top-to-bottom.
- HTML tags in labels are removed.
- Other diagram kinds, including `sequenceDiagram` and `classDiagram`, are refused.

## Limits

| Item | Maximum |
| --- | --- |
| Input text | 512 KB |
| Shapes | 300 |
| Arrows | 600 |
| Subgraphs | 60 |
| Shape labels | 120 characters |
| Arrow / subgraph labels | 80 characters |

Long labels are shortened. Inputs exceeding the other limits are refused before layout.

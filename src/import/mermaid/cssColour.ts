/**
 * Whether a browser takes a word, or an `rgb()`/`hsl()`, for a CSS colour: what Mermaid asks
 * (`CSS.supports('color', …)`) before it reads a box's first word as the box's colour. Worked out
 * here without a DOM, so the agent worker reads a box as the page does. Every word below is a colour
 * to Chromium, WebKit and jsdom, in any case, and words like `none`, `auto` or `text` are not.
 */

const WORDS = new Set(
  [
    // The named colours.
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown',
    'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan',
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid',
    'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet',
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro',
    'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki',
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow',
    'lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray',
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine',
    'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise',
    'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab',
    'orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru',
    'pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown',
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan',
    'teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen',
    'transparent currentcolor',
    // The system colours, the deprecated ones included: `box Background jobs` is a box named "jobs".
    'accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas canvastext field',
    'fieldtext graytext highlight highlighttext linktext mark marktext selecteditem selecteditemtext',
    'visitedtext activeborder activecaption appworkspace background buttonhighlight buttonshadow',
    'captiontext inactiveborder inactivecaption inactivecaptiontext infobackground infotext menu menutext',
    'scrollbar threeddarkshadow threedface threedhighlight threedlightshadow threedshadow window',
    'windowframe windowtext',
    // Valid for every property, so for a colour too: `box Initial checks` is a box named "checks".
    'inherit initial unset revert',
  ]
    .join(' ')
    .split(' '),
);

/** A CSS number: `1`, `-0.5`, `.5`, `1e2`, never `1.`. */
const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?`;
const PERCENT = `${NUMBER}%`;
const AMOUNT = `${NUMBER}%?`;
const HUE = `${NUMBER}(?:deg|grad|rad|turn)?`;
/** `(1, 2, 3)` with an optional fourth, the alpha. */
const commas = (first: string, rest: string): string => String.raw`\(\s*${first}\s*,\s*${rest}\s*,\s*${rest}\s*(?:,\s*${AMOUNT}\s*)?\)`;
/** `(1 2 3 / 50%)`, where any part may be `none`. */
const spaces = (first: string, rest: string): string =>
  String.raw`\(\s*(?:${first}|none)\s+(?:${rest}|none)\s+(?:${rest}|none)\s*(?:\/\s*(?:${AMOUNT}|none)\s*)?\)`;
/**
 * `rgb()`/`rgba()` and `hsl()`/`hsla()` as CSS Color 4 writes them. With commas, an `rgb()` is all
 * numbers or all percentages and an `hsl()` takes percentages; without, either. What is built from
 * `calc()`, `var()` or another colour is not followed, and is read as words.
 */
const FUNCTION = new RegExp(String.raw`^(?:rgba?(?:${commas(NUMBER, NUMBER)}|${commas(PERCENT, PERCENT)}|${spaces(AMOUNT, AMOUNT)})|hsla?(?:${commas(HUE, PERCENT)}|${spaces(HUE, AMOUNT)}))$`, 'i');

export function isCssColour(text: string): boolean {
  return WORDS.has(text.toLowerCase()) || FUNCTION.test(text);
}

// Reveal the original charcoal pixels along their drawn contours, rather than drawing a
// cleaner replacement on top. Coordinates follow the 1672 × 941 source illustration.
const STROKES = [
  // Table, board, and architecture: long pencil gestures, then the smaller connections.
  [0, 850, 15, 'M274 568Q860 584 1572 581'],
  [100, 1000, 16, 'M494 480L490 99L1273 98L1274 365'],
  [400, 420, 14, 'M588 149L649 149L650 194L587 194Z'],
  [600, 550, 16, 'M1006 168Q1042 161 1087 165L1088 224L1006 223Z'],
  [800, 620, 17, 'M747 277Q746 265 761 265L879 265Q892 265 893 280L892 332Q890 344 877 344L757 344Q744 343 744 328Z'],
  [900, 600, 14, 'M652 170H747Q779 170 779 204V264'],
  [1050, 600, 14, 'M627 196V245Q627 253 638 253H658M686 243V292Q686 303 700 303H743'],
  [1100, 550, 14, 'M1006 199H873Q854 199 854 219V265'],
  [1200, 500, 14, 'M894 303H976Q998 303 998 324V372'],
  [1250, 480, 16, 'M960 386C957 363 1047 365 1047 386C1047 405 960 404 960 386L960 455C960 475 1047 475 1047 455V386'],
  [1400, 400, 14, 'M960 418C975 437 1036 434 1047 419'],
  [1300, 450, 14, 'M698 410L783 410L783 485L698 485Z'],
  [1450, 500, 14, 'M810 345V438Q810 450 795 450H783M810 345V389Q810 403 828 403H960'],
  [1500, 550, 14, 'M1047 224V318Q1047 338 1065 338H1084M1115 313L1185 313L1185 348L1115 348Z'],
  [1650, 500, 14, 'M1151 349V437Q1151 449 1136 449H1047'],
  // The standing person, including the hand at the board.
  [1300, 850, 18, 'M546 269C553 213 482 210 447 245C409 279 437 330 475 330C514 331 547 309 546 269Z'],
  [1700, 950, 19, 'M361 478C378 430 393 367 429 343C465 322 515 344 574 359L614 301Q623 270 662 253L650 271Q659 262 660 270L647 294L633 305L610 363Q599 386 583 401'],
  [1850, 700, 17, 'M371 566Q388 516 402 481L430 405M505 388L491 456'],
  [1950, 160, 12, 'M535 263L537 272'],
  [2000, 240, 12, 'M576 266L587 250M585 276L600 269M587 285L599 287'],
  // Seated person, shoulder, hands, and laptop.
  [2100, 700, 19, 'M620 473C653 431 644 386 606 392C563 396 544 424 535 455L498 503Q464 530 450 571'],
  [2350, 730, 20, 'M619 475Q610 499 579 506Q543 487 516 510Q483 537 481 575M578 507Q628 504 658 548L681 580'],
  [2450, 350, 16, 'M636 546Q657 539 679 559L693 581M650 565Q670 555 688 575M615 436L616 443'],
  [2500, 580, 17, 'M694 581L735 517L833 515L808 582Z'],
  // The person listening at the right.
  [2500, 700, 18, 'M1320 401C1290 344 1216 361 1212 405C1206 454 1243 484 1284 471C1321 464 1333 434 1320 401Z'],
  [2750, 430, 14, 'M1213 408Q1197 396 1204 421Q1210 429 1215 416L1263 432M1227 415L1233 417'],
  [2850, 650, 19, 'M1149 580L1173 509Q1177 483 1194 477Q1220 474 1222 489Q1214 504 1204 504L1197 526M1204 506Q1231 482 1260 486Q1334 482 1371 581'],
  // Cursor gestures, then Nodi's stepped silhouette and screen.
  [2900, 350, 15, 'M670 212L696 235L682 236L678 249Z'],
  [3050, 280, 13, 'M669 199L664 190M684 199L690 184M696 208L706 203'],
  [3100, 350, 15, 'M1089 339L1116 364L1100 364L1096 378Z'],
  [3200, 240, 13, 'M1084 326L1078 317M1098 321L1099 302M1111 327L1122 316'],
  [3150, 700, 22, 'M1390 396L1395 378L1533 392L1531 410L1544 411L1543 426L1556 427L1551 482L1538 482L1535 514L1382 497L1383 478L1373 477L1382 396Z'],
  [3350, 650, 22, 'M1404 399L1518 410L1514 433L1532 435L1526 484L1396 473Z'],
  [3450, 500, 22, 'M1418 429L1511 439L1506 475L1409 465Z'],
  [3550, 300, 22, 'M1427 441L1425 459M1491 446L1489 467M1455 469L1470 471'],
  // Original textured mint areas are revealed with short pencil passes, not a block wipe.
  [3500, 500, 26, 'M1410 392L1518 406M1406 408L1515 420M1393 484L1524 497'],
  [3650, 450, 19, 'M1397 509L1458 518L1451 552L1390 544Z'],
  [3800, 330, 19, 'M1413 524L1440 528L1436 545L1409 540Z'],
  [3650, 430, 18, 'M1386 490L1355 468L1341 459M1335 446L1353 453L1351 472L1334 467Z'],
  [3900, 360, 18, 'M1514 541L1531 544L1527 565L1510 562ZM1411 554L1406 575L1391 572M1464 555L1468 577L1481 579'],
  [4050, 220, 14, 'M1380 365L1370 349M1354 376L1338 367'],
];

const NS = 'http://www.w3.org/2000/svg';
const element = (name, attributes) => {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
};

export function setUpSketchDrawing(art, reduced) {
  const original = art.querySelector('.conversation-art');
  const plate = art.querySelector('.art-plate');
  const replay = art.querySelector('.replay-drawing');
  let drawing = null;
  let animations = [];
  let generation = 0;

  function finish() {
    generation += 1;
    original.style.removeProperty('opacity');
    drawing?.remove();
    drawing = null;
    for (const animation of animations) animation.cancel();
    animations = [];
    delete art.dataset.drawing;
    replay.textContent = 'Draw again ↺';
    replay.setAttribute('aria-label', 'Replay the charcoal sketch drawing');
  }

  async function play() {
    finish();
    if (reduced.matches) return;
    const run = generation;
    try { await original.decode(); } catch { return; }
    if (run !== generation || reduced.matches) return;
    const svg = element('svg', { viewBox: '0 0 1672 941', class: 'sketch-drawing', 'aria-hidden': 'true' });
    const defs = element('defs', {});
    const mask = element('mask', { id: 'charcoal-strokes', maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 1672, height: 941 });
    const paths = STROKES.map(([delay, duration, width, d]) => {
      const path = element('path', { d, fill: 'none', stroke: 'white', 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', pathLength: 1, 'stroke-dasharray': 1, 'stroke-dashoffset': 1, opacity: 0 });
      mask.append(path);
      return { path, delay, duration };
    });
    defs.append(mask);
    svg.append(defs, element('image', { href: original.currentSrc || original.src, width: 1672, height: 941, mask: 'url(#charcoal-strokes)' }));
    drawing = svg;
    plate.insertBefore(svg, original.nextSibling);
    original.style.opacity = '0';
    art.dataset.drawing = 'architecture';
    replay.textContent = 'Finish drawing →';
    replay.setAttribute('aria-label', 'Show the completed charcoal sketch');
    animations = paths.map(({ path, delay, duration }) => path.animate(
      [{ strokeDashoffset: 1, opacity: 0 }, { strokeDashoffset: .999, opacity: 1, offset: .001 }, { strokeDashoffset: 0, opacity: 1 }],
      { delay, duration, easing: 'linear', fill: 'both' },
    ));
    for (const [index, phase] of [[14, 'people'], [29, 'nodi']]) {
      animations[index].finished.then(() => {
        if (run === generation) art.dataset.drawing = phase;
      }).catch(() => {});
    }
    // The final static plate restores the fine grain outside the stroke masks without
    // replacing the artwork. Cancellation/replay must never finish a newer drawing.
    Promise.all(animations.map((animation) => animation.finished)).then(() => {
      if (run === generation) finish();
    }).catch(() => {});
  }

  replay.hidden = false;
  replay.textContent = 'Draw again ↺';
  replay.setAttribute('aria-label', 'Replay the charcoal sketch drawing');
  replay.addEventListener('click', () => drawing ? finish() : play());
  reduced.addEventListener('change', () => { if (reduced.matches) finish(); });
  if (!reduced.matches && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      play();
    }, { threshold: .25 });
    observer.observe(art);
  }
}

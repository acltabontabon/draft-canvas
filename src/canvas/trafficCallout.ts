import { displayNameFor } from '../document/factory';
import type { DraftNode } from '../document/types';
import { fitLabel, layoutText } from '../render/text/layout';
import { impactOf, type TrafficAnalysis } from '../traffic';
import type { Rect } from '../traffic/sketchLayout';
import { pathsLabel } from './trafficLabels';

interface Text {
  text: string;
  lines: string[];
  height: number;
}

interface Section {
  label: string;
  detail?: Text;
  items: Text[];
  more: number;
  tone: 'caution' | 'quiet' | 'safe';
}

const WIDTH = 300;

function textOf(text: string, width: number, size = 13, weight: 400 | 600 = 400, maxLines = 2): Text {
  const layout = layoutText(text, { font: { stack: 'sans', size, weight }, maxWidth: width, lineHeight: size === 11 ? 16 : 18, maxLines });
  return { text, lines: layout.lines.map((line) => line.text), height: layout.height };
}

/** A field note: keep the count, its sources and its consequences visually distinct. */
export function trafficCalloutFor(analysis: TrafficAnalysis, nodes: readonly DraftNode[], id: string, obstacles: readonly Rect[], availableWidth = WIDTH) {
  const node = nodes.find((item) => item.id === id);
  if (!node) return null;
  const width = Math.min(WIDTH, availableWidth);
  // A thin native scrollbar can occupy layout space on Windows/Linux. Keep a gutter in the
  // measured lines even on platforms with overlay scrollbars, so scrolling never clips them.
  const inner = width - 46;
  const index = new Map(nodes.map((item) => [item.id, item]));
  const name = (id: string) => {
    const found = index.get(id);
    return found ? displayNameFor(found) : 'Untitled';
  };
  const result = analysis.nodes.get(id);
  const sections: Section[] = [];
  const sources: { name: Text; count: string }[] = [];
  let moreSources = 0;
  let metric = '';
  let summary: Text | undefined;
  const add = (label: string, ids: string[], tone: Section['tone'], detail?: string) => {
    if (ids.length === 0) return;
    sections.push({ label, tone, detail: detail ? textOf(detail, inner, 11) : undefined, items: ids.slice(0, 3).map((id) => textOf(name(id), inner)), more: Math.max(0, ids.length - 3) });
  };

  if (!result || result.role === 'excluded') {
    metric = 'Outside runtime';
    summary = textOf('Traffic stops here. This shape is not a runtime resource.', inner);
  } else if (result.role === 'junction') {
    const routes = analysis.interactions.filter((item) => item.junctionIds.includes(id) && item.paths.possible > 0).length;
    metric = `${routes} ${routes === 1 ? 'route' : 'routes'}`;
    summary = textOf('Passes traffic through; adds no paths of its own.', inner);
  } else {
    metric = result.paths.possible === 0 ? 'No paths' : pathsLabel(result.paths);
    if (result.role === 'origin') summary = textOf('Traffic starts here.', inner);
    else if (result.paths.possible === 0) summary = textOf('No counted path reaches this shape.', inner);
    else {
      const incoming = analysis.interactions.filter((item) => item.to === id && item.paths.possible > 0).sort((a, b) => b.paths.possible - a.paths.possible);
      // Several connector classes can arrive from one source. Keep their counts separate rather
      // than suggesting they were summed into a different path total.
      for (const interaction of incoming.slice(0, 3)) sources.push({ name: textOf(name(interaction.from), inner - 88), count: pathsLabel(interaction.paths) });
      moreSources = Math.max(0, incoming.length - 3);
    }
    const impact = impactOf(analysis, id);
    const journeys = impact.journeys.filter((entry) => entry !== id);
    const samePeople = impact.waiting.length > 0 && impact.waiting.length === journeys.length && impact.waiting.every((entry) => journeys.includes(entry));
    if (samePeople) add('If it goes down', impact.waiting, 'caution', 'Calls wait · journeys stall');
    else {
      add('Calls waiting', impact.waiting, 'caution', 'If this shape is slow or down');
      if (result.role !== 'origin') add('Journeys stalled', journeys, 'caution');
    }
    add('Waits on', impact.dependsOn, 'quiet');
    add('May wait on', impact.mayDependOn, 'quiet');
    add('Behind a queue', impact.decoupled, 'safe', 'Can lag without holding this up');
  }

  const title = textOf(displayNameFor(node), inner - 62, 13, 600);
  const hero = fitLabel(metric, { font: { stack: 'hand', size: 32, weight: 700 }, minFontSize: 18, maxWidth: inner, maxHeight: 40, lineHeightRatio: 1.25, maxLines: 1 });
  // These are the same line boxes, section gaps and padding rendered by TrafficSketches. Keeping
  // them measured keeps the note clear of its neighbours when names wrap.
  const height = 30 + title.height + 2 + 40
    + (summary ? summary.height + 6 : 0)
    + (sources.length > 0 ? 6 + sources.reduce((sum, source) => sum + source.name.height, 0) : 0)
    + (moreSources > 0 ? 18 : 0)
    + sections.reduce((sum, section) => sum + 32 + (section.detail ? section.detail.height + 4 : 0) + section.items.reduce((height, item) => height + item.height, 0) + (section.more > 0 ? 18 : 0), 0);
  const description = [title.text, metric, summary?.text, ...sources.map((source) => `${source.name.text}: ${source.count}`), ...sections.map((section) => `${section.label}. ${section.detail?.text ?? ''} ${section.items.map((item) => item.text).join(', ')}${section.more > 0 ? `, plus ${section.more} more` : ''}`)].filter(Boolean).join('. ');
  return { anchor: node, obstacles: [...nodes.filter((other) => other.id !== id && other.type !== 'group'), ...obstacles], width, height, title, metric: hero.layout.lines[0]?.text ?? metric, metricSize: hero.font.size, summary, sources, moreSources, sections, description };
}

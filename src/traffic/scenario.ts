import { PATH_CAP, type PathCount, type TrafficAnalysis } from './types';

/** A round illustrative input, not a capacity estimate or an observed workload. */
export const DEFAULT_TRAFFIC_RATE = 1000;

export function scenarioRateLabel(paths: PathCount, unit: string): string {
  if (paths.possible >= PATH_CAP) return 'Rate unknown';
  const amount = (count: number) => (count * DEFAULT_TRAFFIC_RATE).toLocaleString('en-US');
  if (paths.definite === paths.possible) return `~${amount(paths.possible)} ${unit}`;
  if (paths.definite === 0) return `0–${amount(paths.possible)} ${unit}`;
  return `${amount(paths.definite)}–${amount(paths.possible)} ${unit}`;
}

/** Rates are a separate reading of the baseline paths. Repeated work in loops has no finite upper
 * bound in the drawing, including downstream, so never multiply its once-counted paths into RPM. */
export function trafficScenario(analysis: TrafficAnalysis): Map<string, string> {
  const unknown = new Set<string>();
  const outgoing = new Map<string, string[]>();
  for (const interaction of analysis.interactions) {
    if (!interaction.workload) continue;
    const targets = outgoing.get(interaction.from) ?? [];
    targets.push(interaction.to);
    outgoing.set(interaction.from, targets);
  }
  for (const node of analysis.nodes.values()) if (node.inLoop) unknown.add(node.id);
  const pending = [...unknown];
  for (let index = 0; index < pending.length; index += 1) {
    for (const target of outgoing.get(pending[index]!) ?? []) {
      if (unknown.has(target)) continue;
      unknown.add(target);
      pending.push(target);
    }
  }
  const labels = new Map<string, string>();
  for (const node of analysis.nodes.values()) {
    if (node.role === 'excluded' || node.role === 'junction') continue;
    if (analysis.truncated || unknown.has(node.id)) {
      labels.set(node.id, 'Rate unknown');
      continue;
    }
    if (node.paths.possible === 0) continue;
    const unit = node.isEntry ? 'starts/min'
      : node.workloads.length !== 1 ? 'arrivals/min'
        : node.workloads[0] === 'request' ? 'calls/min'
          : node.workloads[0] === 'message' ? 'messages/min' : 'data ops/min';
    labels.set(node.id, scenarioRateLabel(node.paths, unit));
  }
  return labels;
}

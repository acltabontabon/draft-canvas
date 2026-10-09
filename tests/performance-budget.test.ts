import { describe, expect, it } from 'vitest';
import { performanceFailures, type LifecycleReport } from '../benchmark/budgets';
import type { InteractionResult } from '../benchmark/interaction/report';

function reports(): { interaction: InteractionResult; lifecycle: LifecycleReport } {
  // Only the fields the gate consumes; the benchmark itself supplies the full measurement report.
  return {
    interaction: { meta: { frameFloorMs: 16.7 }, fixtures: { medium: { nodes: 200, edges: 300 } }, scenarios: ['pan-drag', 'drag-single', 'select-clicks'].map((scenario) => ({
      size: 'medium', scenario, iterations: [{}, {}, {}], problems: [], canvasBroken: false,
      headline: { frameP95: 20, latencyP95: 30, longTaskMaxMs: 80, tailLongTaskMaxMs: 80 },
    })) } as unknown as InteractionResult,
    lifecycle: { load: [{ size: 'medium', loadMs: 600, longestTaskMs: 200, heapMiB: 40 }], exports: ['svg', 'png'].map((kind) => ({ size: 'medium', kind, ms: 400, bytes: 100 })) } as LifecycleReport,
  };
}

describe('performance acceptance', () => {
  it('accepts a complete supported workload and rejects a material frame regression', () => {
    const { interaction, lifecycle } = reports();
    expect(performanceFailures(interaction, lifecycle)).toEqual([]);
    interaction.scenarios[0]!.headline.frameP95 = 90;
    expect(performanceFailures(interaction, lifecycle)).toContain('pan-drag frameP95: 90 exceeds 50 or is invalid');
  });

  it('fails closed for missing, broken, throttled or nonnumeric measurements', () => {
    const { interaction, lifecycle } = reports();
    interaction.scenarios.pop();
    interaction.scenarios[0]!.canvasBroken = true;
    interaction.scenarios[1]!.headline.latencyP95 = NaN;
    interaction.meta.frameFloorMs = 33;
    lifecycle.exports.pop();
    expect(performanceFailures(interaction, lifecycle)).toHaveLength(5);
  });
});

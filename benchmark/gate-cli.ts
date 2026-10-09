import { readFileSync } from 'node:fs';
import { performanceFailures, type LifecycleReport } from './budgets';
import type { InteractionResult } from './interaction/report';

try {
  const interaction = JSON.parse(readFileSync('benchmark/results/interaction.json', 'utf8')) as InteractionResult;
  const lifecycle = JSON.parse(readFileSync('benchmark/results/lifecycle.json', 'utf8')) as LifecycleReport;
  const failures = performanceFailures(interaction, lifecycle);
  if (failures.length) throw new Error(failures.join('\n'));
  console.log('Performance budgets passed for 200 shapes / 300 connectors.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Performance verification failed.');
  process.exitCode = 1;
}

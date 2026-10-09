import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Finding {
  ecosystem: 'npm' | 'cargo';
  id: string;
  package: string;
}
export interface Exception extends Finding {
  reason: string;
  expires: string;
  tracking: string;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** A transport/tool failure is not a clean scan. Reject incomplete reports before checking findings. */
export function findingsOf(ecosystem: Finding['ecosystem'], report: unknown): Finding[] {
  if (!record(report) || report.error) throw new Error('The audit did not return a valid report.');
  const findings: Finding[] = [];
  if (ecosystem === 'npm') {
    if (!record(report.vulnerabilities) || !record(report.metadata)) throw new Error('Incomplete npm audit report.');
    for (const value of Object.values(report.vulnerabilities)) {
      if (!record(value) || !Array.isArray(value.via)) throw new Error('Malformed npm finding.');
      for (const via of value.via) {
        if (typeof via === 'string') continue; // The underlying advisory is listed under its own package.
        if (!record(via)) throw new Error('Malformed npm advisory.');
        if (via.severity !== 'high' && via.severity !== 'critical') continue;
        if (typeof via.url !== 'string' || typeof via.name !== 'string') throw new Error('Incomplete npm advisory.');
        const id = via.url.split('/').at(-1);
        if (!id || !/^GHSA-[\w-]+$/.test(id)) throw new Error('Unrecognized npm advisory id.');
        findings.push({ ecosystem, id, package: via.name });
      }
    }
  } else {
    if (!record(report.vulnerabilities) || !Array.isArray(report.vulnerabilities.list)) throw new Error('Incomplete RustSec audit report.');
    const unsound = record(report.warnings) ? report.warnings.unsound : [];
    if (unsound !== undefined && !Array.isArray(unsound)) throw new Error('Malformed RustSec warning report.');
    for (const value of [...report.vulnerabilities.list, ...(Array.isArray(unsound) ? unsound : [])]) {
      if (!record(value) || !record(value.advisory) || !record(value.package) || typeof value.advisory.id !== 'string' || typeof value.package.name !== 'string') {
        throw new Error('Malformed RustSec advisory.');
      }
      findings.push({ ecosystem, id: value.advisory.id, package: value.package.name });
    }
    if (record(report.warnings) && Array.isArray(report.warnings.yanked) && report.warnings.yanked.length) {
      throw new Error('The Rust lockfile contains yanked dependencies; update them before accepting this scan.');
    }
  }
  return findings.filter((finding, at) => findings.findIndex((other) => other.id === finding.id && other.package === finding.package) === at);
}

export function unaccepted(findings: Finding[], exceptions: Exception[], today = new Date().toISOString().slice(0, 10)): Finding[] {
  for (const entry of exceptions) {
    if (!['npm', 'cargo'].includes(entry.ecosystem) || !entry.id || !entry.package || !entry.reason?.trim() || !entry.tracking?.trim()
      || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires) || !Number.isFinite(Date.parse(entry.expires)) || entry.expires <= today) {
      throw new Error('Advisory exceptions need a package, reason, tracking reference and an unexpired date.');
    }
  }
  return findings.filter((finding) => !exceptions.some((entry) => entry.ecosystem === finding.ecosystem && entry.id === finding.id && entry.package === finding.package));
}

function main(): void {
  const ecosystem = process.argv[2];
  if (ecosystem !== 'npm' && ecosystem !== 'cargo') throw new Error('Usage: tsx scripts/dependency-audit.ts npm|cargo');
  const policyAt = process.argv.indexOf('--policy');
  const exceptions = JSON.parse(readFileSync(policyAt < 0 ? '.github/advisory-exceptions.json' : process.argv[policyAt + 1]!, 'utf8')) as Exception[];
  if (!Array.isArray(exceptions)) throw new Error('Advisory exceptions must be an array.');
  mkdirSync('audit-results', { recursive: true });
  const targets = ecosystem === 'npm' ? ['.', 'www'] : ['.'];
  for (const cwd of targets) {
    const result = spawnSync(ecosystem === 'npm' ? 'npm' : 'cargo', ecosystem === 'npm'
      ? ['audit', '--json'] : ['audit', '--json', '--file', 'src-tauri/Cargo.lock'], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.signal || result.status === null || result.status > 1) throw new Error(`Audit tool failed: ${result.error?.message ?? result.stderr}`);
    const report: unknown = JSON.parse(result.stdout);
    writeFileSync(`audit-results/${ecosystem}-${cwd === '.' ? 'app' : 'site'}.json`, result.stdout);
    const findings = findingsOf(ecosystem, report);
    if (result.status !== 0 && findings.length === 0 && ecosystem === 'cargo') throw new Error(`RustSec scan failed: ${result.stderr}`);
    const blocked = unaccepted(findings, exceptions);
    if (blocked.length) throw new Error(`Unaccepted advisories: ${blocked.map((f) => `${f.id} (${f.package})`).join(', ')}`);
    console.log(`${ecosystem} ${cwd}: no unaccepted ${ecosystem === 'npm' ? 'high/critical' : 'vulnerability'} advisories. Full report retained in audit-results/.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : 'Audit failed.');
    process.exitCode = 1;
  }
}

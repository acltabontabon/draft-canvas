/**
 * Checking a diagram: the one entry the headless CLI, the editor and agents call.
 *
 * `checkDiagram` reads the drawing alone and needs nothing else. Given a reader over a repository
 * the person chose, it also holds the diagram's evidence against what is there. It reads and
 * reports; it never changes the diagram, and nothing it finds is written into it.
 */

import type { DraftDocument } from '../document/types';
import { modelOf } from '../model/model';
import { checkAnchors } from './evidence/anchors';
import { checkCompose } from './evidence/compose';
import type { RepoReader } from './evidence/reader';
import { countBySeverity, finding, sortFindings, type Finding, type Severity } from './finding';
import { builtinFindings } from './rules';

export { builtinFindings } from './rules';
export { impactOf, IMPACT_LIMIT, type Impact, type ImpactOutage, type ImpactReach } from './impact';
export { checkAnchors, linesNaming, type AnchorReport } from './evidence/anchors';
export { checkCompose, composeServices } from './evidence/compose';
export { memoryReader, normalizeRepoPath, REPO_LIMITS, type ReadResult, type RepoLimits, type RepoListing, type RepoReader } from './evidence/reader';
export { countBySeverity, finding, fingerprint, reaches, sortFindings, FINDING_CLASSES, SEVERITIES, type EvidenceRef, type Finding, type FindingClass, type FindingInput, type Severity } from './finding';

export interface CheckOptions {
  /** A repository to hold the diagram's evidence against. Without one, only the drawing is checked. */
  repo?: RepoReader;
}

export interface CheckReport {
  findings: Finding[];
  counts: Record<Severity, number>;
  /** What the check covered, so a clean report can't be mistaken for a wider one. */
  checked: {
    views: number;
    parts: number;
    relations: number;
    /** Evidence entries held against the repository; absent when none was given. */
    evidence?: { cited: number; intact: number };
  };
}

export async function checkDiagram(file: DraftDocument, options: CheckOptions = {}): Promise<CheckReport> {
  const model = modelOf(file);
  const findings = builtinFindings(file, model);
  const checked: CheckReport['checked'] = { views: model.rooms.length, parts: model.entities.size, relations: model.relations.length };

  if (options.repo) {
    try {
      const listing = await options.repo.list();
      if (listing.truncated) {
        findings.push(finding({ rule: 'evidence/incomplete-listing', class: 'tool-error', severity: 'warning', subjects: [], message: 'The repository has more files than are listed, so a file reported as missing may only have moved, and undrawn services may have been missed.' }));
      }
      const anchors = await checkAnchors(file, options.repo, listing);
      findings.push(...anchors.findings, ...(await checkCompose(model, options.repo, listing)));
      checked.evidence = { cited: anchors.checked, intact: anchors.intact };
    } catch (error) {
      // A reader that fails is a failed check, never a drifted diagram.
      findings.push(finding({ rule: 'evidence/reader-failed', class: 'tool-error', severity: 'error', subjects: [], message: `The repository could not be read, so no evidence was checked${error instanceof Error && error.message ? `: ${error.message.slice(0, 200)}` : '.'}` }));
    }
  }

  const sorted = sortFindings(findings);
  return { findings: sorted, counts: countBySeverity(sorted), checked };
}

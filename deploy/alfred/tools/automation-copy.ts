// Pure logic for copying one campaign ("rule") into another workspace.
// No database, no network: add-zernio-workspace.ts feeds it rows and applies
// the result, and __tests__/add-zernio-workspace.test.ts covers it directly.

/** Columns that identify the sample row or are rebuilt for the copy. Everything else is copied as is. */
export const NOT_COPIED_FIELDS = [
  'id',
  'workspaceId',
  'instagramAccountId',
  'createdAt',
  'updatedAt',
  'reportShareSlug',
  'trackedLinks',
] as const;

export interface SampleLink {
  label: string | null;
  destinationUrl: string;
  position: number;
}

export type RuleRow = Record<string, unknown> & {
  name: string;
  reportShareSlug: string | null;
  trackedLinks: SampleLink[];
};

export interface RuleCopy {
  fields: Record<string, unknown>;
  reportShareSlug: string;
  link: { slug: string; label: string | null; destinationUrl: string; position: 0 };
}

export class RuleCopyError extends Error {}

const notCopied = new Set<string>(NOT_COPIED_FIELDS);

export function copiedFields(rule: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(rule).filter(([key]) => !notCopied.has(key)));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  return a === b;
}

/** The sample must have exactly one link: the copy only knows how to redirect one destination. */
export function requireSingleLink(sample: RuleRow): SampleLink {
  if (sample.trackedLinks.length !== 1) {
    throw new RuleCopyError(`Sample rule must have exactly 1 tracked link, found ${sample.trackedLinks.length}`);
  }
  return sample.trackedLinks[0];
}

export function buildRuleCopy({ sample, destinationUrl, generateRuleSlug, generateLinkSlug }: {
  sample: RuleRow;
  destinationUrl: string;
  generateRuleSlug: () => string;
  generateLinkSlug: () => string;
}): RuleCopy {
  const link = requireSingleLink(sample);
  let reportShareSlug = generateRuleSlug();
  while (reportShareSlug === sample.reportShareSlug) reportShareSlug = generateRuleSlug();
  let linkSlug = generateLinkSlug();
  while (linkSlug === reportShareSlug) linkSlug = generateLinkSlug();
  return {
    fields: copiedFields(sample),
    reportShareSlug,
    link: { slug: linkSlug, label: link.label, destinationUrl, position: 0 },
  };
}

/** Names of everything in `candidate` that differs from what a correct copy of `sample` would hold. Empty = in sync. */
export function diffRuleCopy({ sample, candidate, destinationUrl }: {
  sample: RuleRow;
  candidate: RuleRow;
  destinationUrl: string;
}): string[] {
  const diffs: string[] = [];
  const expected = copiedFields(sample);
  const actual = copiedFields(candidate);
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (!sameValue(expected[key], actual[key])) diffs.push(key);
  }
  if (!candidate.reportShareSlug) diffs.push('reportShareSlug (missing)');
  else if (candidate.reportShareSlug === sample.reportShareSlug) diffs.push('reportShareSlug (same as sample)');
  if (candidate.trackedLinks.length !== 1) {
    diffs.push(`trackedLinks (count ${candidate.trackedLinks.length}, expected 1)`);
  } else {
    const [link] = candidate.trackedLinks;
    const sampleLink = requireSingleLink(sample);
    if (link.destinationUrl !== destinationUrl) diffs.push('trackedLinks[0].destinationUrl');
    if (link.label !== sampleLink.label) diffs.push('trackedLinks[0].label');
    if (link.position !== 0) diffs.push('trackedLinks[0].position');
  }
  return diffs;
}

export type RulePlan =
  | { action: 'create' }
  | { action: 'in-sync'; id: string }
  | { action: 'diverged'; id: string; diffs: string[] };

/**
 * Decide what to do about the sample's rule in the target account.
 * `existing` = rules already in the target workspace on the target account.
 * A copy is recognised by name; two rules with that name are ambiguous and stop the run.
 */
export function planRuleCopy({ sample, existing, destinationUrl }: {
  sample: RuleRow;
  existing: Array<RuleRow & { id: string }>;
  destinationUrl: string;
}): RulePlan {
  requireSingleLink(sample);
  const same = existing.filter(rule => rule.name === sample.name);
  if (same.length > 1) throw new RuleCopyError(`Target already has ${same.length} rules named "${sample.name}"; resolve by hand`);
  if (same.length === 0) return { action: 'create' };
  const diffs = diffRuleCopy({ sample, candidate: same[0], destinationUrl });
  return diffs.length === 0 ? { action: 'in-sync', id: same[0].id } : { action: 'diverged', id: same[0].id, diffs };
}

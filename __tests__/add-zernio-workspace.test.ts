import { describe, expect, it } from 'vitest';
import {
  NOT_COPIED_FIELDS,
  RuleCopyError,
  buildRuleCopy,
  copiedFields,
  diffRuleCopy,
  planRuleCopy,
  type RuleRow,
} from '../deploy/alfred/tools/automation-copy';
import { matchRules, type MatchableRule } from '../deploy/alfred/tools/rule-match';

const URL_SYS = 'https://t.me/neuroblagov_bot?start=zadacha_instagram_sys';

function sample(overrides: Record<string, unknown> = {}): RuleRow {
  return {
    id: 'sample-id',
    workspaceId: 'ws-ai',
    instagramAccountId: 'ig-ai',
    name: 'zadacha – задача (все ролики)',
    goal: null,
    postId: null,
    postUrl: null,
    pendingNextReel: false,
    matchAnyPost: true,
    keywords: ['задача', 'zadacha'],
    matchAnyWord: false,
    dmTriggerEnabled: true,
    dmMessage: 'Привет!\nВот ссылка 👇',
    openingDmEnabled: true,
    openingDmMessage: 'Привет',
    openingDmButtonLabel: 'Получить',
    linkButtonLabel: 'Открыть бота',
    requireFollow: true,
    followPromptMessage: 'Подпишись',
    followPromptButtonLabel: 'Подписался',
    followUpEnabled: false,
    followUpMessage: null,
    followUpDelayMinutes: 0,
    publicReplyEnabled: true,
    publicReplyMessage: null,
    publicReplyMessages: ['Отправил в директ', 'Проверь директ'],
    isActive: true,
    wholeWordMatch: true,
    reportShareSlug: 'sample-report-slug',
    reportShareEnabled: true,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    updatedAt: new Date('2026-11-02T00:00:00Z'),
    trackedLinks: [{ label: 'Primary campaign link', destinationUrl: 'https://t.me/neuroblagov_bot?start=zadacha_instagram', position: 0 }],
    ...overrides,
  } as RuleRow;
}

const slugs = () => {
  let n = 0;
  return { generateRuleSlug: () => `rule-slug-${++n}`, generateLinkSlug: () => `link-slug-${++n}` };
};

describe('buildRuleCopy', () => {
  it('copies every field except the identity and rebuilt ones', () => {
    const copy = buildRuleCopy({ sample: sample(), destinationUrl: URL_SYS, ...slugs() });
    for (const key of NOT_COPIED_FIELDS) expect(copy.fields).not.toHaveProperty(key);
    const expected = sample();
    for (const key of Object.keys(expected)) {
      if ((NOT_COPIED_FIELDS as readonly string[]).includes(key)) continue;
      expect(copy.fields[key]).toEqual(expected[key]);
    }
  });

  it('copies a field that was added to the model later without code changes', () => {
    const copy = buildRuleCopy({ sample: sample({ brandNewColumn: 'x' }), destinationUrl: URL_SYS, ...slugs() });
    expect(copy.fields.brandNewColumn).toBe('x');
  });

  it('gives the copy its own report slug and swaps the link destination, keeping label', () => {
    const s = sample();
    const copy = buildRuleCopy({ sample: s, destinationUrl: URL_SYS, ...slugs() });
    expect(copy.reportShareSlug).not.toBe(s.reportShareSlug);
    expect(copy.link).toEqual({ slug: expect.any(String), label: 'Primary campaign link', destinationUrl: URL_SYS, position: 0 });
    expect(copy.link.slug).not.toBe(copy.reportShareSlug);
  });

  it('draws again when the generator returns the sample slug', () => {
    const out = ['sample-report-slug', 'fresh'];
    const copy = buildRuleCopy({ sample: sample(), destinationUrl: URL_SYS, generateRuleSlug: () => out.shift()!, generateLinkSlug: () => 'l1' });
    expect(copy.reportShareSlug).toBe('fresh');
  });

  it.each([0, 2])('refuses a sample with %i links', count => {
    const link = { label: 'x', destinationUrl: 'https://example.com', position: 0 };
    const s = sample({ trackedLinks: Array.from({ length: count }, (_, i) => ({ ...link, position: i })) });
    expect(() => buildRuleCopy({ sample: s, destinationUrl: URL_SYS, ...slugs() })).toThrow(RuleCopyError);
  });

  it('does not mutate the sample', () => {
    const s = sample();
    const before = JSON.stringify(s);
    buildRuleCopy({ sample: s, destinationUrl: URL_SYS, ...slugs() });
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('planRuleCopy', () => {
  function stored(s: RuleRow, patch: Record<string, unknown> = {}) {
    const copy = buildRuleCopy({ sample: s, destinationUrl: URL_SYS, ...slugs() });
    return {
      ...copy.fields,
      id: 'copy-id',
      workspaceId: 'ws-sys',
      instagramAccountId: 'ig-sys',
      reportShareSlug: copy.reportShareSlug,
      trackedLinks: [copy.link],
      createdAt: new Date(),
      updatedAt: new Date(),
      ...patch,
    } as unknown as RuleRow & { id: string };
  }

  it('creates when the target has no rule of that name', () => {
    expect(planRuleCopy({ sample: sample(), existing: [], destinationUrl: URL_SYS })).toEqual({ action: 'create' });
    expect(planRuleCopy({ sample: sample(), existing: [stored(sample(), { name: 'other' })], destinationUrl: URL_SYS })).toEqual({ action: 'create' });
  });

  it('is a no-op when a correct copy exists (second run)', () => {
    const s = sample();
    expect(planRuleCopy({ sample: s, existing: [stored(s)], destinationUrl: URL_SYS })).toEqual({ action: 'in-sync', id: 'copy-id' });
  });

  it('reports every difference instead of overwriting', () => {
    const s = sample();
    const bad = stored(s, { dmMessage: 'changed', keywords: ['задача'], followUpDelayMinutes: 5 });
    const plan = planRuleCopy({ sample: s, existing: [bad], destinationUrl: URL_SYS });
    expect(plan).toEqual({ action: 'diverged', id: 'copy-id', diffs: expect.arrayContaining(['dmMessage', 'keywords', 'followUpDelayMinutes']) });
  });

  it('flags a wrong destination, a changed label, a reused report slug and extra links', () => {
    const s = sample();
    const link = { slug: 'l', label: 'Primary campaign link', destinationUrl: URL_SYS, position: 0 };
    const diffsOf = (patch: Record<string, unknown>) => {
      const plan = planRuleCopy({ sample: s, existing: [stored(s, patch)], destinationUrl: URL_SYS });
      return plan.action === 'diverged' ? plan.diffs : [];
    };
    expect(diffsOf({ trackedLinks: [{ ...link, destinationUrl: 'https://t.me/neuroblagov_bot?start=zadacha_instagram' }] })).toContain('trackedLinks[0].destinationUrl');
    expect(diffsOf({ trackedLinks: [{ ...link, label: 'Other' }] })).toContain('trackedLinks[0].label');
    expect(diffsOf({ trackedLinks: [{ ...link, position: 1 }] })).toContain('trackedLinks[0].position');
    expect(diffsOf({ reportShareSlug: 'sample-report-slug' })).toContain('reportShareSlug (same as sample)');
    expect(diffsOf({ trackedLinks: [link, link] })).toEqual([expect.stringContaining('trackedLinks (count 2')]);
    expect(diffsOf({ trackedLinks: [] })).toEqual([expect.stringContaining('trackedLinks (count 0')]);
  });

  it('stops when two rules in the target carry the sample name', () => {
    const s = sample();
    expect(() => planRuleCopy({ sample: s, existing: [stored(s), stored(s, { id: 'copy-2' })], destinationUrl: URL_SYS })).toThrow(RuleCopyError);
  });

  it('stops on a sample with ≠1 links before looking at the target', () => {
    const s = sample({ trackedLinks: [] });
    expect(() => planRuleCopy({ sample: s, existing: [], destinationUrl: URL_SYS })).toThrow(RuleCopyError);
  });

  it('a diff of a fresh copy against its sample is empty', () => {
    const s = sample();
    expect(diffRuleCopy({ sample: s, candidate: stored(s), destinationUrl: URL_SYS })).toEqual([]);
  });
});

describe('copiedFields', () => {
  it('drops exactly the not-copied columns', () => {
    const s = sample();
    expect(Object.keys(copiedFields(s)).sort()).toEqual(Object.keys(s).filter(k => !(NOT_COPIED_FIELDS as readonly string[]).includes(k)).sort());
  });
});

describe('matchRules (probe --match)', () => {
  const rule = (patch: Partial<MatchableRule> = {}): MatchableRule => ({
    id: 'r1', name: 'zadacha', isActive: true, matchAnyPost: true, postId: null, matchAnyWord: false,
    keywords: ['задача'], wholeWordMatch: true, ...patch,
  });
  const run = (rules: MatchableRule[], text: string) => matchRules({ rules, text, mediaId: 'openreply-probe-media' });

  it('fires on the code word, any case, and not on text without it', () => {
    expect(run([rule()], 'Задача!')[0]).toMatchObject({ considered: true, matched: true, matchedKeyword: expect.any(String) });
    expect(run([rule()], 'просто текст')[0]).toMatchObject({ considered: true, matched: false });
  });

  it('skips paused rules and rules bound to another post', () => {
    expect(run([rule({ isActive: false })], 'задача')[0]).toMatchObject({ considered: false, matched: false });
    expect(run([rule({ matchAnyPost: false, postId: 'other' })], 'задача')[0]).toMatchObject({ considered: false, matched: false });
    expect(run([rule({ matchAnyPost: false, postId: 'openreply-probe-media' })], 'задача')[0]).toMatchObject({ considered: true, matched: true });
  });
});

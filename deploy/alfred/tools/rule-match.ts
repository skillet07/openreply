// Which rules of one account fire for a comment. Mirrors the selection and the
// keyword step of processComment in lib/queue/dm-worker.ts (same matchKeywords),
// without the queue, the database or any sending.
import { matchKeywords } from '@/lib/utils/keyword-matcher';

export interface MatchableRule {
  id: string;
  name: string;
  isActive: boolean;
  matchAnyPost: boolean;
  postId: string | null;
  matchAnyWord: boolean;
  keywords: string[];
  wholeWordMatch: boolean;
}

export interface RuleMatch {
  id: string;
  name: string;
  considered: boolean;
  matched: boolean;
  matchedKeyword: string | null;
}

export function matchRules({ rules, text, mediaId }: { rules: MatchableRule[]; text: string; mediaId: string }): RuleMatch[] {
  return rules.map(rule => {
    const considered = rule.isActive && (rule.matchAnyPost || rule.postId === mediaId);
    if (!considered) return { id: rule.id, name: rule.name, considered, matched: false, matchedKeyword: null };
    const result = rule.matchAnyWord
      ? { matched: true, matchedKeyword: null }
      : matchKeywords(text, rule.keywords, rule.wholeWordMatch);
    return { id: rule.id, name: rule.name, considered, matched: result.matched, matchedKeyword: result.matchedKeyword };
  });
}

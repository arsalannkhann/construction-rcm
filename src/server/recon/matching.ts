/**
 * Matching what a submission says about itself to our records:
 * which subcontract it belongs to, and which schedule-of-values line each row is.
 * Pure functions; ambiguous cases return "no match" so a person decides.
 */
import type { MatchCandidate, StatedParties } from '@/server/types';
import { normaliseItemNo, normaliseName, similarity } from './text';

export type ContractCandidate = {
  contractId: string;
  contractNumber: string;
  originalAmount: number;
  subcontractorName: string;
  projectName: string;
  projectNumber: string | null;
};

const compact = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function rankContracts(stated: StatedParties, claimedOriginal: number | null, contracts: ContractCandidate[]): MatchCandidate[] {
  const out: MatchCandidate[] = [];
  for (const c of contracts) {
    const reasons: string[] = [];
    const sub = similarity(stated.contractorName, c.subcontractorName);
    const sameProjectNo = !!stated.projectNumber && !!c.projectNumber && compact(stated.projectNumber) === compact(c.projectNumber);
    const proj = Math.max(similarity(stated.projectName, c.projectName), sameProjectNo ? 1 : 0);
    const sameContractNo = !!stated.contractNumber && compact(stated.contractNumber).length >= 3 && compact(stated.contractNumber) === compact(c.contractNumber);
    const sameAmount = claimedOriginal !== null && claimedOriginal === c.originalAmount;

    if (sameContractNo) reasons.push(`Contract number ${c.contractNumber} matches`);
    if (sub >= 0.75) reasons.push(`Subcontractor “${c.subcontractorName}” matches`);
    else if (sub >= 0.5) reasons.push(`Subcontractor name is similar to “${c.subcontractorName}”`);
    if (sameProjectNo) reasons.push(`Project number ${c.projectNumber} matches`);
    else if (proj >= 0.75) reasons.push(`Project “${c.projectName}” matches`);
    if (sameAmount) reasons.push('Original contract sum matches');

    const score = sameContractNo ? (sub >= 0.5 ? 0.98 : 0.84) : Math.min(0.95, 0.55 * sub + 0.35 * proj + (sameAmount ? 0.1 : 0));
    if (score >= 0.35) out.push({ contractId: c.contractId, score: Math.round(score * 100) / 100, reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

/** The top candidate, only if it is both strong and clearly ahead of the runner-up. */
export function confidentMatch(candidates: MatchCandidate[]): MatchCandidate | null {
  const [top, second] = candidates;
  if (!top || top.score < 0.8) return null;
  if (second && top.score - second.score < 0.12) return null;
  return top;
}

type Row = { itemNo: string | null; description: string | null; scheduledValue: number | null };
type Sov = { id: string; itemNo: string; description: string; scheduledValue: number };

/** For each submitted row, the id of the contract line it corresponds to, or null. Each contract line is used at most once. */
export function mapLinesToSov(rows: Row[], sov: Sov[]): Array<string | null> {
  const result: Array<string | null> = rows.map(() => null);
  const used = new Set<string>();

  // 1. Item number, unless everything else about the row says it is a different line.
  const byItem = new Map<string, Sov[]>();
  for (const s of sov) {
    const k = normaliseItemNo(s.itemNo);
    if (k) byItem.set(k, [...(byItem.get(k) ?? []), s]);
  }
  rows.forEach((row, i) => {
    const k = normaliseItemNo(row.itemNo);
    const hits = k ? byItem.get(k) : undefined;
    if (!hits || hits.length !== 1) return;
    const s = hits[0]!;
    if (used.has(s.id)) return;
    const unrelated = similarity(row.description, s.description) < 0.3 && row.scheduledValue !== null && row.scheduledValue !== s.scheduledValue;
    if (unrelated) return;
    result[i] = s.id;
    used.add(s.id);
  });

  // 2. Description, for rows whose numbering does not line up.
  rows.forEach((row, i) => {
    if (result[i] || !normaliseName(row.description)) return;
    let best: Sov | null = null;
    let bestScore = 0;
    for (const s of sov) {
      if (used.has(s.id)) continue;
      const sim = similarity(row.description, s.description);
      const score = sim + (row.scheduledValue !== null && row.scheduledValue === s.scheduledValue ? 0.3 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (best && bestScore >= 0.82) {
      result[i] = best.id;
      used.add(best.id);
    }
  });
  return result;
}

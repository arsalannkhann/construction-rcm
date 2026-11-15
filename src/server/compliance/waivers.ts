/**
 * Lien waiver pre-screening.
 *
 * Three kinds of result, kept deliberately separate:
 *   - completeness  — is a waiver there, is it signed, are its fields filled in
 *   - consistency   — do its amount, date and names agree with the application
 *   - form          — does the wording resemble the project state's statutory form
 *
 * None of these is a conclusion about enforceability. Anything that would be
 * one (non-standard wording, listed exceptions, undeterminable type) is marked
 * `needsQualifiedReview`, which restricts who may sign it off.
 */
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import type { OrgSettings } from '@/server/types';
import { WAIVER_TYPE_LABEL } from '@/server/types';
import type { CheckResult, ReconWaiver } from '@/server/recon/engine';
import { similarity } from '@/server/recon/text';
import { JURISDICTIONS } from './jurisdictions';

export type WaiverInput = {
  policy: OrgSettings;
  projectState: string | null;
  subcontractorName: string;
  applicationNumber: number | null;
  periodTo: string | null;
  claimedPayment: number | null;
  verifiedPayment: number | null;
  priorPayment: number | null;
  hasWaiverDocument: boolean;
  waivers: ReconWaiver[];
  tolerance: number;
};

const isConditional = (w: ReconWaiver) => w.waiverType === 'conditional_progress' || w.waiverType === 'conditional_final';
const isUnconditional = (w: ReconWaiver) => w.waiverType === 'unconditional_progress' || w.waiverType === 'unconditional_final';

export function evaluateWaivers(input: WaiverInput): CheckResult[] {
  const out: CheckResult[] = [];
  const { policy, waivers, tolerance: tol } = input;
  const $ = formatMoney;
  const near = (a: number, b: number) => Math.abs(a - b) <= tol;
  const jurisdiction = input.projectState ? JURISDICTIONS[input.projectState] : undefined;

  // Which waiver covers the payment being requested now? Prefer a conditional
  // one; failing that, a waiver whose amount or through date ties to this
  // application (an unconditional waiver for the current payment gives the
  // payer more protection, not less, so it satisfies the requirement).
  const current =
    waivers.find(isConditional) ??
    waivers.find(
      (w) =>
        (w.amount !== null && input.claimedPayment !== null && near(w.amount, input.claimedPayment)) ||
        (w.throughDate !== null && w.throughDate === input.periodTo),
    ) ??
    (waivers.length === 1 && !(policy.requirePriorUnconditionalWaiver && isUnconditional(waivers[0]!)) ? waivers[0] : undefined);

  if (!current) {
    if (policy.requireConditionalWaiver || input.hasWaiverDocument) {
      out.push({
        code: 'lw.present',
        subjectKey: '',
        category: 'compliance',
        severity: policy.requireConditionalWaiver ? 'blocking' : 'warning',
        outcome: 'fail',
        title: input.hasWaiverDocument ? 'The lien waiver could not be read' : 'No lien waiver for this payment',
        detail: input.hasWaiverDocument
          ? 'A document was recognised as a lien waiver, but its contents could not be read, so it cannot be tied to this payment.'
          : 'The package does not include a lien waiver covering the payment requested. Your policy requires one before payment is approved.',
        action: input.hasWaiverDocument
          ? 'Open the waiver and enter its details by hand, or request a clearer copy.'
          : 'Request a conditional waiver for this payment from the subcontractor.',
        refs: { tab: 'compliance' },
      });
    }
  } else {
    out.push({
      code: 'lw.present',
      subjectKey: '',
      category: 'compliance',
      severity: policy.requireConditionalWaiver ? 'blocking' : 'warning',
      outcome: 'pass',
      title: 'Lien waiver received for this payment',
      detail: `Classified as: ${WAIVER_TYPE_LABEL[current.waiverType]}.`,
      refs: { waiverId: current.id, tab: 'compliance' },
    });
    out.push(...screenCurrent(current, input, jurisdiction));
  }

  if (policy.requirePriorUnconditionalWaiver && (input.applicationNumber ?? 0) > 1) {
    const prior = waivers.find((w) => w !== current && isUnconditional(w));
    if (!prior) {
      out.push({
        code: 'lw.prior_unconditional',
        subjectKey: '',
        category: 'compliance',
        severity: 'warning',
        outcome: 'fail',
        title: 'No unconditional waiver for the previous payment',
        detail: 'Your policy expects each application after the first to include an unconditional waiver confirming the previous payment was received.',
        action: 'Request the unconditional waiver for the previous payment.',
        refs: { tab: 'compliance' },
      });
    } else if (input.priorPayment !== null && prior.amount !== null && !near(prior.amount, input.priorPayment)) {
      out.push({
        code: 'lw.prior_unconditional',
        subjectKey: '',
        category: 'compliance',
        severity: 'warning',
        outcome: 'fail',
        title: 'Unconditional waiver amount differs from the previous payment',
        detail: `The unconditional waiver is for ${$(prior.amount)}; the previous approved payment was ${$(input.priorPayment)}.`,
        action: 'Confirm which payment this waiver relates to.',
        data: { expected: input.priorPayment, actual: prior.amount, delta: prior.amount - input.priorPayment },
        refs: { waiverId: prior.id, tab: 'compliance' },
      });
    } else {
      out.push({
        code: 'lw.prior_unconditional',
        subjectKey: '',
        category: 'compliance',
        severity: 'warning',
        outcome: 'pass',
        title: 'Unconditional waiver received for the previous payment',
        detail: prior.amount !== null ? `Amount: ${$(prior.amount)}.` : 'Amount not stated.',
        refs: { waiverId: prior.id, tab: 'compliance' },
      });
    }
  }

  return out;

  function screenCurrent(w: ReconWaiver, i: WaiverInput, j: (typeof JURISDICTIONS)[string] | undefined): CheckResult[] {
    const res: CheckResult[] = [];
    const refs = { waiverId: w.id, tab: 'compliance' as const };

    // ── Classification ──
    if (w.waiverType === 'unknown') {
      res.push({
        code: 'lw.type',
        subjectKey: w.id,
        category: 'compliance',
        severity: 'warning',
        outcome: 'fail',
        needsQualifiedReview: true,
        title: 'Waiver type could not be determined',
        detail: 'The document reads as a lien waiver, but it is not clear whether it is conditional or unconditional, or whether it covers a progress or final payment. That distinction changes what rights are released and when.',
        action: 'Have a qualified person read the waiver and record its type.',
        refs,
      });
    }

    // ── Consistency: amount ──
    if (w.amount === null) {
      res.push({
        code: 'lw.amount',
        subjectKey: w.id,
        category: 'compliance',
        severity: 'blocking',
        outcome: 'fail',
        title: 'Waiver amount is blank or unreadable',
        detail: 'No amount could be read from the waiver, so it cannot be tied to the payment requested.',
        action: 'Enter the amount from the document, or request a completed waiver.',
        refs,
      });
    } else if (i.claimedPayment !== null) {
      const ok = near(w.amount, i.claimedPayment);
      res.push({
        code: 'lw.amount',
        subjectKey: w.id,
        category: 'compliance',
        severity: 'blocking',
        outcome: ok ? 'pass' : 'fail',
        title: ok ? 'Waiver amount matches the payment requested' : 'Waiver amount does not match the payment requested',
        detail: ok
          ? `${$(w.amount)} on both the waiver and line 8 of the application.`
          : `The waiver is for ${$(w.amount)}; the application requests ${$(i.claimedPayment)} — ${$(Math.abs(w.amount - i.claimedPayment))} apart. The two documents in this package disagree about what is being paid.`,
        action: ok ? undefined : 'Request a waiver for the correct amount.',
        data: { expected: i.claimedPayment, actual: w.amount, delta: w.amount - i.claimedPayment },
        refs,
      });
      if (ok && i.verifiedPayment !== null && !near(w.amount, i.verifiedPayment)) {
        res.push({
          code: 'lw.amount_vs_verified',
          subjectKey: w.id,
          category: 'compliance',
          severity: 'warning',
          outcome: 'fail',
          title: 'Waiver amount will not match the verified payment',
          detail: `The waiver covers ${$(w.amount)}, but the verified amount is ${$(i.verifiedPayment)}. If you approve the verified amount, the waiver on file will be for a different sum than the payment.`,
          action: 'Request a revised waiver for the approved amount, or note why the existing one is acceptable.',
          data: { expected: i.verifiedPayment, actual: w.amount, delta: w.amount - i.verifiedPayment },
          refs,
        });
      }
    }

    // ── Consistency: through date ──
    const formExpectsDate = j ? j.progressFormHasThroughDate : true;
    if (w.throughDate && i.periodTo) {
      const ok = w.throughDate === i.periodTo;
      res.push({
        code: 'lw.through_date',
        subjectKey: w.id,
        category: 'compliance',
        severity: 'warning',
        outcome: ok ? 'pass' : 'fail',
        title: ok ? 'Waiver through date matches the billing period' : 'Waiver through date differs from the billing period',
        detail: ok
          ? `Both run through ${formatDate(i.periodTo)}.`
          : `The waiver releases rights through ${formatDate(w.throughDate)}; the application bills through ${formatDate(i.periodTo)}. ${w.throughDate < i.periodTo ? 'Work after the waiver date is billed but not covered by the waiver.' : 'The waiver reaches beyond the period billed.'}`,
        action: ok ? undefined : 'Request a waiver dated through the end of the billing period.',
        refs,
      });
    } else if (!w.throughDate && formExpectsDate) {
      res.push({
        code: 'lw.through_date',
        subjectKey: w.id,
        category: 'compliance',
        severity: 'warning',
        outcome: 'fail',
        title: 'Waiver through date is blank or unreadable',
        detail: 'No through date could be read from the waiver, so the period it covers is unclear.',
        action: 'Enter the date from the document, or request a completed waiver.',
        refs,
      });
    }

    // ── Consistency: who is waiving ──
    if (!w.claimant) {
      res.push({
        code: 'lw.claimant',
        subjectKey: w.id,
        category: 'compliance',
        severity: 'warning',
        outcome: 'fail',
        title: 'Claimant name is blank or unreadable',
        detail: 'The waiver does not clearly say who is giving up lien rights.',
        action: 'Enter the claimant from the document, or request a completed waiver.',
        refs,
      });
    } else {
      const score = similarity(w.claimant, i.subcontractorName);
      const ok = score >= 0.55;
      res.push({
        code: 'lw.claimant',
        subjectKey: w.id,
        category: 'compliance',
        severity: 'warning',
        outcome: ok ? 'pass' : 'fail',
        title: ok ? 'Waiver is from the subcontractor' : 'Waiver claimant does not match the subcontractor',
        detail: ok
          ? `Claimant: ${w.claimant}.`
          : `The waiver is given by “${w.claimant}”, but this contract is with “${i.subcontractorName}”. A waiver from a different entity does not release this subcontractor’s rights.`,
        action: ok ? undefined : 'Confirm the entity. If it is a lower-tier supplier’s waiver, the subcontractor’s own waiver is still needed.',
        refs,
      });
    }

    // ── Completeness: signature ──
    res.push(
      w.signed === 'yes'
        ? { code: 'lw.signature', subjectKey: w.id, category: 'compliance', severity: 'blocking', outcome: 'pass', title: 'Waiver is signed', detail: 'A signature was detected on the waiver.', refs }
        : w.signed === 'no'
          ? {
              code: 'lw.signature',
              subjectKey: w.id,
              category: 'compliance',
              severity: 'blocking',
              outcome: 'fail',
              title: 'Waiver is not signed',
              detail: 'The signature block on the waiver appears to be blank. An unsigned waiver releases nothing.',
              action: 'Request a signed waiver.',
              refs,
            }
          : {
              code: 'lw.signature',
              subjectKey: w.id,
              category: 'compliance',
              severity: 'warning',
              outcome: 'fail',
              title: 'Waiver signature could not be confirmed automatically',
              detail: 'The system could not tell whether the waiver is signed.',
              action: 'Look at the signature block and record whether it is signed.',
              refs,
            },
    );

    // ── Form: does the wording resemble the project state's statutory form? ──
    if (j) {
      const form = w.waiverType !== 'unknown' ? j.forms[w.waiverType] : undefined;
      if (w.formState === j.state && form) {
        res.push({
          code: 'lw.form',
          subjectKey: w.id,
          category: 'compliance',
          severity: 'warning',
          outcome: 'pass',
          title: `Wording resembles the ${j.name} statutory form`,
          detail: `The document contains the identifying language of the “${form.title}” form (${form.cite}). This is a wording match only, not a determination that the waiver is valid.`,
          refs,
        });
      } else {
        res.push({
          code: 'lw.form',
          subjectKey: w.id,
          category: 'compliance',
          severity: 'warning',
          outcome: 'fail',
          needsQualifiedReview: true,
          title: w.formState
            ? `Waiver uses ${JURISDICTIONS[w.formState]?.name ?? w.formState} wording on a ${j.name} project`
            : `Waiver does not appear to follow the ${j.name} statutory form`,
          detail:
            `This project is in ${j.name}, which prescribes statutory waiver forms (${j.statute}). ` +
            (w.formState
              ? `The document’s wording matches another state’s form.`
              : `The identifying language of the ${j.name} form was not found in this document.`) +
            ` Whether a non-conforming waiver is effective is a legal question this system does not answer.`,
          action: 'Have a qualified person review the waiver, or request one on the statutory form.',
          refs,
        });
      }
    } else {
      res.push({
        code: 'lw.form',
        subjectKey: w.id,
        category: 'compliance',
        severity: 'info',
        outcome: 'fail',
        title: input.projectState ? `No statutory-form check is available for ${input.projectState}` : 'Project state is not set, so the waiver form was not checked',
        detail: 'Statutory-form recognition currently covers Texas, California and Florida. For other states, review the waiver against your own requirements.',
        action: input.projectState ? undefined : 'Set the project’s state to enable the form check.',
        refs,
      });
    }

    // ── Exceptions listed on the waiver ──
    const exceptions = (w.exceptions ?? '').trim();
    if (exceptions && !/^(none|n\/?a|nil|no exceptions?|-+)\.?$/i.test(exceptions)) {
      res.push({
        code: 'lw.exceptions',
        subjectKey: w.id,
        category: 'compliance',
        severity: 'warning',
        outcome: 'fail',
        needsQualifiedReview: true,
        title: 'The waiver lists exceptions',
        detail: `Exceptions stated on the waiver: “${exceptions.slice(0, 240)}${exceptions.length > 240 ? '…' : ''}”. Exceptions carve out amounts or claims that are not released.`,
        action: 'Have a qualified person confirm the exceptions are acceptable before payment.',
        refs,
      });
    }

    return res;
  }
}

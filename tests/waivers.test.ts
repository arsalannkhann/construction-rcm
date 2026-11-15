import { describe, expect, it } from 'vitest';
import { classifyWaiverType, recogniseStatutoryForm } from '@/server/compliance/jurisdictions';
import { reconcile, type CheckResult } from '@/server/recon/engine';
import { cleanInput, dollars as D } from './helpers/recon-fixture';

const find = (checks: CheckResult[], code: string) => checks.find((c) => c.code === code && c.outcome === 'fail');

describe('lien waiver pre-screen', () => {
  it('blocks when the policy requires a waiver and none is in the package', () => {
    const input = cleanInput();
    input.waivers = [];
    input.documents[0]!.segments = input.documents[0]!.segments.filter((s) => s.type !== 'lien_waiver');
    const f = find(reconcile(input).checks, 'lw.present')!;
    expect(f.severity).toBe('blocking');
    expect(f.title).toBe('No lien waiver for this payment');
  });

  it('does not block on a missing waiver when the policy does not require one', () => {
    const input = cleanInput();
    input.policy.requireConditionalWaiver = false;
    input.waivers = [];
    input.documents[0]!.segments = input.documents[0]!.segments.filter((s) => s.type !== 'lien_waiver');
    expect(find(reconcile(input).checks, 'lw.present')).toBeUndefined();
  });

  it('says so when a waiver document is present but unreadable', () => {
    const input = cleanInput();
    input.waivers = [];
    expect(find(reconcile(input).checks, 'lw.present')?.title).toBe('The lien waiver could not be read');
  });

  it('blocks when the waiver amount disagrees with the payment requested', () => {
    const input = cleanInput();
    input.waivers[0]!.amount = D(100000);
    const f = find(reconcile(input).checks, 'lw.amount')!;
    expect(f.severity).toBe('blocking');
    expect(f.data).toMatchObject({ expected: D(103500), actual: D(100000) });
  });

  it('blocks on an unsigned waiver and asks a person to look when unsure', () => {
    const unsigned = cleanInput();
    unsigned.waivers[0]!.signed = 'no';
    expect(find(reconcile(unsigned).checks, 'lw.signature')?.severity).toBe('blocking');

    const unclear = cleanInput();
    unclear.waivers[0]!.signed = 'unclear';
    expect(find(reconcile(unclear).checks, 'lw.signature')?.severity).toBe('warning');
  });

  it('flags a waiver from a different entity', () => {
    const input = cleanInput();
    input.waivers[0]!.claimant = 'Gulf Coast Supply Co.';
    expect(find(reconcile(input).checks, 'lw.claimant')?.detail).toContain('different entity');
  });

  it('escalates non-statutory wording to a qualified reviewer instead of judging it', () => {
    const input = cleanInput();
    input.waivers[0]!.formState = null;
    const f = find(reconcile(input).checks, 'lw.form')!;
    expect(f.needsQualifiedReview).toBe(true);
    expect(f.severity).toBe('warning');
    expect(f.detail).toContain('legal question this system does not answer');
  });

  it('escalates another state’s form used on this project', () => {
    const input = cleanInput();
    input.waivers[0]!.formState = 'CA';
    const f = find(reconcile(input).checks, 'lw.form')!;
    expect(f.title).toBe('Waiver uses California wording on a Texas project');
    expect(f.needsQualifiedReview).toBe(true);
  });

  it('escalates listed exceptions', () => {
    const input = cleanInput();
    input.waivers[0]!.exceptions = 'Disputed claim for extra work, $4,200.00';
    const f = find(reconcile(input).checks, 'lw.exceptions')!;
    expect(f.needsQualifiedReview).toBe(true);
    input.waivers[0]!.exceptions = 'None';
    expect(find(reconcile(input).checks, 'lw.exceptions')).toBeUndefined();
  });

  it('checks the through date in states whose form has one, and not in Texas', () => {
    const ca = cleanInput();
    ca.project.state = 'CA';
    ca.waivers[0]!.formState = 'CA';
    ca.waivers[0]!.throughDate = null;
    expect(find(reconcile(ca).checks, 'lw.through_date')?.title).toBe('Waiver through date is blank or unreadable');

    ca.waivers[0]!.throughDate = '2026-10-15';
    expect(find(reconcile(ca).checks, 'lw.through_date')?.detail).toContain('billed but not covered');

    ca.waivers[0]!.throughDate = '2026-10-31';
    expect(find(reconcile(ca).checks, 'lw.through_date')).toBeUndefined();

    const tx = cleanInput();
    expect(reconcile(tx).checks.find((c) => c.code === 'lw.through_date')).toBeUndefined();
  });

  it('is honest about states it has no form knowledge for', () => {
    const input = cleanInput();
    input.project.state = 'NY';
    input.waivers[0]!.formState = null;
    const f = find(reconcile(input).checks, 'lw.form')!;
    expect(f.severity).toBe('info');
    expect(f.needsQualifiedReview).toBeFalsy();
  });

  it('accepts an unconditional waiver for the current payment (more protection, not less)', () => {
    const input = cleanInput();
    input.waivers[0]!.waiverType = 'unconditional_progress';
    const out = reconcile(input);
    expect(find(out.checks, 'lw.present')).toBeUndefined();
  });

  it('looks for the prior-payment unconditional waiver only when the policy asks', () => {
    const input = cleanInput();
    input.policy.requirePriorUnconditionalWaiver = true;
    expect(find(reconcile(input).checks, 'lw.prior_unconditional')?.title).toBe('No unconditional waiver for the previous payment');

    input.waivers.push({ id: 'w2', waiverType: 'unconditional_progress', formState: 'TX', claimant: 'Lone Star Electric LLC', throughDate: null, amount: D(99000), exceptions: null, signed: 'yes' });
    expect(find(reconcile(input).checks, 'lw.prior_unconditional')).toBeUndefined();

    input.waivers[1]!.amount = D(90000);
    expect(find(reconcile(input).checks, 'lw.prior_unconditional')?.title).toContain('differs from the previous payment');
  });
});

describe('statutory form recognition', () => {
  const CA_COND =
    'CONDITIONAL WAIVER AND RELEASE ON PROGRESS PAYMENT NOTICE: THIS DOCUMENT WAIVES THE CLAIMANT’S LIEN, STOP PAYMENT NOTICE, AND PAYMENT BOND RIGHTS EFFECTIVE ON RECEIPT OF PAYMENT. A PERSON SHOULD NOT RELY ON THIS DOCUMENT UNLESS SATISFIED THAT THE CLAIMANT HAS RECEIVED PAYMENT.';
  const CA_UNCOND =
    'UNCONDITIONAL WAIVER AND RELEASE ON PROGRESS PAYMENT NOTICE TO CLAIMANT: THIS DOCUMENT WAIVES AND RELEASES LIEN, STOP PAYMENT NOTICE, AND PAYMENT BOND RIGHTS UNCONDITIONALLY AND STATES THAT YOU HAVE BEEN PAID FOR GIVING UP THOSE RIGHTS.';
  const TX_COND =
    'CONDITIONAL WAIVER AND RELEASE ON PROGRESS PAYMENT Project Riverside Job No. 2301 On receipt by the signer of this document of a check from Meridian (maker of check) in the sum of $103,500.00 payable to Lone Star Electric';
  const FL_PROGRESS =
    'WAIVER AND RELEASE OF LIEN UPON PROGRESS PAYMENT The undersigned lienor, in consideration of the sum of $48,200.00, hereby waives and releases its lien and right to claim a lien for labor, services, or materials furnished through October 31, 2026';

  it('tells California from Texas even though the title lines are identical', () => {
    expect(recogniseStatutoryForm(CA_COND)).toMatchObject({ state: 'CA', type: 'conditional_progress' });
    expect(recogniseStatutoryForm(TX_COND)).toMatchObject({ state: 'TX', type: 'conditional_progress' });
  });

  it('does not mistake "unconditional" for "conditional"', () => {
    expect(recogniseStatutoryForm(CA_UNCOND)).toMatchObject({ state: 'CA', type: 'unconditional_progress' });
  });

  it('treats the Florida form as conditional only when it is expressly conditioned', () => {
    expect(recogniseStatutoryForm(FL_PROGRESS)).toMatchObject({ state: 'FL', type: 'unconditional_progress' });
    expect(recogniseStatutoryForm(`${FL_PROGRESS} This waiver is conditioned upon payment of the check.`)).toMatchObject({
      state: 'FL',
      type: 'conditional_progress',
    });
  });

  it('returns null for wording that matches no statutory form, and classifies by words alone', () => {
    const generic = 'PARTIAL LIEN WAIVER. The undersigned conditionally waives lien rights upon receipt of the progress payment described.';
    expect(recogniseStatutoryForm(generic)).toBeNull();
    expect(classifyWaiverType('Conditional waiver for progress payment')).toBe('conditional_progress');
    expect(classifyWaiverType('Unconditional final waiver and release — final payment')).toBe('unconditional_final');
    expect(classifyWaiverType('Lien waiver')).toBe('unknown');
  });
});

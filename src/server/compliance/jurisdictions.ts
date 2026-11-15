/**
 * Jurisdiction reference data for lien waiver PRE-SCREENING.
 *
 * What this is: enough knowledge of each state's statutory waiver forms to
 * (a) recognise which form a document resembles and (b) tell a reviewer what
 * to look at. What it is not: a determination that any waiver is valid or
 * enforceable. Anything turning on legal sufficiency is routed to a person.
 *
 * Statutory form wording is quoted only as short marker phrases used for
 * recognition. Sources are cited so a reviewer can read the statute itself.
 */
import type { WaiverType } from '@/server/types';

export type KnownWaiverType = Exclude<WaiverType, 'unknown'>;

export type FormDefinition = {
  /** Title line of the statutory form. */
  title: string;
  cite: string;
  /** All of these must appear (case- and whitespace-insensitive) for the wording to "resemble" the form. */
  markers: RegExp[];
};

export type Jurisdiction = {
  state: string;
  name: string;
  statute: string;
  sourceUrl: string;
  /** Does the statutory form itself distinguish conditional from unconditional? */
  distinguishesConditional: boolean;
  /** Does the conditional progress form carry a "through date"? */
  progressFormHasThroughDate: boolean;
  forms: Partial<Record<KnownWaiverType, FormDefinition>>;
  /** Plain-language points for the reviewer. Informational, not advice. */
  reviewerNotes: string[];
};

export const JURISDICTIONS: Record<string, Jurisdiction> = {
  CA: {
    state: 'CA',
    name: 'California',
    statute: 'Cal. Civ. Code §§ 8120–8138',
    sourceUrl: 'https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=CIV&division=4.&title=2.&part=6.&chapter=3.&article=',
    distinguishesConditional: true,
    progressFormHasThroughDate: true,
    forms: {
      conditional_progress: {
        title: 'Conditional Waiver and Release on Progress Payment',
        cite: 'Cal. Civ. Code § 8132',
        markers: [
          /conditional waiver and release on progress payment/,
          /this document waives the claimant.?s lien, stop payment notice, and payment bond rights effective on receipt of payment/,
        ],
      },
      unconditional_progress: {
        title: 'Unconditional Waiver and Release on Progress Payment',
        cite: 'Cal. Civ. Code § 8134',
        markers: [
          /unconditional waiver and release on progress payment/,
          /this document waives and releases lien, stop payment notice, and payment bond rights unconditionally/,
        ],
      },
      conditional_final: {
        title: 'Conditional Waiver and Release on Final Payment',
        cite: 'Cal. Civ. Code § 8136',
        markers: [
          /conditional waiver and release on final payment/,
          /this document waives the claimant.?s lien, stop payment notice, and payment bond rights effective on receipt of payment/,
        ],
      },
      unconditional_final: {
        title: 'Unconditional Waiver and Release on Final Payment',
        cite: 'Cal. Civ. Code § 8138',
        markers: [
          /unconditional waiver and release on final payment/,
          /this document waives and releases lien, stop payment notice, and payment bond rights unconditionally/,
        ],
      },
    },
    reviewerNotes: [
      'California prescribes four statutory waiver forms. A waiver and release is null, void and unenforceable unless it is in substantially the statutory form and signed by the claimant (Civ. Code §§ 8124, 8132–8138).',
      'The progress forms identify the claimant, customer, job location, owner and a through date. The final forms have no through date.',
      'A conditional waiver is effective only with evidence of payment (Civ. Code § 8124(b)).',
      'The statute requires a signature; it does not mention notarisation.',
    ],
  },
  TX: {
    state: 'TX',
    name: 'Texas',
    statute: 'Tex. Prop. Code §§ 53.281–53.284',
    sourceUrl: 'https://statutes.capitol.texas.gov/Docs/PR/htm/PR.53.htm',
    distinguishesConditional: true,
    progressFormHasThroughDate: false,
    forms: {
      conditional_progress: {
        title: 'Conditional Waiver and Release on Progress Payment',
        cite: 'Tex. Prop. Code § 53.284(b)',
        markers: [
          /conditional waiver and release on progress payment/,
          /on receipt by the signer of this document of a check from/,
        ],
      },
      unconditional_progress: {
        title: 'Unconditional Waiver and Release on Progress Payment',
        cite: 'Tex. Prop. Code § 53.284(c)',
        markers: [
          /unconditional waiver and release on progress payment/,
          /the signer of this document has been paid and has received a progress payment/,
        ],
      },
      conditional_final: {
        title: 'Conditional Waiver and Release on Final Payment',
        cite: 'Tex. Prop. Code § 53.284(d)',
        markers: [
          /conditional waiver and release on final payment/,
          /on receipt by the signer of this document of a check from/,
        ],
      },
      unconditional_final: {
        title: 'Unconditional Waiver and Release on Final Payment',
        cite: 'Tex. Prop. Code § 53.284(e)',
        markers: [
          /unconditional waiver and release on final payment/,
          /the signer of this document has been paid in full/,
        ],
      },
    },
    reviewerNotes: [
      'Texas prescribes four statutory waiver forms. A waiver is unenforceable unless it substantially complies with the applicable form (Prop. Code § 53.284(a)).',
      'The Texas conditional progress form describes the payment by check maker, amount and payee. It has no through-date field; its scope is the attached statement or payment request.',
      'Notarisation: required where the original contract was entered into before January 1, 2022. HB 2237 (2021) removed the requirement for original contracts entered into on or after that date. Check which applies to this project.',
    ],
  },
  FL: {
    state: 'FL',
    name: 'Florida',
    statute: 'Fla. Stat. § 713.20',
    sourceUrl: 'http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0700-0799/0713/Sections/0713.20.html',
    distinguishesConditional: false,
    progressFormHasThroughDate: true,
    forms: {
      conditional_progress: {
        title: 'Waiver and Release of Lien Upon Progress Payment',
        cite: 'Fla. Stat. § 713.20(4)',
        markers: [/waiver and release of lien upon progress payment/, /the undersigned lienor, in consideration of the sum of/],
      },
      unconditional_progress: {
        title: 'Waiver and Release of Lien Upon Progress Payment',
        cite: 'Fla. Stat. § 713.20(4)',
        markers: [/waiver and release of lien upon progress payment/, /the undersigned lienor, in consideration of the sum of/],
      },
      conditional_final: {
        title: 'Waiver and Release of Lien Upon Final Payment',
        cite: 'Fla. Stat. § 713.20(5)',
        markers: [/waiver and release of lien upon final payment/, /the undersigned lienor, in consideration of the final payment/],
      },
      unconditional_final: {
        title: 'Waiver and Release of Lien Upon Final Payment',
        cite: 'Fla. Stat. § 713.20(5)',
        markers: [/waiver and release of lien upon final payment/, /the undersigned lienor, in consideration of the final payment/],
      },
    },
    reviewerNotes: [
      'Florida provides statutory progress and final payment forms (§ 713.20(4), (5)). They are not split into conditional and unconditional versions.',
      'A lienor who gives a waiver in exchange for a check may condition it on payment of the check (§ 713.20(7)).',
      'You may not require a lienor to furnish a waiver different from the statutory forms (§ 713.20(6)).',
      'A waiver that is not substantially similar to the statutory forms is enforceable according to its own terms (§ 713.20(8)), so non-standard wording has to be read, not assumed.',
      'The statutory signature block has no notary acknowledgement.',
    ],
  },
};

export const SUPPORTED_STATES = Object.keys(JURISDICTIONS);

export function normaliseForMarkers(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ');
}

/**
 * Which state's statutory form does this wording resemble, and of which type?
 * Returns null when no form's markers are all present.
 */
export function recogniseStatutoryForm(text: string): { state: string; type: KnownWaiverType; title: string } | null {
  const t = normaliseForMarkers(text);
  // Texas and California share title lines, so the body marker decides. Check
  // the more specific (unconditional / final) titles first: "conditional …"
  // is a substring of "unconditional …".
  const order: KnownWaiverType[] = ['unconditional_final', 'unconditional_progress', 'conditional_final', 'conditional_progress'];
  for (const state of ['TX', 'CA', 'FL']) {
    const j = JURISDICTIONS[state]!;
    for (const type of order) {
      const form = j.forms[type];
      if (!form) continue;
      if (!form.markers.every((m) => m.test(t))) continue;
      if (type.startsWith('conditional') && /\bunconditional waiver and release/.test(t)) continue;
      if (state === 'FL') {
        // Florida's form is one document; whether it is conditional depends on added wording.
        const conditioned = /condition(ed|al)? (up)?on|effective (only )?(up)?on (receipt|payment|clearance)|upon (receipt|clearance|payment) of (the )?(check|funds|payment)/.test(t);
        const final = type.endsWith('final');
        return {
          state,
          type: conditioned ? (final ? 'conditional_final' : 'conditional_progress') : final ? 'unconditional_final' : 'unconditional_progress',
          title: form.title,
        };
      }
      return { state, type, title: form.title };
    }
  }
  return null;
}

/** Classify a waiver by its wording alone when it matches no statutory form. */
export function classifyWaiverType(text: string): WaiverType {
  const t = normaliseForMarkers(text);
  const unconditional = /\bunconditional(ly)?\b/.test(t);
  const conditional = !unconditional && /\bconditional(ly)?\b|condition(ed)? (up)?on/.test(t);
  const final = /final payment|final (lien )?(waiver|release)/.test(t);
  const progress = /progress payment|partial (lien )?(waiver|release|payment)/.test(t);
  if (!unconditional && !conditional) return 'unknown';
  if (!final && !progress) return 'unknown';
  return `${unconditional ? 'unconditional' : 'conditional'}_${final ? 'final' : 'progress'}` as WaiverType;
}

/**
 * Wording and small rules for the welcome step, shared by the server and the
 * screens. Nothing here grants anything: a focus only orders what a member
 * sees first, and the company profile only changes guidance.
 */
import { can } from '@/server/auth/permissions';
import { MEMBER_FOCUSES, type MemberFocus, type OrgKind, type OrgRegion, type Role } from '@/server/types';

/** The focus a role most likely has, offered as the starting choice. */
export function defaultFocus(role: Role): MemberFocus {
  if (role === 'accountant') return 'review';
  if (role === 'controller') return 'approve';
  if (role === 'owner' || role === 'admin') return 'oversee';
  return 'projects';
}

/** The focuses a role can meaningfully choose: nobody is offered work their role cannot do. */
export function focusesFor(role: Role): MemberFocus[] {
  return MEMBER_FOCUSES.filter((f) => (f === 'review' ? can(role, 'application:review') : f === 'approve' ? can(role, 'application:approve') : true));
}

export const FOCUS_LABEL: Record<MemberFocus, string> = {
  review: 'Review billing',
  approve: 'Approve billing',
  oversee: 'Oversee the finances',
  projects: 'Follow my projects',
};

export const FOCUS_DETAIL: Record<MemberFocus, string> = {
  review: 'Check what subcontractors send, resolve what does not add up and pass it on for approval.',
  approve: 'Give the final yes or no on what gets paid, with the evidence in front of you.',
  oversee: 'Watch exceptions, what is waiting and where the money stands across projects.',
  projects: 'Keep an eye on billing for my projects without doing the accounting.',
};

export const ORG_KIND_LABEL: Record<OrgKind, string> = {
  general_contractor: 'General contractor',
  subcontractor: 'Subcontractor',
  owner_developer: 'Owner or developer',
  other: 'Something else',
};

export const ORG_REGION_LABEL: Record<OrgRegion, string> = {
  us: 'the United States',
  india: 'India',
  other: 'another country',
};

/** What a company that is not a general contractor should know before setting up. Null when there is nothing to add. */
export function kindNote(kind: OrgKind): string | null {
  if (kind === 'general_contractor') return null;
  if (kind === 'subcontractor') return 'Zephric is built for the company that receives and approves subcontractor billing. It does not prepare your own pay applications yet. The example still shows how your billing is checked on the other side.';
  if (kind === 'owner_developer') return 'Zephric checks subcontractor billing for the general contractor. Reviewing a contractor’s application to an owner is not built yet, though the example shows the same kind of checking.';
  return 'Zephric is built for general contractors who receive and approve subcontractor billing. Have a look at the example to see whether it fits what you do.';
}

/** What works where, said plainly, so nobody sets up expecting support that is not there. */
export function regionNote(region: OrgRegion): string {
  if (region === 'us') return 'Statutory lien waiver forms are recognised for Texas, California and Florida. In other states, waivers get completeness and consistency checks only.';
  return 'Zephric reads US-style pay applications (an application summary with a schedule of values) in US dollars. Other layouts, currencies, taxes and local retention rules are not supported yet. Tell us what you use and we will say honestly how close we are.';
}

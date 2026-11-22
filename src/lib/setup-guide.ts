/**
 * The setup guide: the steps from an empty organisation to a first reviewed
 * billing package, worked out from the organisation's own records.
 *
 * Nothing here is ticked by hand. A step is done when the work exists (a
 * project, a subcontract, a decision), whoever did it, so a member invited into
 * a half-set-up organisation starts from where it actually stands. The one
 * exception is "look at what was read", which no record shows: that is noted
 * for the member the first time they open an application.
 *
 * Plain data in, plain data out, so the overview, the guide page and the
 * sidebar all show the same thing.
 */
import { can, type Permission } from '@/server/auth/permissions';
import type { Role } from '@/server/types';

export type SetupProgress = {
  projects: number;
  subcontractors: number;
  contracts: number;
  contractsWithSchedule: number;
  /** Billing packages received, not counting void ones. */
  applications: number;
  /** Applications someone has moved on: sent for approval, held for a correction, approved or rejected. */
  actedOn: number;
  /** Applications approved or rejected. */
  decided: number;
  members: number;
  requireMfa: boolean;
  /** This member has opened an application's review workspace. */
  openedReview: boolean;
  /** Where the next step should lead, when there is a specific record to open. */
  firstContractId: string | null;
  contractWithoutScheduleId: string | null;
  openApplicationId: string | null;
};

export type SetupStepId = 'organisation' | 'project' | 'subcontractor' | 'subcontract' | 'schedule' | 'upload' | 'review' | 'decide';

export type SetupStep = {
  id: SetupStepId;
  title: string;
  /** One or two plain sentences: what it is and why it matters. */
  body: string;
  /** A second, smaller line for a detail people ask about at this step. */
  hint?: string;
  done: boolean;
  /** The first step not done yet. */
  next: boolean;
  /** Where the step is done. */
  href: string;
  cta: string;
  /** This member's role can do it. */
  allowed: boolean;
  /** Who can, when this member cannot. */
  who: string;
};

export type SetupFollowUp = { id: 'team' | 'two-step'; title: string; body: string; done: boolean; href: string; cta: string; allowed: boolean };

const WHO: Partial<Record<Permission, string>> = {
  'records:write': 'An admin, controller or project accountant sets this up.',
  'application:upload': 'Anyone except a viewer can upload.',
  'application:review': 'A project accountant or controller reviews.',
  'application:approve': 'A controller, admin or owner decides.',
  'team:manage': 'An owner or admin does this.',
};

export function setupSteps(p: SetupProgress, role: Role): SetupStep[] {
  const approves = can(role, 'application:approve');
  const reviews = can(role, 'application:review');
  const application = p.openApplicationId ? `/applications/${p.openApplicationId}` : '/applications';

  const steps: Array<Omit<SetupStep, 'next' | 'allowed' | 'who'> & { needs: Permission | null }> = [
    {
      id: 'organisation',
      title: 'Create your organisation',
      body: 'Your company’s own space. Projects, documents and decisions in it are only ever seen by the people you invite.',
      done: true,
      href: '/settings/organization',
      cta: 'Organisation settings',
      needs: null,
    },
    {
      id: 'project',
      title: 'Add a project',
      body: 'Its name, location and owner. The state matters: it decides which lien waiver form is expected.',
      hint: 'Projects can also be imported from Procore once it is connected under Settings → Integrations.',
      done: p.projects > 0,
      href: '/projects/new',
      cta: 'Add a project',
      needs: 'records:write',
    },
    {
      id: 'subcontractor',
      title: 'Add a subcontractor',
      body: 'The company that will bill you, with the contact their billing comes from.',
      done: p.subcontractors > 0,
      href: '/subcontractors',
      cta: 'Add a subcontractor',
      needs: 'records:write',
    },
    {
      id: 'subcontract',
      title: 'Set up the subcontract and its terms',
      body: 'The contract amount and the retainage rates. Every billing package is checked against these.',
      done: p.contracts > 0,
      href: p.projects > 0 ? '/contracts/new' : '/projects/new',
      cta: 'Add the subcontract',
      needs: 'records:write',
    },
    {
      id: 'schedule',
      title: 'Add the schedule of values',
      body: 'The lines the subcontractor bills against. Paste them from a spreadsheet, or take them from the first pay application when it arrives.',
      done: p.contractsWithSchedule > 0,
      href: p.contractWithoutScheduleId ? `/contracts/${p.contractWithoutScheduleId}` : p.firstContractId ? `/contracts/${p.firstContractId}` : '/contracts/new',
      cta: 'Add the schedule',
      needs: 'records:write',
    },
    {
      id: 'upload',
      title: 'Upload a billing package',
      body: 'The pay application, its schedule of values and the lien waiver, as PDFs. Zephric reads them, matches them to the subcontract and checks every figure.',
      hint: 'Already part-way through the job? Upload the last approved pay application first. You will be asked to confirm opening balances from it, and the next one is checked against them.',
      done: p.applications > 0,
      href: '/applications/new',
      cta: 'Upload a package',
      needs: 'application:upload',
    },
    {
      id: 'review',
      title: 'See what was read and what was found',
      body: 'Open the application. The figures Zephric read sit beside the original pages, and each finding says what is wrong, why it matters and what to do.',
      done: p.applications > 0 && (p.openedReview || p.actedOn > 0),
      href: application,
      cta: 'Open the application',
      needs: null,
    },
    approves
      ? {
          id: 'decide',
          title: 'Approve or reject the first application',
          body: 'Approval is yours to give. It stays locked while a blocking finding is open, unless you override it with a written reason.',
          done: p.decided > 0,
          href: application,
          cta: 'Go to the application',
          needs: 'application:approve',
        }
      : {
          id: 'decide',
          title: reviews ? 'Send the first application for approval' : 'First application decided',
          body: reviews ? 'Resolve what was found, or ask the subcontractor for a correction, then send it to a controller to approve.' : 'A controller approves or rejects it once the review is finished. You can follow it from the queue.',
          done: p.actedOn > 0,
          href: application,
          cta: reviews ? 'Go to the application' : 'See the queue',
          needs: reviews ? 'application:review' : null,
        },
  ];

  const firstOpen = steps.findIndex((s) => !s.done);
  return steps.map(({ needs, ...s }, i) => ({
    ...s,
    next: i === firstOpen,
    allowed: needs === null || can(role, needs),
    who: needs ? (WHO[needs] ?? '') : '',
  }));
}

/** Worth doing once the first package has been through, never in the way of it. */
export function setupFollowUps(p: SetupProgress, role: Role): SetupFollowUp[] {
  const allowed = can(role, 'team:manage');
  return [
    {
      id: 'team',
      title: 'Invite your team',
      body: 'Project accountants review, controllers approve. Each role sees and can do only what it should.',
      done: p.members > 1,
      href: '/settings/team',
      cta: 'Invite people',
      allowed,
    },
    {
      id: 'two-step',
      title: 'Require two-step verification',
      body: 'Turn it on for yourself under Profile, then require it for everyone.',
      done: p.requireMfa,
      href: '/settings/team#security',
      cta: 'Security settings',
      allowed,
    },
  ];
}

export type SetupSummary = { done: number; total: number; complete: boolean; next: SetupStep | null };

export function summarizeSetup(steps: SetupStep[]): SetupSummary {
  const done = steps.filter((s) => s.done).length;
  return { done, total: steps.length, complete: done === steps.length, next: steps.find((s) => s.next) ?? null };
}

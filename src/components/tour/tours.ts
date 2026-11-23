/**
 * The product tours: what each step points at and says.
 *
 * A step names a control by its `data-tour` attribute and the pages it lives
 * on. The engine (tour.tsx) only ever points at a control that is on screen
 * right now: a step whose control is missing (hidden on a narrow screen, not
 * offered to this role) is passed over when it is `optional`, and shown as
 * plain text with no pointer when it is not. No step clicks anything for the
 * member; where a step is theirs to do, it waits for them.
 */
import type { TourId } from '@/server/types';

export type TourEnv = { isDemo: boolean; hasOwnOrg: boolean; canUpload: boolean };

export type TourAction = { label: string; primary?: boolean } & ({ href: string } | { own: true } | { done: true });

export type TourStep = {
  key: string;
  /** The pages this step belongs to. */
  on: (path: string) => boolean;
  /** Where to send someone who is elsewhere. */
  goto?: string;
  /** For a page that depends on a record: the earlier step that leads there. */
  back?: string;
  /** The `data-tour` value of the control to point at. Absent: a card on its own. */
  target?: string;
  title: string;
  body: string | ((env: TourEnv) => string);
  /** The member does this one: the tour moves on when they click the control. */
  action?: string;
  /** Pass over the step when its control is not on screen. */
  optional?: boolean;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  /** Ways on from the last step. */
  actions?: (env: TourEnv) => TourAction[];
};

export type Tour = { id: TourId; name: string; steps: TourStep[] };

const anywhere = () => true;
const onQueue = (p: string) => p === '/applications';
const onApplication = (p: string) => /^\/applications\/(?!new$)[^/]+$/.test(p);

const review: Tour = {
  id: 'review',
  name: 'Billing review tour',
  steps: [
    {
      key: 'intro',
      on: onQueue,
      goto: '/applications',
      title: 'Two minutes: how billing gets reviewed',
      body: (env) =>
        `You will follow one billing package from this queue to the point of decision.${env.isDemo ? ' Everything here is fictitious practice data, separate from your own records.' : ''} The tour only points and explains: it never approves, rejects or sends anything.`,
    },
    {
      key: 'queue',
      on: onQueue,
      goto: '/applications',
      target: 'queue-tabs',
      placement: 'bottom',
      title: 'Everything subcontractors send lands here',
      body: 'Needs attention is what is waiting on your team. The other tabs hold what is with a subcontractor for a correction, and what has been approved or rejected.',
    },
    {
      key: 'open',
      on: onQueue,
      goto: '/applications',
      target: 'queue-row',
      placement: 'bottom',
      title: 'Open one that has problems',
      body: 'Each row shows what was requested, what Zephric could verify, and how many findings are open.',
      action: 'Click the highlighted row to open it.',
    },
    {
      key: 'figures',
      on: onApplication,
      back: 'open',
      target: 'app-figures',
      placement: 'bottom',
      title: 'Requested against verified',
      body: 'Requested is what the subcontractor asked for. Verified is what Zephric recomputed from the subcontract, the approved change orders and the billing already approved. The difference is what needs explaining.',
    },
    {
      key: 'document',
      on: onApplication,
      back: 'open',
      target: 'app-document',
      optional: true,
      placement: 'right',
      title: 'The original, exactly as it arrived',
      body: 'Every page of the package stays beside the figures read from it, so you check against the source and not against a retyped copy.',
    },
    {
      key: 'finding',
      on: onApplication,
      back: 'open',
      target: 'finding',
      optional: true,
      placement: 'left',
      title: 'What is wrong, why it matters, what to do',
      body: 'A finding puts the expected figure next to what the document says. Blocking findings stop an approval. Warnings only need to be acknowledged.',
    },
    {
      key: 'show',
      on: onApplication,
      back: 'open',
      target: 'finding-show',
      optional: true,
      placement: 'left',
      title: 'See it on the page',
      body: 'The figure a finding is about can be shown where it is printed.',
      action: 'Click “Show in document” to try it.',
    },
    {
      key: 'decision',
      on: onApplication,
      back: 'open',
      target: 'app-decision',
      placement: 'bottom',
      title: 'Then a person decides',
      body: 'Ask the subcontractor for a correction, reject, or approve. Approval stays locked while a blocking finding is open, unless someone with the authority overrides it with a written reason. What you see here depends on your role.',
    },
    {
      key: 'tabs',
      on: onApplication,
      back: 'open',
      target: 'app-tabs',
      optional: true,
      placement: 'bottom',
      title: 'The rest of the package',
      body: 'The summary, every schedule of values line, the lien waivers, and a record of everything done to this application and by whom.',
    },
    {
      key: 'outro',
      on: anywhere,
      title: 'That is the core of Zephric',
      body: 'A package arrives, it is read, every figure is checked against your records, and your team decides with the evidence in front of them.',
      actions: (env) => [
        ...(env.isDemo && env.canUpload ? [{ label: 'Upload a sample package myself', href: '/applications/new', primary: true } as TourAction] : []),
        ...(env.isDemo && env.hasOwnOrg ? [{ label: 'Set up my own project', own: true, primary: !env.canUpload } as TourAction] : []),
        { label: env.isDemo ? 'Keep exploring' : 'Finish', done: true, primary: !env.isDemo },
      ],
    },
  ],
};

const workspace: Tour = {
  id: 'workspace',
  name: 'Workspace tour',
  steps: [
    {
      key: 'overview',
      on: anywhere,
      target: 'nav-overview',
      placement: 'right',
      title: 'Overview',
      body: 'What needs you today comes first, then where billing stands across your projects.',
    },
    {
      key: 'applications',
      on: anywhere,
      target: 'nav-applications',
      placement: 'right',
      title: 'Pay applications',
      body: 'The queue of billing packages: what needs review, what is waiting on a subcontractor, and what has been decided.',
    },
    {
      key: 'upload',
      on: anywhere,
      target: 'nav-upload',
      optional: true,
      placement: 'right',
      title: 'Upload a package',
      body: 'Add a pay application and its backup as PDFs. A subcontractor can also send theirs through a link you make on the subcontract.',
    },
    {
      key: 'billing',
      on: anywhere,
      target: 'nav-billing',
      placement: 'right',
      title: 'Billing periods',
      body: 'Month by month: which subcontracts have billed, which are missing, and what was approved.',
    },
    {
      key: 'projects',
      on: anywhere,
      target: 'nav-projects',
      placement: 'right',
      title: 'Projects',
      body: 'Each project with its subcontracts, change orders, retainage and budget. Subcontracts are opened from their project.',
    },
    {
      key: 'exports',
      on: anywhere,
      target: 'nav-exports',
      optional: true,
      placement: 'right',
      title: 'Exports',
      body: 'Approved applications ready to hand to accounting, and a record of what has already been sent.',
    },
    {
      key: 'activity',
      on: anywhere,
      target: 'nav-activity',
      placement: 'right',
      title: 'Activity',
      body: 'The audit trail: every upload, change and decision, with who made it and when.',
    },
    {
      key: 'help',
      on: anywhere,
      target: 'nav-help',
      placement: 'right',
      title: 'Help is always here',
      body: 'The setup guide, both tours and the example workspace can be reopened from Help whenever you want them.',
    },
  ],
};

export const TOURS: Record<TourId, Tour> = { review, workspace };

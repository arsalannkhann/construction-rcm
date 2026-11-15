import { CircleCheck, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { getDb } from '@/db';
import { CopyField } from '@/components/settings/copy-field';
import { Notice } from '@/components/settings/notice';
import { PermissionNote } from '@/components/settings/permission-note';
import { Button, buttonClass } from '@/components/ui/button';
import { Badge, PageHeader, Panel, PanelHeader, Stat } from '@/components/ui/data';
import { formatDateTime } from '@/lib/utils';
import { can, UserError } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { listCompanies, procoreRedirectUri, procoreStatus, type ProcoreCompany, type ProcoreStatus } from '@/server/integrations/procore';
import { CompanyPicker } from './company-picker';
import { DisconnectButton } from './disconnect-button';
import { ImportDialogButton } from './import-dialog';

export const metadata = { title: 'Integrations' };

const CONNECT_URL = '/api/integrations/procore/connect';

/** What each short code on ?error= means. The codes come from the connect and callback routes. */
const CONNECT_ERRORS: Record<string, string> = {
  not_configured: 'Procore is not configured on this deployment, so there is nothing to connect to yet.',
  forbidden: 'Your role cannot connect integrations. Nothing was connected.',
  state: 'The connection attempt could not be verified: it expired (it is valid for 10 minutes) or was started in a different browser. Nothing was connected. Start again.',
  org_changed: 'You switched organisation while connecting. Nothing was connected. Start again from the organisation you want to connect.',
  denied: 'Procore did not grant access: the request was declined or cancelled there. Nothing was connected.',
  missing_code: 'Procore sent you back without an authorization code. Nothing was connected. Try again.',
  code_rejected: 'Procore did not accept the authorization. The code may have expired, or the redirect URI registered on the Procore app does not match the one shown below. Nothing was connected.',
  unreachable: 'Procore could not be reached to finish connecting. Nothing was connected. Try again in a few minutes.',
};
const UNKNOWN_CONNECT_ERROR = 'Connecting to Procore did not finish. The status below shows whether a connection exists.';

const ENV_LABEL = { production: 'Production', sandbox: 'Developer sandbox' } as const;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

type State = 'not_configured' | 'not_connected' | 'needs_company' | 'connected';

function stateOf(status: ProcoreStatus): State {
  if (!status.configured) return 'not_configured';
  if (!status.connected) return 'not_connected';
  return status.needsCompany ? 'needs_company' : 'connected';
}

export default async function IntegrationsSettingsPage({ searchParams }: { searchParams: Promise<{ connected?: string | string[]; error?: string | string[] }> }) {
  const ctx = await requireCtx();
  const db = await getDb();
  const sp = await searchParams;
  const status = await procoreStatus(db, ctx);
  const state = stateOf(status);
  const canManage = can(ctx.role, 'integrations:manage');
  const canImport = canManage && can(ctx.role, 'records:write');
  const redirectUri = procoreRedirectUri();

  // The picker needs the companies the connected login can see; a failure to list them is shown, not hidden.
  let companies: ProcoreCompany[] = [];
  let companiesError: string | null = null;
  if (state === 'needs_company' && canManage) {
    try {
      companies = await listCompanies(db, ctx);
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      companiesError = err.message;
    }
  }

  const errorCode = first(sp.error);
  const justConnected = first(sp.connected) === '1' && !errorCode && status.connected;

  const badge =
    state === 'connected' ? (
      <Badge tone="pass" dot>
        Connected
      </Badge>
    ) : state === 'needs_company' ? (
      <Badge tone="warn" dot>
        Choose a company
      </Badge>
    ) : state === 'not_connected' ? (
      status.lastError ? (
        <Badge tone="block" dot>
          Needs reconnecting
        </Badge>
      ) : (
        <Badge>Not connected</Badge>
      )
    ) : (
      <Badge>Not configured</Badge>
    );

  return (
    <>
      <PageHeader title="Integrations" description="Move approved billing into the systems your project and accounting teams already use." />
      <div className="space-y-6">
        {errorCode ? (
          <Notice tone="block" icon={<TriangleAlert strokeWidth={1.9} />}>
            {CONNECT_ERRORS[errorCode] ?? UNKNOWN_CONNECT_ERROR}
          </Notice>
        ) : justConnected ? (
          <Notice tone="pass" icon={<CircleCheck strokeWidth={1.9} />}>
            {status.needsCompany
              ? 'Procore authorised the connection. Choose which company to use below to finish.'
              : `Procore is connected${status.companyName ? ` to ${status.companyName}` : ''}. Nothing has been imported or sent yet; use Import from Procore to bring in a project.`}
          </Notice>
        ) : null}

        {canManage ? null : <PermissionNote role={ctx.role} permission="integrations:manage" action="connect, import from or disconnect Procore" />}

        <Panel>
          <PanelHeader title="Procore" description="Import projects and subcontracts from Procore, and send approved applications back as draft subcontractor invoices." actions={badge} />

          {state === 'not_configured' ? (
            <div className="space-y-4 px-4 py-4">
              <p className="max-w-2xl text-[13px] text-ink-2">
                This deployment has no Procore app credentials, so nothing can be connected yet. These are set on the server by whoever runs it, not from this page:
              </p>
              <ol className="max-w-2xl list-decimal space-y-3 pl-5 text-[13px] text-ink-2">
                <li>Create an app in the Procore Developer Portal (developers.procore.com).</li>
                <li>
                  Register this redirect URI on the app, exactly as shown. It is built from this deployment’s <Code>APP_URL</Code>.
                  <div className="mt-1.5">
                    <CopyField value={redirectUri} label="Redirect URI" />
                  </div>
                </li>
                <li>
                  Set <Code>PROCORE_CLIENT_ID</Code> and <Code>PROCORE_CLIENT_SECRET</Code> to the app’s client ID and client secret.
                </li>
                <li>
                  Choose <Code>PROCORE_ENV</Code>: <Code>sandbox</Code> for Procore’s developer sandbox (the default) or <Code>production</Code> for live data. Then restart the server.
                </li>
              </ol>
              <div className="flex items-center gap-3 border-t border-line pt-4">
                <Button variant="primary" disabled>
                  Connect Procore
                </Button>
                <span className="text-xs text-ink-3">Available once the credentials above are set.</span>
              </div>
            </div>
          ) : null}

          {state === 'not_connected' ? (
            <div className="space-y-4 px-4 py-4">
              {status.lastError ? (
                <Notice tone="block" icon={<TriangleAlert strokeWidth={1.9} />}>
                  {status.lastError}
                </Notice>
              ) : null}
              <p className="max-w-2xl text-[13px] text-ink-2">
                {status.lastError ? 'The earlier connection can no longer be used. ' : `${ctx.orgName} is not connected to Procore. `}
                Connecting takes you to Procore’s {status.env ? ENV_LABEL[status.env].toLowerCase() : ''} sign-in to approve access. What can be imported, and whether invoices can be created, depends on the permissions of the Procore user
                who connects.
              </p>
              <div>
                <div className="mb-1 text-xs font-medium text-ink-2">Redirect URI that must be registered on the Procore app</div>
                <CopyField value={redirectUri} label="Redirect URI" />
              </div>
              {canManage ? (
                <div className="border-t border-line pt-4">
                  {/* A plain link: this is a full navigation to a route that redirects to Procore. */}
                  <a href={CONNECT_URL} className={buttonClass({ variant: 'primary' })}>
                    {status.lastError ? 'Reconnect Procore' : 'Connect Procore'}
                  </a>
                </div>
              ) : null}
            </div>
          ) : null}

          {state === 'needs_company' ? (
            <div className="space-y-4 px-4 py-4">
              <p className="max-w-2xl text-[13px] text-ink-2">
                Procore authorised the connection, and the Procore user who connected{status.connectedByName ? ` (through ${status.connectedByName})` : ''} can see more than one company, or none could be listed. Nothing can be imported or sent until
                one is chosen.
              </p>
              {status.lastError ? (
                <Notice tone="warn" icon={<TriangleAlert strokeWidth={1.9} />}>
                  {status.lastError}
                </Notice>
              ) : null}
              {companiesError ? (
                <Notice tone="block" icon={<TriangleAlert strokeWidth={1.9} />}>
                  The list of companies could not be loaded. {companiesError} Reload this page to try again.
                </Notice>
              ) : canManage && companies.length === 0 ? (
                <Notice tone="warn" icon={<TriangleAlert strokeWidth={1.9} />}>
                  The Procore user who connected has no active company. Disconnect, then connect again as a user who belongs to the company you want to use.
                </Notice>
              ) : canManage ? (
                <CompanyPicker companies={companies} />
              ) : null}
              {canManage ? (
                <div className="flex justify-end border-t border-line pt-4">
                  <DisconnectButton orgName={ctx.orgName} />
                </div>
              ) : null}
            </div>
          ) : null}

          {state === 'connected' ? (
            <>
              <dl className="grid grid-cols-2 gap-x-8 gap-y-4 px-4 py-4 lg:grid-cols-4">
                <Stat label="Company">{status.companyName ?? `Company ${status.companyId}`}</Stat>
                <Stat label="Environment">{status.env ? ENV_LABEL[status.env] : '—'}</Stat>
                <Stat label="Connected by">{status.connectedByName ?? 'A former member'}</Stat>
                <Stat label="Last sync">{status.lastSyncAt ? formatDateTime(status.lastSyncAt) : 'Nothing imported or sent yet'}</Stat>
              </dl>
              {status.lastError ? (
                <div className="px-4 pb-4">
                  <Notice tone="warn" icon={<TriangleAlert strokeWidth={1.9} />}>
                    <span className="font-medium">Last error.</span> {status.lastError}
                  </Notice>
                </div>
              ) : null}
              {canManage ? (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
                  <div className="flex items-center gap-3">
                    {canImport ? <ImportDialogButton companyName={status.companyName} /> : <span className="text-xs text-ink-3">Importing also needs permission to edit projects and contracts.</span>}
                  </div>
                  <DisconnectButton orgName={ctx.orgName} />
                </div>
              ) : null}
            </>
          ) : null}
        </Panel>

        <Panel>
          <PanelHeader title="What this integration does" description="So there are no surprises on either side." />
          <ul className="list-disc space-y-2 px-4 py-4 pl-9 text-[13px] text-ink-2">
            <li>
              <Strong>Imports, when you ask:</Strong> a Procore project, its vendors (as subcontractors), its subcontracts that are Approved or Complete, their schedules of values and their change orders. Importing again updates what changed and never
              deletes anything here.
            </li>
            <li>
              <Strong>Leaves out, and tells you:</Strong> subcontracts in any other status, and subcontracts billed by unit and quantity. Each is listed after the import with the reason.
            </li>
            <li>
              <Strong>Sends, when you ask:</Strong> an approved application as a <Strong>draft</Strong> subcontractor invoice in Procore, carrying work completed this period and materials stored for each schedule line. This is available only for
              subcontracts that were imported from Procore; for subcontracts created here by hand, use file export.
            </li>
            <li>
              <Strong>Does not set:</Strong> approval statuses (the invoice arrives as Draft for your Procore workflow), retainage amounts (Procore calculates its own) or origin ids (so the invoice stays editable in Procore).
            </li>
            <li>
              <Strong>Needs an existing billing period:</Strong> one in Procore that covers the application’s period-to date. It does not create billing periods; if none covers the date, the push fails and says so.
            </li>
            <li>
              <Strong>Creates one invoice per application:</Strong> before creating it, it looks at the subcontract’s invoices in Procore and stops if one already has the application’s number. If Procore does not answer, the push is marked
              “no answer”, not failed; sending again finds the invoice that request created instead of making a second.
            </li>
            <li>
              <Strong>Does not yet push change-order billing:</Strong> an application that bills against a change-order line this period is exported by file instead.
            </li>
            <li>
              <Strong>How far it has been tested:</Strong> this integration has been tested against an emulator of Procore’s API and not yet against a live Procore account.
            </li>
          </ul>
        </Panel>

        <Panel>
          <PanelHeader title="Export files" description="Independent of Procore." />
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4">
            <p className="max-w-2xl text-[13px] text-ink-2">
              CSV, JSON and PDF exports of approved applications are always available, whether or not Procore is configured or connected. Each export is rendered from the approved record and listed under Transfers.
            </p>
            <Link href="/transfers" className={buttonClass()}>
              Open transfers
            </Link>
          </div>
        </Panel>
      </div>
    </>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded border border-line bg-sunken px-1 font-mono text-[12px] text-ink">{children}</code>;
}

function Strong({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-ink">{children}</span>;
}

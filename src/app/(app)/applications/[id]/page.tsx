import { notFound } from 'next/navigation';
import { getDb } from '@/db';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { aiConfig, emailConfig } from '@/server/config';
import { canPushToProcore, procoreStatus } from '@/server/integrations/procore';
import { getReviewData } from '@/server/services/queries';
import { ProcessingScreen } from './processing';
import { ReviewWorkspace } from './workspace';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();
  const data = await getReviewData(await getDb(), ctx, id);
  if (!data) return { title: 'Application' };
  return { title: `${data.subcontractor?.name ?? data.app.stated?.contractorName ?? 'Application'}${data.app.applicationNumber ? ` #${data.app.applicationNumber}` : ''}` };
}

export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();
  const db = await getDb();
  const data = await getReviewData(db, ctx, id);
  if (!data) notFound();

  if (data.app.status === 'processing') {
    return <ProcessingScreen id={id} files={data.documents.map((d) => d.filename)} error={data.app.processingError} aiConfigured={aiConfig().configured} />;
  }

  const status = await procoreStatus(db, ctx);
  const push = data.app.status === 'approved' ? await canPushToProcore(db, ctx, id) : { available: false, reason: null };

  return (
    <ReviewWorkspace
      data={data}
      perms={{
        review: can(ctx.role, 'application:review'),
        approve: can(ctx.role, 'application:approve'),
        signoff: can(ctx.role, 'compliance:signoff'),
        records: can(ctx.role, 'records:write'),
        exportRun: can(ctx.role, 'export:run'),
        upload: can(ctx.role, 'application:upload'),
        comment: ctx.role !== 'viewer',
      }}
      extras={{
        me: { id: ctx.userId, name: ctx.userName },
        emailConfigured: emailConfig().configured,
        procore: { configured: status.configured, connected: status.connected, available: push.available, reason: push.reason },
      }}
    />
  );
}

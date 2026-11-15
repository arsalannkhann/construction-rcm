import Link from '@/components/ui/link';
import { redirect } from 'next/navigation';
import { getDb } from '@/db';
import { Page, PageHeader } from '@/components/ui/data';
import { can } from '@/server/auth/permissions';
import { requireCtx } from '@/server/auth/session';
import { aiConfig } from '@/server/config';
import { listDemoSamples } from '@/server/services/demo';
import { listContractOptions } from '@/server/services/queries';
import { UploadForm } from './upload-form';

export const metadata = { title: 'Upload a billing package' };

export default async function NewApplicationPage({ searchParams }: { searchParams: Promise<{ contract?: string }> }) {
  const ctx = await requireCtx();
  if (!can(ctx.role, 'application:upload')) redirect('/applications');
  const sp = await searchParams;
  const db = await getDb();
  const contracts = await listContractOptions(db, ctx);
  const samples = ctx.isDemo ? await listDemoSamples(db, ctx) : [];

  return (
    <Page width="narrow">
      <PageHeader
        back={
          <Link href="/applications" className="hover:text-ink">
            ← Pay applications
          </Link>
        }
        title="Upload a billing package"
        description="Add everything the subcontractor sent for this billing period: the pay application, the schedule of values, lien waivers and anything else. One combined PDF or separate files both work."
      />
      <UploadForm contracts={contracts} preselected={sp.contract ?? null} aiConfigured={aiConfig().configured} samples={samples} />
    </Page>
  );
}

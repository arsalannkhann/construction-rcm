import { SearchX } from 'lucide-react';
import Link from '@/components/ui/link';
import { buttonClass } from '@/components/ui/button';
import { EmptyState, Page, Panel } from '@/components/ui/data';

export default function ContractNotFound() {
  return (
    <Page width="narrow">
      <Panel>
        <EmptyState
          icon={<SearchX />}
          title="Subcontract not found"
          description="The link may be wrong, or the subcontract may belong to a different organisation from the one you are signed in to."
          action={
            <Link href="/projects" className={buttonClass()}>
              Back to projects
            </Link>
          }
        />
      </Panel>
    </Page>
  );
}

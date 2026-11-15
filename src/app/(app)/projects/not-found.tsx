import { SearchX } from 'lucide-react';
import Link from 'next/link';
import { buttonClass } from '@/components/ui/button';
import { EmptyState, Page, Panel } from '@/components/ui/data';

export default function ProjectNotFound() {
  return (
    <Page width="narrow">
      <Panel>
        <EmptyState
          icon={<SearchX />}
          title="Project not found"
          description="The link may be wrong, or the project may belong to a different organisation from the one you are signed in to."
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

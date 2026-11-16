'use client';

import Link from '@/components/ui/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, buttonClass } from '@/components/ui/button';
import { Note } from '@/components/records/figures';
import { Panel } from '@/components/ui/data';
import { useAction } from '@/lib/use-action';
import { createProjectAction } from '../actions';
import { EMPTY_PROJECT, ProjectFields, type ProjectValues } from '../project-fields';

export function ProjectForm({ fromApplication = null }: { fromApplication?: { id: string; title: string; name: string; number: string } | null }) {
  const router = useRouter();
  const [form, setForm] = useState<ProjectValues>(fromApplication ? { ...EMPTY_PROJECT, name: fromApplication.name, number: fromApplication.number } : EMPTY_PROJECT);
  const [created, setCreated] = useState(false);
  const { pending, run } = useAction();

  const submit = () => {
    if (!form.name.trim()) return;
    run(() => createProjectAction(form), {
      refresh: false,
      success: `${form.name.trim()} created`,
      onSuccess: ({ id }) => {
        setCreated(true);
        // Setting up from an application: its subcontract comes next.
        router.push(fromApplication ? `/contracts/new?project=${id}&from=${fromApplication.id}` : `/projects/${id}`);
      },
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {fromApplication ? (
        <Note className="mb-4">
          Setting up the project for {fromApplication.title}. The name and number were filled in from what the package states; check them and add the state. The subcontract comes next.
        </Note>
      ) : null}
      <Panel>
        <div className="grid grid-cols-2 gap-4 p-5">
          <ProjectFields value={form} onChange={setForm} />
        </div>
        <div className="flex items-center justify-end gap-2 rounded-b-xl border-t border-line bg-canvas/60 px-5 py-3">
          <Link href={fromApplication ? `/applications/${fromApplication.id}` : '/projects'} className={buttonClass({ variant: 'ghost' })}>
            Cancel
          </Link>
          <Button type="submit" variant="primary" loading={pending || created} disabled={!form.name.trim()}>
            Create project
          </Button>
        </div>
      </Panel>
    </form>
  );
}

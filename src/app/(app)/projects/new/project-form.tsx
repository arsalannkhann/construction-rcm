'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, buttonClass } from '@/components/ui/button';
import { Panel } from '@/components/ui/data';
import { useAction } from '@/lib/use-action';
import { createProjectAction } from '../actions';
import { EMPTY_PROJECT, ProjectFields, type ProjectValues } from '../project-fields';

export function ProjectForm() {
  const router = useRouter();
  const [form, setForm] = useState<ProjectValues>(EMPTY_PROJECT);
  const [created, setCreated] = useState(false);
  const { pending, run } = useAction();

  const submit = () => {
    if (!form.name.trim()) return;
    run(() => createProjectAction(form), {
      refresh: false,
      success: `${form.name.trim()} created`,
      onSuccess: ({ id }) => {
        setCreated(true);
        router.push(`/projects/${id}`);
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
      <Panel>
        <div className="grid grid-cols-2 gap-4 p-5">
          <ProjectFields value={form} onChange={setForm} />
        </div>
        <div className="flex items-center justify-end gap-2 rounded-b-xl border-t border-line bg-canvas/60 px-5 py-3">
          <Link href="/projects" className={buttonClass({ variant: 'ghost' })}>
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

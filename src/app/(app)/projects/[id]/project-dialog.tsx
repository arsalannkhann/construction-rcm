'use client';

import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { useAction } from '@/lib/use-action';
import { updateProjectAction } from '../actions';
import { ProjectFields, type ProjectValues } from '../project-fields';

type Project = { id: string; name: string; number: string | null; address: string | null; city: string | null; state: string | null; ownerName: string | null; budget: number | null; status: string };
type Status = 'active' | 'closed';

const valuesOf = (p: Project): ProjectValues => ({ name: p.name, number: p.number ?? '', address: p.address ?? '', city: p.city ?? '', state: p.state ?? '', ownerName: p.ownerName ?? '', budget: p.budget });
const statusOf = (p: Project): Status => (p.status === 'closed' ? 'closed' : 'active');

export function ProjectDialogButton({ project, label = 'Edit', variant }: { project: Project; label?: string; variant?: 'primary' | 'secondary' | 'ghost' }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ProjectValues>(() => valuesOf(project));
  const [status, setStatus] = useState<Status>(() => statusOf(project));
  const { pending, run } = useAction();

  const submit = () => {
    if (!form.name.trim()) return;
    run(() => updateProjectAction(project.id, { ...form, status }), { success: 'Project saved', onSuccess: () => setOpen(false) });
  };

  return (
    <>
      <Button
        variant={variant}
        size={label === 'Edit' ? undefined : 'sm'}
        onClick={() => {
          setForm(valuesOf(project));
          setStatus(statusOf(project));
          setOpen(true);
        }}
      >
        <Pencil className="size-3.5" />
        {label}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="lg"
        title="Edit project"
        description="The name and number are used to match incoming billing packages, so enter them the way they appear on pay applications."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} disabled={!form.name.trim()} onClick={submit}>
              Save changes
            </Button>
          </>
        }
      >
        <form
          className="grid grid-cols-2 gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <ProjectFields
            value={form}
            onChange={setForm}
            stateHint="Determines which statutory lien-waiver form is expected (Texas, California and Florida are recognised). Changing it re-checks the project’s undecided applications."
          />
          <Field label="Status" className="col-span-2" hint="A closed project stays on file with its subcontracts and billing history.">
            <Select value={status} onChange={(e) => setStatus(e.target.value === 'closed' ? 'closed' : 'active')}>
              <option value="active">Active</option>
              <option value="closed">Closed</option>
            </Select>
          </Field>
          <button type="submit" hidden />
        </form>
      </Dialog>
    </>
  );
}

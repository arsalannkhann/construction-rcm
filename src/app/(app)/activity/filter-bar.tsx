'use client';

import { Loader2, Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form';
import { activityQuery, NO_FILTERS, type ActivityValues } from './params';

const TYPING_PAUSE_MS = 350;

/**
 * Filters for the activity log. The URL holds the filters; this bar edits a
 * local copy for instant feedback and replaces the URL (which re-renders the
 * page on the server). Any change goes back to the first page.
 */
export function ActivityFilters({ current, actors, areas }: { current: ActivityValues; actors: Array<{ id: string; name: string }>; areas: Array<{ value: string; label: string }> }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState(current);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRequested = useRef<string | null>(null);
  const currentKey = activityQuery(current);

  // Whenever nothing from this bar is in flight and nobody is mid-keystroke, show exactly what the
  // URL says is applied. This picks up Back, links elsewhere on the page, and values the server dropped.
  useEffect(() => {
    if (pending || timer.current) return;
    lastRequested.current = null;
    setValues((mine) => (activityQuery(mine) === currentKey ? mine : current));
    // `current` is deliberately not a dependency: it is a new object on every render and only
    // differs in substance when currentKey does.
  }, [pending, currentKey]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const apply = (next: ActivityValues) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const query = activityQuery(next);
    if (query === (lastRequested.current ?? currentKey)) return;
    lastRequested.current = query;
    startTransition(() => router.replace(`/activity${query}`, { scroll: false }));
  };

  /** `pause` waits for typing to stop before asking the server. */
  const change = (key: keyof ActivityValues, value: string, pause = false) => {
    const next = { ...values, [key]: value };
    setValues(next);
    if (timer.current) clearTimeout(timer.current);
    if (pause) timer.current = setTimeout(() => apply(next), TYPING_PAUSE_MS);
    else apply(next);
  };

  const filtered = activityQuery(values) !== '';

  return (
    <form
      role="search"
      className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        apply(values);
      }}
    >
      <div className="relative min-w-52 flex-1">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3">
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Search className="size-3.5" strokeWidth={1.9} aria-hidden />}
        </span>
        <Input
          className="pl-8"
          placeholder="Search what happened"
          aria-label="Search what happened"
          enterKeyHint="search"
          maxLength={200}
          value={values.q}
          onChange={(e) => change('q', e.target.value, true)}
        />
      </div>
      <Select className="w-44" aria-label="Who" value={values.actor} onChange={(e) => change('actor', e.target.value)}>
        <option value="">Everyone</option>
        {actors.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Select>
      <Select className="w-44" aria-label="Area" value={values.area} onChange={(e) => change('area', e.target.value)}>
        <option value="">All areas</option>
        {areas.map((a) => (
          <option key={a.value} value={a.value}>
            {a.label}
          </option>
        ))}
      </Select>
      <label className="flex items-center gap-1.5 text-xs text-ink-3">
        From
        <Input type="date" className="w-[138px]" max={values.to || '9000-12-31'} value={values.from} onChange={(e) => change('from', e.target.value, true)} />
      </label>
      <label className="flex items-center gap-1.5 text-xs text-ink-3">
        To
        <Input type="date" className="w-[138px]" min={values.from || undefined} max="9000-12-31" value={values.to} onChange={(e) => change('to', e.target.value, true)} />
      </label>
      {filtered ? (
        <Button
          variant="ghost"
          onClick={() => {
            setValues(NO_FILTERS);
            apply(NO_FILTERS);
          }}
        >
          <X className="size-3.5" strokeWidth={1.9} />
          Clear
        </Button>
      ) : null}
      <button type="submit" hidden />
    </form>
  );
}

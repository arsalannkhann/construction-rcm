'use client';

import { ArrowLeft, ArrowRight, MousePointerClick, Pause, X } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { finishTourAction, saveTourStepAction, startOwnSetupAction, startTourAction } from '@/app/onboarding-actions';
import { cn } from '@/lib/utils';
import type { TourId } from '@/server/types';
import { TOURS, type TourAction, type TourEnv, type TourStep } from './tours';

/**
 * The tour engine.
 *
 * It points at controls that are really on screen, and says what they are for.
 * It never operates one: steps that are the member's to do wait for their own
 * click. Everything outside the highlighted control is shielded while a step is
 * showing, and so is the control itself unless the step asks for a click, so
 * nothing can be approved, sent or deleted by accident mid-tour.
 *
 * Closing the card pauses the tour and leaves a small "Resume" pill; the place
 * is saved on the member's own record, so it survives a reload or signing in
 * again. Skipping ends it, and it is then only ever started from Help.
 */

type Run = { id: TourId; step: number; paused: boolean };
type Box = { left: number; top: number; width: number; height: number };

const TourCtx = createContext<{ start: (id: TourId) => void; running: TourId | null }>({ start: () => {}, running: null });

export function useTour() {
  return useContext(TourCtx);
}

const NARROW = 640;
const PAD = 6;

export function TourProvider({ initial, env, children }: { initial: { id: TourId; step: number; paused?: boolean } | null; env: TourEnv; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [run, setRun] = useState<Run | null>(() => (initial && TOURS[initial.id] ? { id: initial.id, step: Math.min(initial.step, TOURS[initial.id].steps.length - 1), paused: !!initial.paused } : null));
  // Set after the member does a step that loads another page, so the tour waits for that page instead of saying they are in the wrong place.
  const [waiting, setWaiting] = useState(false);
  const direction = useRef<1 | -1>(1);

  const steps = run ? TOURS[run.id].steps : [];
  const step: TourStep | null = run ? (steps[run.step] ?? null) : null;
  const onPage = !!step && step.on(pathname);
  const showing = !!run && !run.paused && !!step && onPage && !waiting;

  useEffect(() => {
    if (!waiting) return;
    const id = window.setTimeout(() => setWaiting(false), 8000);
    return () => window.clearTimeout(id);
  }, [waiting]);
  useEffect(() => {
    setWaiting(false);
  }, [pathname]);

  // What the callbacks act on. Kept beside the state so that saving and navigating happen once per action, outside React's state updaters.
  const current = useRef(run);
  useEffect(() => {
    current.current = run;
  }, [run]);
  const apply = useCallback((next: Run | null) => {
    current.current = next;
    setRun(next);
    if (next) void saveTourStepAction(next.id, next.step, next.paused);
  }, []);

  const goTo = useCallback(
    (index: number, dir: 1 | -1) => {
      const now = current.current;
      if (!now) return;
      const list = TOURS[now.id].steps;
      const clamped = Math.max(0, Math.min(list.length - 1, index));
      direction.current = dir;
      apply({ ...now, step: clamped, paused: false });
      const target = list[clamped]!;
      if (!target.on(window.location.pathname) && target.goto) router.push(target.goto);
    },
    [router, apply],
  );

  const finish = useCallback((status: 'done' | 'skipped') => {
    const now = current.current;
    if (now) void finishTourAction(now.id, status);
    current.current = null;
    setRun(null);
  }, []);

  const pause = useCallback(() => {
    if (current.current) apply({ ...current.current, paused: true });
  }, [apply]);

  const resume = useCallback(() => {
    if (current.current) apply({ ...current.current, paused: false });
  }, [apply]);

  const start = useCallback(
    (id: TourId) => {
      const tour = TOURS[id];
      if (!tour) return;
      direction.current = 1;
      current.current = { id, step: 0, paused: false };
      setRun(current.current);
      void startTourAction(id);
      const first = tour.steps[0]!;
      if (!first.on(window.location.pathname) && first.goto) router.push(first.goto);
    },
    [router],
  );

  const box = useTargetBox(showing ? (step?.target ?? null) : null, run?.step ?? -1);

  // A step whose control is not on this screen is passed over rather than pointed at thin air.
  useEffect(() => {
    if (!showing || !run || !step?.optional || box !== 'missing') return;
    const next = run.step + direction.current;
    if (next < 0) goTo(run.step + 1, 1);
    else goTo(next, direction.current);
  }, [showing, run, step, box, goTo]);

  // A step that is the member's to do: move on when they click the highlighted control.
  useEffect(() => {
    if (!showing || !run || !step?.action || !step.target) return;
    const selector = `[data-tour="${step.target}"]`;
    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest(selector)) return;
      const nextStep = TOURS[run.id].steps[run.step + 1];
      if (nextStep && !nextStep.on(window.location.pathname)) setWaiting(true);
      // After the app has handled the click itself.
      window.setTimeout(() => goTo(run.step + 1, 1), 0);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [showing, run, step, goTo]);

  useEffect(() => {
    if (!showing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        pause();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [showing, pause]);

  const act = useCallback(
    (a: TourAction) => {
      finish('done');
      if ('href' in a) router.push(a.href);
      else if ('own' in a) {
        void startOwnSetupAction().then((result) => {
          if (!result.ok) toast.error(result.error);
          else window.location.assign(result.data.next);
        });
      }
    },
    [finish, router],
  );

  const ctx = useMemo(() => ({ start, running: run?.id ?? null }), [start, run?.id]);
  const last = !!run && run.step === steps.length - 1;
  const rect = typeof box === 'object' && box !== null ? box : null;

  return (
    <TourCtx.Provider value={ctx}>
      {children}
      {showing && run && step && (rect || box === 'missing' || !step.target) ? (
        <>
          <Shield rect={rect} open={!!step.action && !!rect} />
          <Card
            key={`${run.id}:${run.step}`}
            rect={rect}
            placement={step.placement}
            name={TOURS[run.id].name}
            index={run.step}
            total={steps.length}
            title={step.title}
            body={typeof step.body === 'function' ? step.body(env) : step.body}
            // Only ask for the click when there is a control to click.
            action={rect ? (step.action ?? null) : null}
            actions={last ? (step.actions?.(env) ?? [{ label: 'Finish', done: true, primary: true }]) : null}
            onBack={run.step > 0 ? () => goTo(run.step - 1, -1) : null}
            // A step the member must do to reach the next page cannot be skipped past: there would be nothing to show.
            canSkip={!step.action || !rect || !!steps[run.step + 1]?.on(pathname)}
            onNext={() => (last ? finish('done') : goTo(run.step + 1, 1))}
            onAct={act}
            onPause={pause}
            onSkip={() => finish('skipped')}
          />
        </>
      ) : null}
      {run && step && !run.paused && !onPage && !waiting ? (
        <Elsewhere
          name={TOURS[run.id].name}
          onContinue={() => {
            if (step.goto) return router.push(step.goto);
            const back = steps.findIndex((s) => s.key === step.back);
            goTo(back >= 0 ? back : 0, 1);
          }}
          onPause={pause}
          onEnd={() => finish('skipped')}
        />
      ) : null}
      {run?.paused ? <Paused name={TOURS[run.id].name} onResume={resume} onEnd={() => finish('skipped')} /> : null}
    </TourCtx.Provider>
  );
}

/**
 * Where the step's control is on screen, followed as the page scrolls and
 * settles. 'searching' while the page may still be loading it, 'missing' once
 * it has had long enough, null when the step has no control.
 */
function useTargetBox(target: string | null, stepIndex: number): Box | 'searching' | 'missing' | null {
  const [box, setBox] = useState<Box | 'searching' | 'missing' | null>(target ? 'searching' : null);

  useEffect(() => {
    if (!target) {
      setBox(null);
      return;
    }
    setBox('searching');
    const selector = `[data-tour="${target}"]`;
    const started = performance.now();
    let last = '';
    let scrolled = false;
    let frame = 0;
    const tick = () => {
      const el = document.querySelector<HTMLElement>(selector);
      const r = el?.getBoundingClientRect();
      const visible = !!r && r.width > 1 && r.height > 1;
      if (visible && !scrolled) {
        scrolled = true;
        const out = r.top < 8 || r.bottom > window.innerHeight - 8 || r.left < 0 || r.right > window.innerWidth;
        if (out) el!.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      }
      const key = visible ? `${Math.round(r.left)}:${Math.round(r.top)}:${Math.round(r.width)}:${Math.round(r.height)}` : performance.now() - started > 2500 ? 'missing' : 'searching';
      if (key !== last) {
        last = key;
        setBox(visible ? { left: r.left, top: r.top, width: r.width, height: r.height } : (key as 'missing' | 'searching'));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, stepIndex]);

  return box;
}

/** Dims the page around the control and takes clicks everywhere but (when the step asks for one) on it. */
function Shield({ rect, open }: { rect: Box | null; open: boolean }) {
  if (!rect) return <div className="fixed inset-0 z-[90] animate-in bg-navy/40" aria-hidden />;
  const x = Math.max(0, rect.left - PAD);
  const y = Math.max(0, rect.top - PAD);
  const w = rect.width + PAD * 2;
  const h = rect.height + PAD * 2;
  const panel = 'fixed z-[90]';
  return (
    <div aria-hidden>
      <div className={panel} style={{ left: 0, top: 0, right: 0, height: y }} />
      <div className={panel} style={{ left: 0, top: y + h, right: 0, bottom: 0 }} />
      <div className={panel} style={{ left: 0, top: y, width: x, height: h }} />
      <div className={panel} style={{ left: x + w, top: y, right: 0, height: h }} />
      {open ? null : <div className={panel} style={{ left: x, top: y, width: w, height: h }} />}
      <div
        className="pointer-events-none fixed z-[90] rounded-lg shadow-[0_0_0_9999px_rgb(7_13_26/0.42)] ring-2 ring-accent transition-[left,top,width,height] duration-200 ease-out"
        style={{ left: x, top: y, width: w, height: h }}
      />
    </div>
  );
}

function Card({
  rect,
  placement,
  name,
  index,
  total,
  title,
  body,
  action,
  actions,
  canSkip,
  onBack,
  onNext,
  onAct,
  onPause,
  onSkip,
}: {
  rect: Box | null;
  placement?: TourStep['placement'];
  name: string;
  index: number;
  total: number;
  title: string;
  body: string;
  action: string | null;
  actions: TourAction[] | null;
  canSkip: boolean;
  onBack: (() => void) | null;
  onNext: () => void;
  onAct: (a: TourAction) => void;
  onPause: () => void;
  onSkip: () => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [sheet, setSheet] = useState<null | 'top' | 'bottom'>(null);

  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    const place = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (vw < NARROW) {
        // On a phone the card is a sheet at whichever edge is further from the control.
        setSheet(rect && rect.top + rect.height / 2 > vh * 0.55 ? 'top' : 'bottom');
        setPos(null);
        return;
      }
      setSheet(null);
      const cw = el.offsetWidth;
      const ch = el.offsetHeight;
      if (!rect) return setPos({ left: Math.round((vw - cw) / 2), top: Math.round(Math.max(16, (vh - ch) / 2.4)) });
      const gap = 16;
      const fits = {
        bottom: rect.top + rect.height + gap + ch <= vh - 8,
        top: rect.top - gap - ch >= 8,
        right: rect.left + rect.width + gap + cw <= vw - 8,
        left: rect.left - gap - cw >= 8,
      };
      const order = [placement ?? 'bottom', 'bottom', 'right', 'left', 'top'] as const;
      const side = order.find((s) => fits[s]) ?? null;
      const clampX = (v: number) => Math.round(Math.max(8, Math.min(vw - cw - 8, v)));
      const clampY = (v: number) => Math.round(Math.max(8, Math.min(vh - ch - 8, v)));
      if (side === 'bottom') setPos({ left: clampX(rect.left + rect.width / 2 - cw / 2), top: Math.round(rect.top + rect.height + gap) });
      else if (side === 'top') setPos({ left: clampX(rect.left + rect.width / 2 - cw / 2), top: Math.round(rect.top - gap - ch) });
      else if (side === 'right') setPos({ left: Math.round(rect.left + rect.width + gap), top: clampY(rect.top + rect.height / 2 - ch / 2) });
      else if (side === 'left') setPos({ left: Math.round(rect.left - gap - cw), top: clampY(rect.top + rect.height / 2 - ch / 2) });
      // Nowhere beside it: over the corner of the screen furthest from the control.
      else setPos({ left: rect.left + rect.width / 2 > vw / 2 ? 16 : vw - cw - 16, top: rect.top + rect.height / 2 > vh / 2 ? 16 : vh - ch - 16 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [rect, placement]);

  // Each new step is announced and takes the keyboard, so the tour can be driven without a mouse.
  useEffect(() => {
    card.current?.focus({ preventScroll: true });
  }, []);

  // The shield stops the pointer; this stops the keyboard. Unless the step asks for the control to be used,
  // Tab stays inside the card, so nothing behind it can be reached and pressed while it is being explained.
  const keepFocus = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || action) return;
    const stops = Array.from(card.current?.querySelectorAll<HTMLElement>('button, a[href]') ?? []);
    if (stops.length === 0) return;
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === card.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const titleId = `tour-title-${index}`;
  return (
    <div
      ref={card}
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={`${titleId}-body`}
      aria-modal={action ? undefined : true}
      tabIndex={-1}
      onKeyDown={keepFocus}
      className={cn(
        'fixed z-[95] w-[360px] max-w-[calc(100vw-16px)] rounded-xl border border-line bg-surface p-4 shadow-pop outline-none',
        sheet ? 'inset-x-2 w-auto max-w-none' : '',
        sheet === 'bottom' && 'bottom-2',
        sheet === 'top' && 'top-2',
        pos || sheet ? 'animate-pop' : 'opacity-0',
      )}
      style={pos ? { left: pos.left, top: pos.top } : undefined}
    >
      <div className="flex items-start gap-3">
        <p className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-ink-3">
          <span className="num shrink-0 text-ink-2">
            {index + 1} of {total}
          </span>
          <span className="truncate">· {name}</span>
        </p>
        <button type="button" onClick={onPause} className="focus-ring -mr-1 -mt-1 rounded-md p-1 text-ink-3 hover:bg-sunken hover:text-ink" aria-label="Pause the tour">
          <X className="size-4" />
        </button>
      </div>
      <h2 id={titleId} className="mt-2 text-[15px] font-semibold leading-snug tracking-[-0.01em] text-ink">
        {title}
      </h2>
      <p id={`${titleId}-body`} className="mt-1.5 text-[13px] leading-[1.6] text-ink-2">
        {body}
      </p>
      {action ? (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-accent-soft px-3 py-2 text-[13px] font-medium leading-[1.45] text-accent-ink">
          <MousePointerClick className="mt-0.5 size-4 shrink-0" />
          {action}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {actions ? (
          actions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={() => onAct(a)}
              className={cn('focus-ring inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors', a.primary ? 'bg-ink text-white hover:bg-ink/88' : 'border border-line-strong text-ink hover:bg-sunken/70')}
            >
              {a.label}
            </button>
          ))
        ) : (
          <>
            {onBack ? (
              <button type="button" onClick={onBack} className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-[13px] font-medium text-ink hover:bg-sunken/70">
                <ArrowLeft className="size-3.5" />
                Back
              </button>
            ) : null}
            {canSkip ? (
              <button
                type="button"
                onClick={onNext}
                className={cn('focus-ring inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors', action ? 'border border-line-strong text-ink-2 hover:bg-sunken/70' : 'bg-ink text-white hover:bg-ink/88')}
              >
                {action ? 'Skip this step' : index === 0 ? 'Start' : 'Next'}
                {action ? null : <ArrowRight className="size-3.5" />}
              </button>
            ) : null}
            <button type="button" onClick={onSkip} className="focus-ring ml-auto rounded px-1.5 py-1 text-xs text-ink-3 hover:text-ink">
              End tour
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const PILL = 'fixed bottom-4 left-1/2 z-[95] flex max-w-[calc(100vw-16px)] -translate-x-1/2 animate-pop items-center gap-1 rounded-full border border-line bg-surface py-1.5 pl-4 pr-1.5 text-[13px] shadow-pop';
const PILL_BUTTON = 'focus-ring inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium';

/** The tour is running but the member has gone somewhere its next step is not. */
function Elsewhere({ name, onContinue, onPause, onEnd }: { name: string; onContinue: () => void; onPause: () => void; onEnd: () => void }) {
  return (
    <div role="status" className={PILL}>
      <span className="min-w-0 truncate text-ink-2">
        <span className="hidden sm:inline">{name}: </span>the next step is on another page
      </span>
      <button type="button" onClick={onContinue} className={cn(PILL_BUTTON, 'ml-2 bg-ink text-white hover:bg-ink/88')}>
        Take me there
      </button>
      <button type="button" onClick={onPause} className={cn(PILL_BUTTON, 'px-2 text-ink-3 hover:bg-sunken hover:text-ink')} aria-label="Pause the tour">
        <Pause className="size-3.5" />
      </button>
      <button type="button" onClick={onEnd} className={cn(PILL_BUTTON, 'px-2 text-ink-3 hover:bg-sunken hover:text-ink')} aria-label="End the tour">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function Paused({ name, onResume, onEnd }: { name: string; onResume: () => void; onEnd: () => void }) {
  return (
    <div role="status" className={PILL}>
      <span className="min-w-0 truncate text-ink-2">
        Tour paused<span className="hidden sm:inline">: {name.toLowerCase()}</span>
      </span>
      <button type="button" onClick={onResume} className={cn(PILL_BUTTON, 'ml-2 bg-ink text-white hover:bg-ink/88')}>
        Resume
      </button>
      <button type="button" onClick={onEnd} className={cn(PILL_BUTTON, 'px-2 text-ink-3 hover:bg-sunken hover:text-ink')} aria-label="End the tour">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

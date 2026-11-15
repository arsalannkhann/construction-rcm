'use client';

/**
 * Small, dependency-free charts for the overview page.
 *
 * Rules these follow (see the dataviz notes in docs/conventions.md):
 *  - colour does one job per chart: series identity (two validated hues) or
 *    status (the app's pass / warn / block / accent tokens, always with a label);
 *  - text is always ink, never the series colour;
 *  - thin marks, a 2px surface gap between touching marks, hairline grid;
 *  - every mark has a hover/focus tooltip, and every chart carries a
 *    screen-reader table, so no value is reachable only by hovering.
 */
import Link from 'next/link';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { cn, formatMonth } from '@/lib/utils';

// Validated as a categorical pair on a white surface (CVD and normal-vision separation, contrast >= 3:1).
export const SERIES = { requested: '#eb6834', approved: '#1f4fd1' } as const;
const STATUS_FILL = { block: '#c2371f', warn: '#d8952b', accent: '#1f4fd1', neutral: '#77766f', quiet: '#c9c8c1', pass: '#1b7a4a' } as const;

// ── Tooltip ─────────────────────────────────────────────────────────────────

type Tip = { x: number; y: number; content: React.ReactNode } | null;

function useTip() {
  const [tip, setTip] = useState<Tip>(null);
  const bind = useCallback(
    (content: React.ReactNode) => ({
      onPointerMove: (e: React.PointerEvent) => setTip({ x: e.clientX, y: e.clientY, content }),
      onPointerLeave: () => setTip(null),
      onFocus: (e: React.FocusEvent) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setTip({ x: r.left + r.width / 2, y: r.top, content });
      },
      onBlur: () => setTip(null),
    }),
    [],
  );
  const node = tip ? (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 min-w-36 rounded-lg border border-line bg-surface px-2.5 py-2 text-xs shadow-pop"
      style={{ left: Math.min(tip.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 230), top: Math.max(8, tip.y - 12) }}
    >
      {tip.content}
    </div>
  ) : null;
  return { bind, node };
}

function TipRow({ color, label, value, line }: { color?: string; label: string; value: string; line?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <span className="flex items-center gap-1.5 text-ink-3">
        {color ? <span className={cn('inline-block shrink-0 rounded-full', line ? 'h-0.5 w-3' : 'h-0.5 w-3')} style={{ background: color }} /> : null}
        {label}
      </span>
      <span className="num font-semibold text-ink">{value}</span>
    </div>
  );
}

function Legend({ items }: { items: Array<{ color: string; label: string }> }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5 text-xs text-ink-2">
          <span className="size-2.5 rounded-[3px]" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** A round axis maximum and its tick step, so gridlines land on clean numbers. */
function niceScale(max: number, ticks = 4): { max: number; step: number } {
  if (max <= 0) return { max: 1, step: 1 };
  const rough = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  return { max: step * Math.ceil(max / step), step };
}

// ── Requested vs approved, by billing period ────────────────────────────────

export type MonthlyPoint = { month: string; requested: number; approved: number; applications: number; undecided: number };

export function BillingByPeriod({ data }: { data: MonthlyPoint[] }) {
  const { bind, node } = useTip();
  const peak = Math.max(...data.map((d) => Math.max(d.requested, d.approved)), 0);
  const scale = niceScale(peak);
  const ticks = Array.from({ length: Math.round(scale.max / scale.step) + 1 }, (_, i) => i * scale.step);
  const H = 190;
  const last = data.length - 1;

  return (
    <figure>
      <div className="mb-3 flex items-center justify-between">
        <Legend
          items={[
            { color: SERIES.requested, label: 'Requested by subcontractors' },
            { color: SERIES.approved, label: 'Approved' },
          ]}
        />
      </div>
      <div className="flex">
        <div className="relative w-12 shrink-0" style={{ height: H }} aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="num absolute right-2 -translate-y-1/2 text-[10.5px] text-ink-3" style={{ top: H - (t / scale.max) * H }}>
              {formatMoneyCompact(t)}
            </span>
          ))}
        </div>
        <div className="relative flex-1">
          <div className="absolute inset-0" aria-hidden>
            {ticks.map((t) => (
              <div key={t} className={cn('absolute inset-x-0 h-px', t === 0 ? 'bg-line-strong' : 'bg-line')} style={{ top: H - (t / scale.max) * H }} />
            ))}
          </div>
          <div className="relative flex" style={{ height: H }}>
            {data.map((d, i) => {
              const bar = (value: number, color: string, label: string) => {
                const h = Math.max(value > 0 ? 2 : 0, (value / scale.max) * H);
                return (
                  <div className="relative flex w-[22px] flex-col justify-end" style={{ height: H }}>
                    {/* Direct labels on the latest period only; the rest is on the axis and in the tooltip. */}
                    {i === last && value > 0 ? (
                      <span className="num absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[10.5px] font-medium text-ink" style={{ bottom: h + 4 }}>
                        {formatMoneyCompact(value)}
                      </span>
                    ) : null}
                    <div className="w-full rounded-t-[4px] transition-opacity group-hover:opacity-90" style={{ height: h, background: color }} aria-label={`${label} ${formatMoney(value)}`} />
                  </div>
                );
              };
              return (
                <div
                  key={d.month}
                  tabIndex={0}
                  className="focus-ring group flex flex-1 items-end justify-center gap-[2px] rounded-sm outline-none hover:bg-ink/[0.035] focus-visible:bg-ink/[0.035]"
                  {...bind(
                    <>
                      <div className="mb-1 font-medium text-ink">{formatMonth(d.month)}</div>
                      <TipRow color={SERIES.requested} label="Requested" value={formatMoney(d.requested)} />
                      <TipRow color={SERIES.approved} label="Approved" value={formatMoney(d.approved)} />
                      <div className="mt-1 border-t border-line pt-1 text-ink-3">
                        {d.applications} application{d.applications === 1 ? '' : 's'}
                        {d.undecided ? `, ${d.undecided} not yet approved` : ''}
                      </div>
                    </>,
                  )}
                >
                  {bar(d.requested, SERIES.requested, 'Requested')}
                  {bar(d.approved, SERIES.approved, 'Approved')}
                </div>
              );
            })}
          </div>
          <div className="mt-1.5 flex">
            {data.map((d, i) => (
              <span key={d.month} className="flex-1 text-center text-[11px] text-ink-3">
                {i === 0 || d.month.endsWith('-01') ? formatMonth(d.month) : formatMonth(d.month).slice(0, 3)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <table className="sr-only">
        <caption>Requested and approved billing by period</caption>
        <thead>
          <tr>
            <th>Period</th>
            <th>Requested</th>
            <th>Approved</th>
            <th>Applications</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.month}>
              <td>{formatMonth(d.month)}</td>
              <td>{formatMoney(d.requested)}</td>
              <td>{formatMoney(d.approved)}</td>
              <td>{d.applications}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {node}
    </figure>
  );
}

// ── Work in progress, by status ─────────────────────────────────────────────

export type PipelineSegment = { key: string; label: string; count: number; amount: number; tone: keyof typeof STATUS_FILL; href: string };

export function PipelineBar({ segments }: { segments: PipelineSegment[] }) {
  const { bind, node } = useTip();
  const total = segments.reduce((t, s) => t + s.count, 0);
  return (
    <div>
      <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full bg-sunken" role="img" aria-label={`${total} open applications by status`}>
        {segments
          .filter((s) => s.count > 0)
          .map((s) => (
            <div
              key={s.key}
              className="h-full first:rounded-l-full last:rounded-r-full hover:opacity-85"
              style={{ width: `${(s.count / total) * 100}%`, background: STATUS_FILL[s.tone] }}
              {...bind(
                <>
                  <div className="mb-1 font-medium text-ink">{s.label}</div>
                  <TipRow label="Applications" value={String(s.count)} />
                  <TipRow label="Amount" value={formatMoney(s.amount)} />
                </>,
              )}
            />
          ))}
      </div>
      <ul className="mt-3 space-y-0.5">
        {segments.map((s) => (
          <li key={s.key}>
            <Link href={s.href} className="focus-ring -mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-sunken/70">
              <span className="size-2 shrink-0 rounded-full" style={{ background: s.count ? STATUS_FILL[s.tone] : 'var(--color-line-strong)' }} />
              <span className={cn('flex-1', s.count ? 'text-ink' : 'text-ink-3')}>{s.label}</span>
              <span className="num text-xs text-ink-3">{s.count ? formatMoneyCompact(s.amount) : ''}</span>
              <span className={cn('num w-6 text-right font-medium', s.count ? 'text-ink' : 'text-ink-4')}>{s.count}</span>
            </Link>
          </li>
        ))}
      </ul>
      {node}
    </div>
  );
}

// ── Open findings, by kind ──────────────────────────────────────────────────

export type CategoryCount = { label: string; blocking: number; warnings: number };

export function FindingsByCategory({ data }: { data: CategoryCount[] }) {
  const { bind, node } = useTip();
  const peak = Math.max(...data.map((d) => d.blocking + d.warnings), 1);
  return (
    <figure>
      <div className="mb-3">
        <Legend
          items={[
            { color: STATUS_FILL.block, label: 'Blocking' },
            { color: STATUS_FILL.warn, label: 'Warning' },
          ]}
        />
      </div>
      <ul className="space-y-2">
        {data.map((d) => (
          <li
            key={d.label}
            tabIndex={0}
            className="focus-ring grid grid-cols-[132px_1fr_auto] items-center gap-3 rounded-sm outline-none"
            {...bind(
              <>
                <div className="mb-1 font-medium text-ink">{d.label}</div>
                <TipRow color={STATUS_FILL.block} label="Blocking" value={String(d.blocking)} />
                <TipRow color={STATUS_FILL.warn} label="Warning" value={String(d.warnings)} />
              </>,
            )}
          >
            <span className="truncate text-xs text-ink-2">{d.label}</span>
            <span className="flex h-3 gap-[2px]">
              {d.blocking ? <span className="h-full rounded-r-[4px]" style={{ width: `${(d.blocking / peak) * 100}%`, background: STATUS_FILL.block, borderRadius: d.warnings ? 0 : undefined }} /> : null}
              {d.warnings ? <span className="h-full rounded-r-[4px]" style={{ width: `${(d.warnings / peak) * 100}%`, background: STATUS_FILL.warn }} /> : null}
            </span>
            <span className="num w-5 text-right text-xs font-medium text-ink">{d.blocking + d.warnings}</span>
          </li>
        ))}
      </ul>
      <table className="sr-only">
        <caption>Open findings by kind</caption>
        <thead>
          <tr>
            <th>Kind</th>
            <th>Blocking</th>
            <th>Warning</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <td>{d.label}</td>
              <td>{d.blocking}</td>
              <td>{d.warnings}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {node}
    </figure>
  );
}

// ── Turnaround trend ────────────────────────────────────────────────────────

export type TrendPoint = { month: string; value: number | null; sample: number };

export function TurnaroundTrend({ data }: { data: TrendPoint[] }) {
  const { bind, node } = useTip();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 96;
  const padTop = 14;
  const padBottom = 6;
  const points = data.filter((d) => d.value !== null);
  const scale = niceScale(Math.max(...points.map((d) => d.value!), 1), 2);
  const band = data.length ? width / data.length : 0;
  const x = (i: number) => band * i + band / 2;
  const y = (v: number) => padTop + (1 - v / scale.max) * (H - padTop - padBottom);
  // Break the line where a month has no decisions, rather than drawing through it.
  const runs: Array<Array<{ i: number; v: number }>> = [];
  data.forEach((d, i) => {
    if (d.value === null) return;
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun[lastRun.length - 1]!.i === i - 1) lastRun.push({ i, v: d.value });
    else runs.push([{ i, v: d.value }]);
  });
  const end = points.length ? { i: data.lastIndexOf(points[points.length - 1]!), v: points[points.length - 1]!.value! } : null;

  return (
    <figure>
      <div ref={box} className="relative" style={{ height: H }}>
        {width > 0 ? (
          <svg width={width} height={H} className="absolute inset-0 overflow-visible" aria-hidden>
            <line x1={0} x2={width} y1={y(0)} y2={y(0)} stroke="var(--color-line-strong)" strokeWidth={1} />
            <line x1={0} x2={width} y1={y(scale.max)} y2={y(scale.max)} stroke="var(--color-line)" strokeWidth={1} />
            {runs.map((run, r) => (
              <polyline key={r} points={run.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')} fill="none" stroke="var(--color-ink)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {data.map((d, i) => (d.value === null ? null : <circle key={d.month} cx={x(i)} cy={y(d.value)} r={i === end?.i ? 4.5 : 3} fill="var(--color-ink)" stroke="var(--color-surface)" strokeWidth={2} />))}
            {end ? (
              <text x={Math.min(x(end.i), width - 4)} y={y(end.v) - 10} textAnchor={x(end.i) > width - 40 ? 'end' : 'middle'} className="num fill-ink text-[11px] font-medium">
                {end.v.toFixed(1)} d
              </text>
            ) : null}
          </svg>
        ) : null}
        <span className="num absolute left-0 text-[10.5px] text-ink-3" style={{ top: y(scale.max) - 14 }}>
          {scale.max} days
        </span>
        {/* Hit targets: the whole month column, not the 6px dot. */}
        <div className="absolute inset-0 flex">
          {data.map((d) => (
            <div
              key={d.month}
              tabIndex={0}
              className="focus-ring flex-1 rounded-sm outline-none hover:bg-ink/[0.035] focus-visible:bg-ink/[0.035]"
              {...bind(
                <>
                  <div className="mb-1 font-medium text-ink">{formatMonth(d.month)}</div>
                  {d.value === null ? <div className="text-ink-3">No applications decided</div> : <TipRow color="var(--color-ink)" line label="Receipt to decision" value={`${d.value.toFixed(1)} days`} />}
                  {d.sample ? <div className="mt-1 text-ink-3">{d.sample} decided</div> : null}
                </>,
              )}
            />
          ))}
        </div>
      </div>
      <div className="mt-1.5 flex">
        {data.map((d) => (
          <span key={d.month} className="flex-1 text-center text-[11px] text-ink-3">
            {formatMonth(d.month).slice(0, 3)}
          </span>
        ))}
      </div>
      <table className="sr-only">
        <caption>Average days from receipt to decision, by month decided</caption>
        <thead>
          <tr>
            <th>Month</th>
            <th>Days</th>
            <th>Decided</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.month}>
              <td>{formatMonth(d.month)}</td>
              <td>{d.value === null ? 'None' : d.value.toFixed(1)}</td>
              <td>{d.sample}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {node}
    </figure>
  );
}

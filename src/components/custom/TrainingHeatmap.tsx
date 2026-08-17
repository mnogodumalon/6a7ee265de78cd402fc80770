/**
 * GitHub-style month heatmap of training activity.
 *
 * @prop daySets  - Map of day-key (yyyy-MM-dd) → number of sets logged
 * @prop months   - How many months back to show (default 3)
 * @prop today    - Today's date (from useClock — never use new Date() inside)
 * @prop onDayClick - Called when user taps a day cell with sets > 0
 */

import { useState, useMemo } from 'react';
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  getDay,
  subMonths,
  startOfWeek,
  endOfWeek,
  isFuture,
  isToday,
} from 'date-fns';
import { tx } from '@/i18n';
import { dateFnsLocale } from '@/i18n';

export interface TrainingHeatmapProps {
  /** Map of day-key (yyyy-MM-dd) → number of sets logged */
  daySets: Record<string, number>;
  /** How many months back to show (default 3) */
  months?: number;
  /** Today's date (from useClock — never use new Date() inside) */
  today: Date;
  /** Called when user taps a day cell with sets > 0 */
  onDayClick: (dayKey: string) => void;
}

function intensityClass(sets: number, future: boolean): string {
  if (future) return 'bg-muted/20';
  if (sets === 0) return 'bg-muted/30';
  if (sets <= 2) return 'bg-primary/30';
  if (sets <= 5) return 'bg-primary/60';
  return 'bg-primary';
}

// Returns 0=Mon … 6=Sun (ISO weekday index)
function isoWeekday(d: Date): number {
  const dow = getDay(d); // 0=Sun
  return dow === 0 ? 6 : dow - 1;
}

interface WeekColumn {
  weekStart: Date;
  days: (Date | null)[]; // 7 slots, null = padding
}

export function TrainingHeatmap({
  daySets,
  months = 3,
  today,
  onDayClick,
}: TrainingHeatmapProps) {
  const [tooltip, setTooltip] = useState<{ dayKey: string; sets: number; label: string } | null>(null);

  const { weeks, monthLabels } = useMemo(() => {
    // Range: start of (today - months + 1) month … end of today's month
    const rangeStart = startOfMonth(subMonths(today, months - 1));
    const rangeEnd = endOfMonth(today);

    // Extend to full weeks (Mon–Sun)
    const gridStart = startOfWeek(rangeStart, { weekStartsOn: 1 });
    const gridEnd = endOfWeek(rangeEnd, { weekStartsOn: 1 });

    const allDays = eachDayOfInterval({ start: gridStart, end: gridEnd });

    // Group into week columns
    const weekMap = new Map<string, (Date | null)[]>();
    for (const d of allDays) {
      const wKey = format(startOfWeek(d, { weekStartsOn: 1 }), 'yyyy-MM-dd');
      if (!weekMap.has(wKey)) {
        weekMap.set(wKey, Array(7).fill(null));
      }
      weekMap.get(wKey)![isoWeekday(d)] = d;
    }

    const weekColumns: WeekColumn[] = Array.from(weekMap.entries()).map(([wKey, days]) => ({
      weekStart: new Date(wKey),
      days,
    }));

    // Month labels: record the column index of the first week that falls in each month
    const labels: { label: string; colIndex: number }[] = [];
    let lastMonth = -1;
    weekColumns.forEach((wc, idx) => {
      // Find first non-null day in week
      const firstDay = wc.days.find((d) => d !== null);
      if (!firstDay) return;
      const m = firstDay.getMonth();
      if (m !== lastMonth) {
        // Only label months within [rangeStart, rangeEnd]
        if (firstDay >= rangeStart && firstDay <= rangeEnd) {
          labels.push({
            label: format(firstDay, 'MMM', { locale: dateFnsLocale() }),
            colIndex: idx,
          });
        }
        lastMonth = m;
      }
    });

    return { weeks: weekColumns, monthLabels: labels };
  }, [today, months]);

  const dayLabels = useMemo(
    () => [
      tx('Mo'),
      tx('Di'),
      tx('Mi'),
      tx('Do'),
      tx('Fr'),
      tx('Sa'),
      tx('So'),
    ],
    []
  );

  const totalCols = weeks.length;

  return (
    <div className="w-full select-none">
      {/* Month label row */}
      <div
        className="relative mb-1 h-5"
        style={{ display: 'grid', gridTemplateColumns: `20px repeat(${totalCols}, 1fr)`, gap: '2px' }}
      >
        {/* placeholder for day-label column */}
        <div />
        {weeks.map((_, colIdx) => {
          const lbl = monthLabels.find((ml) => ml.colIndex === colIdx);
          return (
            <div key={colIdx} className="relative">
              {lbl && (
                <span className="absolute left-0 top-0 text-[10px] text-muted-foreground whitespace-nowrap">
                  {lbl.label}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Main grid */}
      <div
        className="relative"
        style={{ display: 'grid', gridTemplateColumns: `20px repeat(${totalCols}, 1fr)`, gap: '2px' }}
      >
        {/* Day-of-week labels column */}
        <div
          style={{ display: 'grid', gridTemplateRows: 'repeat(7, 1fr)', gap: '2px' }}
          className="pr-1"
        >
          {dayLabels.map((lbl, i) => (
            <div
              key={i}
              className="text-[9px] text-muted-foreground flex items-center justify-end leading-none"
            >
              {/* Only show Mon, Wed, Fri to keep it compact */}
              {(i === 0 || i === 2 || i === 4) ? lbl : ''}
            </div>
          ))}
        </div>

        {/* Week columns */}
        {weeks.map((wc, colIdx) => (
          <div
            key={colIdx}
            style={{ display: 'grid', gridTemplateRows: 'repeat(7, 1fr)', gap: '2px' }}
          >
            {wc.days.map((day, rowIdx) => {
              if (!day) {
                return <div key={rowIdx} />;
              }
              const dayKey = format(day, 'yyyy-MM-dd');
              const sets = daySets[dayKey] ?? 0;
              const future = isFuture(day) && !isToday(day);
              const todayFlag = isToday(day);
              const clickable = sets > 0 && !future;

              return (
                <div
                  key={rowIdx}
                  className={[
                    'aspect-square rounded-sm transition-opacity',
                    intensityClass(sets, future),
                    clickable ? 'cursor-pointer hover:opacity-80' : 'cursor-default',
                    todayFlag ? 'ring-1 ring-primary ring-offset-1 ring-offset-background' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ minWidth: 0, minHeight: 0 }}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  aria-label={
                    clickable
                      ? tx`${format(day, 'dd.MM.yyyy', { locale: dateFnsLocale() })} – ${sets} Sätze`
                      : tx`${format(day, 'dd.MM.yyyy', { locale: dateFnsLocale() })} – Kein Training`
                  }
                  onMouseEnter={() =>
                    setTooltip({
                      dayKey,
                      sets,
                      label: format(day, 'dd. MMM yyyy', { locale: dateFnsLocale() }),
                    })
                  }
                  onMouseLeave={() => setTooltip(null)}
                  onFocus={() =>
                    setTooltip({
                      dayKey,
                      sets,
                      label: format(day, 'dd. MMM yyyy', { locale: dateFnsLocale() }),
                    })
                  }
                  onBlur={() => setTooltip(null)}
                  onClick={() => {
                    if (clickable) onDayClick(dayKey);
                  }}
                  onKeyDown={(e) => {
                    if (clickable && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      onDayClick(dayKey);
                    }
                  }}
                />
              );
            })}
          </div>
        ))}

        {/* Tooltip */}
        {tooltip && (
          <div
            className="pointer-events-none absolute z-10 -top-9 left-1/2 -translate-x-1/2 bg-popover text-popover-foreground text-xs rounded px-2 py-1 shadow-md whitespace-nowrap border border-border"
            aria-hidden
          >
            <span className="font-medium">{tooltip.label}</span>
            {' — '}
            {tooltip.sets > 0
              ? tx`${tooltip.sets} Sätze`
              : tx('Kein Training')}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="mt-3 flex items-center gap-2 justify-end">
        <span className="text-[10px] text-muted-foreground">{tx('Weniger')}</span>
        {(['bg-muted/30', 'bg-primary/30', 'bg-primary/60', 'bg-primary'] as const).map(
          (cls, i) => (
            <div
              key={i}
              className={`w-3 h-3 rounded-sm ${cls}`}
              aria-hidden
            />
          )
        )}
        <span className="text-[10px] text-muted-foreground">{tx('Mehr')}</span>
      </div>
    </div>
  );
}

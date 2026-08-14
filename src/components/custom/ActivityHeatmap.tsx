/**
 * GitHub-style activity heatmap for workout tracking — 13 weeks × 7 weekdays grid.
 * @prop days — array of {dayKey, sets} for days with training data
 * @prop todayKey — 'yyyy-MM-dd' key for today, marks the cell and defines display range
 * @prop onDayClick — called with dayKey when a cell is tapped
 */
import { format, parseISO, addDays, startOfWeek, eachDayOfInterval } from 'date-fns';
import { tx, dateFnsLocale } from '@/i18n';
import { useState } from 'react';

export interface ActivityHeatmapProps {
  /** Array of {dayKey: 'yyyy-MM-dd', sets: number} — one entry per day that has training data */
  days: Array<{ dayKey: string; sets: number }>;
  /** The 'today' date key in 'yyyy-MM-dd' format — used to mark today and determine display range */
  todayKey: string;
  /** Called when user taps a day cell — passes the dayKey */
  onDayClick: (dayKey: string) => void;
}

function cellColor(sets: number): string {
  if (sets === 0) return 'bg-muted';
  if (sets <= 2) return 'bg-primary/30';
  if (sets <= 4) return 'bg-primary/60';
  return 'bg-primary';
}

export function ActivityHeatmap({ days, todayKey, onDayClick }: ActivityHeatmapProps) {
  const [tooltip, setTooltip] = useState<{ dayKey: string; sets: number; x: number; y: number } | null>(null);

  // Build lookup map from dayKey → sets
  const setsMap = new Map<string, number>(days.map(d => [d.dayKey, d.sets]));

  // Compute 13-week grid: start = Monday of the week 13 weeks before the current week
  const today = parseISO(todayKey);
  // The rightmost column is the week containing today; oldest column is 12 weeks back
  const weekStart = startOfWeek(today, { weekStartsOn: 1 }); // Monday
  const gridStart = addDays(weekStart, -12 * 7); // 13 weeks total (0..12)
  const gridEnd = addDays(weekStart, 6); // Sunday of current week

  const allDays = eachDayOfInterval({ start: gridStart, end: gridEnd });

  // Organize into 13 columns (weeks), each with up to 7 rows (Mon=0..Sun=6)
  // allDays.length = 91 exactly
  const NUM_WEEKS = 13;
  const weeks: Array<Array<{ dayKey: string; sets: number; date: Date } | null>> = [];
  for (let w = 0; w < NUM_WEEKS; w++) {
    const col: Array<{ dayKey: string; sets: number; date: Date } | null> = [];
    for (let d = 0; d < 7; d++) {
      const idx = w * 7 + d;
      if (idx < allDays.length) {
        const date = allDays[idx];
        const dayKey = format(date, 'yyyy-MM-dd');
        col.push({ dayKey, sets: setsMap.get(dayKey) ?? 0, date });
      } else {
        col.push(null);
      }
    }
    weeks.push(col);
  }

  // Month labels: for each column, show abbreviated month if the first day of month appears
  const monthLabels: Array<string> = weeks.map(col => {
    for (const cell of col) {
      if (cell && cell.date.getDate() === 1) {
        return format(cell.date, 'MMM', { locale: dateFnsLocale() });
      }
    }
    return '';
  });

  const weekdayLabels = [
    tx('Mo'), tx('Di'), tx('Mi'), tx('Do'), tx('Fr'), tx('Sa'), tx('So'),
  ];

  return (
    <div className="relative select-none">
      {/* Tooltip */}
      {tooltip && (
        <div
          className="pointer-events-none fixed z-50 rounded-md bg-popover border border-border px-2 py-1 text-xs text-popover-foreground shadow-md"
          style={{ left: tooltip.x + 12, top: tooltip.y - 32 }}
        >
          <span className="font-medium">{tooltip.dayKey}</span>
          {' — '}
          {tooltip.sets === 0
            ? tx('Kein Training')
            : tooltip.sets === 1
            ? tx('1 Satz')
            : <>{tooltip.sets} {tx('Sätze')}</>}
        </div>
      )}

      <div className="flex gap-1 overflow-x-auto pb-1">
        {/* Weekday label column */}
        <div className="flex flex-col gap-0.5 pt-5 shrink-0">
          {weekdayLabels.map((label, i) => (
            <div
              key={i}
              className="h-[10px] md:h-[12px] flex items-center text-[9px] text-muted-foreground leading-none pr-1"
              style={{ lineHeight: '10px' }}
            >
              {/* Show only Mon, Wed, Fri to avoid crowding */}
              {i % 2 === 0 ? label : ''}
            </div>
          ))}
        </div>

        {/* Week columns */}
        <div className="flex gap-0.5">
          {weeks.map((col, wi) => (
            <div key={wi} className="flex flex-col gap-0.5">
              {/* Month label */}
              <div className="h-4 flex items-end pb-0.5">
                {monthLabels[wi] ? (
                  <span className="text-[9px] text-muted-foreground leading-none whitespace-nowrap">
                    {monthLabels[wi]}
                  </span>
                ) : null}
              </div>
              {/* Day cells */}
              {col.map((cell, di) => {
                if (!cell) {
                  return (
                    <div
                      key={di}
                      className="w-[10px] h-[10px] md:w-[12px] md:h-[12px] rounded-sm bg-muted opacity-0"
                    />
                  );
                }
                const isToday = cell.dayKey === todayKey;
                return (
                  <button
                    key={di}
                    type="button"
                    aria-label={`${cell.dayKey}: ${cell.sets} ${cell.sets === 1 ? tx('Satz') : tx('Sätze')}`}
                    className={[
                      'w-[10px] h-[10px] md:w-[12px] md:h-[12px] rounded-sm cursor-pointer transition-opacity',
                      cellColor(cell.sets),
                      isToday ? 'ring-1 ring-primary ring-offset-1' : '',
                    ].join(' ')}
                    onClick={() => onDayClick(cell.dayKey)}
                    onMouseEnter={e => {
                      const rect = (e.target as HTMLElement).getBoundingClientRect();
                      setTooltip({ dayKey: cell.dayKey, sets: cell.sets, x: rect.left, y: rect.top });
                    }}
                    onMouseLeave={() => setTooltip(null)}
                    onFocus={e => {
                      const rect = (e.target as HTMLElement).getBoundingClientRect();
                      setTooltip({ dayKey: cell.dayKey, sets: cell.sets, x: rect.left, y: rect.top });
                    }}
                    onBlur={() => setTooltip(null)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-1.5 mt-2">
        <span className="text-[10px] text-muted-foreground">{tx('Weniger')}</span>
        {(['bg-muted', 'bg-primary/30', 'bg-primary/60', 'bg-primary'] as const).map((cls, i) => (
          <div key={i} className={`w-[10px] h-[10px] md:w-[12px] md:h-[12px] rounded-sm ${cls}`} />
        ))}
        <span className="text-[10px] text-muted-foreground">{tx('Mehr')}</span>
      </div>
    </div>
  );
}

/**
 * Monthly activity heatmap calendar showing training intensity per day.
 * @prop dayCounts - Map of day key (yyyy-MM-dd) → number of sets logged
 * @prop month - The month to display, as a Date (first day of month)
 * @prop onDayClick - Called when user clicks a day cell — passes the day key
 * @prop selectedDay - Currently selected day key, highlights that cell
 * @prop onPrevMonth - Navigation: go to previous month
 * @prop onNextMonth - Navigation: go to next month
 */
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDay, isToday } from 'date-fns';
import { tx, dateFnsLocale } from '@/i18n';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';

export interface ActivityHeatmapProps {
  /** Map of day key (yyyy-MM-dd) → number of sets logged */
  dayCounts: Record<string, number>;
  /** The month to display, as a Date (first day of month) */
  month: Date;
  /** Called when user clicks a day cell — passes the day key */
  onDayClick?: (dayKey: string) => void;
  /** Currently selected day key, highlights that cell */
  selectedDay?: string | null;
  /** Navigation: go to previous month */
  onPrevMonth?: () => void;
  /** Navigation: go to next month */
  onNextMonth?: () => void;
}

function intensityClass(count: number): string {
  if (count === 0) return 'bg-muted';
  if (count <= 3) return 'bg-green-200 dark:bg-green-900';
  if (count <= 6) return 'bg-green-400 dark:bg-green-700';
  return 'bg-green-600 dark:bg-green-500';
}

/** Convert Sunday-first (0=Sun) to Monday-first (0=Mon) */
function mondayFirst(dayOfWeek: number): number {
  return (dayOfWeek + 6) % 7;
}

export function ActivityHeatmap({
  dayCounts,
  month,
  onDayClick,
  selectedDay,
  onPrevMonth,
  onNextMonth,
}: ActivityHeatmapProps) {
  const locale = dateFnsLocale();

  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });

  // Leading empty cells so first day lands on the right weekday (Mon=0)
  const leadingEmpties = mondayFirst(getDay(monthStart));

  // Total cells = leadingEmpties + days, padded to a multiple of 7 (5 rows = 35)
  const totalCells = Math.ceil((leadingEmpties + days.length) / 7) * 7;

  const monthLabel = format(month, 'MMMM yyyy', { locale });

  const totalSets = Object.entries(dayCounts).reduce((sum, [key, count]) => {
    // Only count days in this month
    const prefix = format(month, 'yyyy-MM');
    return key.startsWith(prefix) ? sum + count : sum;
  }, 0);

  const weekdays = [
    tx('Mo'), tx('Di'), tx('Mi'), tx('Do'), tx('Fr'), tx('Sa'), tx('So'),
  ];

  return (
    <div className="flex flex-col gap-3 select-none">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onPrevMonth}
          aria-label={tx('Vorheriger Monat')}
          className="p-1.5 rounded-md hover:bg-muted transition-colors shrink-0"
        >
          <IconChevronLeft size={16} className="shrink-0" />
        </button>

        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-sm truncate">{monthLabel}</span>
          <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full whitespace-nowrap shrink-0">
            {tx`${totalSets} Sätze`}
          </span>
        </div>

        <button
          type="button"
          onClick={onNextMonth}
          aria-label={tx('Nächster Monat')}
          className="p-1.5 rounded-md hover:bg-muted transition-colors shrink-0"
        >
          <IconChevronRight size={16} className="shrink-0" />
        </button>
      </div>

      {/* Weekday labels */}
      <div className="grid grid-cols-7 gap-1">
        {weekdays.map((wd, i) => (
          <div
            key={i}
            className="text-center text-[10px] font-medium text-muted-foreground pb-0.5"
          >
            {wd}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: totalCells }).map((_, idx) => {
          const dayIdx = idx - leadingEmpties;
          const day = dayIdx >= 0 && dayIdx < days.length ? days[dayIdx] : null;

          if (!day) {
            return <div key={idx} className="aspect-square min-h-[36px]" />;
          }

          const dayKey = format(day, 'yyyy-MM-dd');
          const count = dayCounts[dayKey] ?? 0;
          const isSelected = selectedDay === dayKey;
          const todayDot = isToday(day);

          return (
            <button
              key={dayKey}
              type="button"
              onClick={() => onDayClick?.(dayKey)}
              aria-label={`${format(day, 'd. MMMM', { locale })}: ${tx`${count} Sätze`}`}
              title={`${format(day, 'd. MMMM', { locale })}: ${tx`${count} Sätze`}`}
              className={[
                'relative flex flex-col items-center justify-start pt-1 rounded-md',
                'aspect-square min-h-[36px] min-w-[36px] w-full',
                'transition-all cursor-pointer',
                intensityClass(count),
                isSelected ? 'ring-2 ring-primary' : '',
                onDayClick ? 'hover:opacity-80 active:scale-95' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span className="text-[10px] font-medium leading-none z-10">
                {format(day, 'd')}
              </span>
              {todayDot && (
                <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary" />
              )}
            </button>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 flex-wrap pt-1">
        <LegendItem colorClass="bg-muted" label={tx('Pause')} />
        <LegendItem colorClass="bg-green-200 dark:bg-green-900" label={tx('Leicht')} />
        <LegendItem colorClass="bg-green-400 dark:bg-green-700" label={tx('Mittel')} />
        <LegendItem colorClass="bg-green-600 dark:bg-green-500" label={tx('Intensiv')} />
      </div>
    </div>
  );
}

function LegendItem({ colorClass, label }: { colorClass: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={`w-3 h-3 rounded-sm shrink-0 ${colorClass}`} />
      <span>{label}</span>
    </div>
  );
}

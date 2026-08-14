/**
 * TrainingHeatmap – monthly calendar heatmap showing training intensity (sets per day).
 * @prop dayCounts  - ISO date strings 'yyyy-MM-dd' → number of sets logged that day
 * @prop month      - The month to display, formatted 'yyyy-MM'
 * @prop onDayClick - Called when the user taps a day cell
 * @prop today      - Highlight this day as 'today' (formatted 'yyyy-MM-dd')
 */
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDay, parseISO } from 'date-fns';
import { dateFnsLocale, tx } from '@/i18n';

export interface TrainingHeatmapProps {
  /** ISO date strings 'yyyy-MM-dd' → number of sets logged that day */
  dayCounts: Record<string, number>;
  /** The month to display, formatted 'yyyy-MM' */
  month: string;
  /** Called when the user taps a day cell */
  onDayClick?: (dayKey: string) => void;
  /** Optional: highlight this day as 'today' (formatted 'yyyy-MM-dd') */
  today: string;
}

function intensityClass(count: number): string {
  if (count === 0) return 'bg-muted';
  if (count <= 2) return 'bg-green-500/20';
  if (count <= 5) return 'bg-green-500/50';
  return 'bg-green-500/100';
}

export function TrainingHeatmap({ dayCounts, month, onDayClick, today }: TrainingHeatmapProps) {
  const locale = dateFnsLocale();

  const monthStart = startOfMonth(parseISO(month + '-01'));
  const monthEnd = endOfMonth(monthStart);
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });

  // Monday=0 offset: getDay returns 0=Sun,1=Mon,...,6=Sat → remap to Mon=0
  const firstDayOfWeek = getDay(monthStart); // 0=Sun
  const leadingSpacers = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1;

  const monthLabel = format(monthStart, 'MMMM yyyy', { locale });

  const weekdays = [
    tx('Mo'),
    tx('Di'),
    tx('Mi'),
    tx('Do'),
    tx('Fr'),
    tx('Sa'),
    tx('So'),
  ];

  const legendItems: Array<{ cls: string; label: string }> = [
    { cls: 'bg-muted', label: tx('0') },
    { cls: 'bg-green-500/20', label: tx('1–2') },
    { cls: 'bg-green-500/50', label: tx('3–5') },
    { cls: 'bg-green-500/100', label: tx('6+') },
  ];

  return (
    <div className="rounded-2xl bg-card border border-border p-4 flex flex-col gap-3">
      {/* Heading */}
      <h3 className="text-sm font-semibold text-foreground capitalize">{monthLabel}</h3>

      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-1">
        {weekdays.map((wd) => (
          <div
            key={wd}
            className="text-center text-xs text-muted-foreground font-medium py-0.5"
          >
            {wd}
          </div>
        ))}

        {/* Leading spacers */}
        {Array.from({ length: leadingSpacers }).map((_, i) => (
          <div key={`spacer-${i}`} className="aspect-square min-w-0" />
        ))}

        {/* Day cells */}
        {days.map((day) => {
          const dayKey = format(day, 'yyyy-MM-dd');
          const count = dayCounts[dayKey] ?? 0;
          const isToday = dayKey === today;
          const clickable = !!onDayClick;

          return (
            <button
              key={dayKey}
              type="button"
              aria-label={tx(`${format(day, 'd. MMMM', { locale })} — ${count} ${count === 1 ? tx('Satz') : tx('Sätze')}`)}
              title={tx(`${count} ${count === 1 ? tx('Satz') : tx('Sätze')}`)}
              onClick={clickable ? () => onDayClick!(dayKey) : undefined}
              className={[
                'aspect-square min-w-0 rounded-md flex items-center justify-center text-xs font-medium transition-opacity',
                intensityClass(count),
                count === 0 ? 'text-muted-foreground' : 'text-green-900',
                isToday ? 'ring-2 ring-primary' : '',
                clickable ? 'cursor-pointer hover:opacity-80' : 'cursor-default',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {format(day, 'd')}
            </button>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 pt-1 flex-wrap">
        <span className="text-xs text-muted-foreground mr-1">{tx('Sätze:')}</span>
        {legendItems.map((item) => (
          <div key={item.label} className="flex items-center gap-1">
            <span className={`inline-block w-3 h-3 rounded-sm border border-border/50 ${item.cls}`} />
            <span className="text-xs text-muted-foreground">{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Monthly training heatmap — GitHub-style contribution graph for logged training sets.
 * @prop entries - All trainingslog records with datum (ISO datetime) and satz_nummer fields
 * @prop today - Current date used to determine the displayed month and highlight today
 * @prop onDayClick - Called with 'yyyy-MM-dd' key when a day with entries is clicked
 * @prop selectedDay - Currently selected day key 'yyyy-MM-dd' shown with a ring
 */

import { format, parseISO, startOfMonth, endOfMonth, eachDayOfInterval, getDay, addDays } from 'date-fns';
import { dateFnsLocale, tx } from '@/i18n';

export interface TrainingHeatmapProps {
  /** All trainingslog records as plain objects with fields.datum (ISO datetime string) and record_id */
  entries: Array<{ record_id: string; fields: { datum?: string; satz_nummer?: number } }>;
  /** The current date for determining which month to show and today highlight */
  today: Date;
  /** Called when the user clicks on a day that has entries — passes the day key 'yyyy-MM-dd' */
  onDayClick?: (dayKey: string) => void;
  /** Optional: the currently selected day key 'yyyy-MM-dd' */
  selectedDay?: string | null;
}

function intensityClass(count: number): string {
  if (count === 0) return 'bg-muted/40';
  if (count <= 2) return 'bg-primary/30';
  if (count <= 5) return 'bg-primary/60';
  return 'bg-primary';
}

export function TrainingHeatmap({ entries, today, onDayClick, selectedDay }: TrainingHeatmapProps) {
  const locale = dateFnsLocale();

  // Build day-key → set count map
  const countByDay: Record<string, number> = {};
  for (const entry of entries) {
    const datum = entry.fields.datum;
    if (!datum) continue;
    try {
      const key = format(parseISO(datum), 'yyyy-MM-dd');
      countByDay[key] = (countByDay[key] ?? 0) + (entry.fields.satz_nummer ?? 1);
    } catch {
      // skip unparseable dates
    }
  }

  const monthStart = startOfMonth(today);
  const monthEnd = endOfMonth(today);
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });

  // Monday=0 offset: getDay returns 0=Sun,1=Mon,...,6=Sat → remap to Mon=0
  const firstDayOfWeek = (getDay(monthStart) + 6) % 7; // Mon=0 … Sun=6
  const leadingEmpties = firstDayOfWeek;

  const todayKey = format(today, 'yyyy-MM-dd');
  const monthTitle = format(monthStart, 'MMMM yyyy', { locale });

  const totalSets = Object.entries(countByDay).reduce((sum, [key, count]) => {
    const d = parseISO(key);
    if (d >= monthStart && d <= monthEnd) return sum + count;
    return sum;
  }, 0);

  const weekDayLabels = [
    tx('Mo'), tx('Di'), tx('Mi'), tx('Do'), tx('Fr'), tx('Sa'), tx('So'),
  ];

  const legendItems: Array<{ count: number; label: string }> = [
    { count: 0, label: '0' },
    { count: 1, label: '1–2' },
    { count: 3, label: '3–5' },
    { count: 6, label: '6+' },
  ];

  return (
    <div className="flex flex-col gap-3 p-4 bg-card border border-border rounded-2xl">
      {/* Month title */}
      <div className="text-sm font-semibold text-foreground capitalize">{monthTitle}</div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-1">
        {weekDayLabels.map((label, i) => (
          <div
            key={i}
            className="flex items-center justify-center text-[10px] font-medium text-muted-foreground h-5"
          >
            {label}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-1">
        {/* Leading empty cells */}
        {Array.from({ length: leadingEmpties }).map((_, i) => (
          <div key={`empty-${i}`} className="min-h-9 min-w-9 rounded-md" aria-hidden="true" />
        ))}

        {/* Day cells */}
        {days.map((day) => {
          const key = format(day, 'yyyy-MM-dd');
          const count = countByDay[key] ?? 0;
          const isToday = key === todayKey;
          const isSelected = selectedDay === key;
          const hasEntries = count > 0;
          const clickable = hasEntries && !!onDayClick;

          let ringClass = '';
          if (isSelected) ringClass = 'ring-2 ring-foreground ring-offset-1';
          else if (isToday) ringClass = 'ring-2 ring-primary ring-offset-1';

          return (
            <button
              key={key}
              type="button"
              disabled={!clickable}
              onClick={clickable ? () => onDayClick!(key) : undefined}
              title={tx(tx`${count} Sätze`)}
              aria-label={tx(tx`${format(day, 'd. MMMM', { locale })}: ${count} Sätze`)}
              className={[
                'flex items-center justify-center min-h-9 min-w-9 w-full rounded-md text-[10px] font-medium transition-opacity',
                intensityClass(count),
                ringClass,
                count > 0 ? 'text-foreground' : 'text-muted-foreground/50',
                clickable ? 'cursor-pointer hover:opacity-80' : 'cursor-default',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span className="leading-none">{format(day, 'd')}</span>
            </button>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 flex-wrap pt-1">
        <span className="text-[10px] text-muted-foreground">{tx('Intensität')}:</span>
        {legendItems.map(({ count, label }) => (
          <div key={label} className="flex items-center gap-1">
            <div
              className={`w-3.5 h-3.5 rounded-sm shrink-0 ${intensityClass(count)}`}
              aria-hidden="true"
            />
            <span className="text-[10px] text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>

      {/* Total */}
      <div className="text-xs text-muted-foreground border-t border-border pt-2">
        {tx(tx`${totalSets} Sätze diesen Monat`)}
      </div>
    </div>
  );
}

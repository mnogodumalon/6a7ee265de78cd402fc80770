/**
 * TrainingHeatmap — GitHub-style 2-month heatmap of training intensity (sets per day).
 * @prop daySetCounts - Map of yyyy-MM-dd → number of sets logged that day
 * @prop clock - Current date from useClock (never use new Date() here)
 * @prop onDayClick - Called with the day key (yyyy-MM-dd) when a cell is clicked
 */
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameDay,
  startOfWeek,
  endOfWeek,
  subMonths,
} from 'date-fns';
import { dateFnsLocale, tx } from '@/i18n';

export interface TrainingHeatmapProps {
  /** Map of day-key (yyyy-MM-dd) → number of sets logged that day */
  daySetCounts: Record<string, number>;
  /** The current date (from useClock — never call new Date() here) */
  clock: Date;
  /** Called when a day cell is clicked, passing the day key */
  onDayClick: (dayKey: string) => void;
}

function getIntensityClass(sets: number, isFuture: boolean): string {
  const base =
    sets === 0
      ? 'bg-muted'
      : sets <= 2
      ? 'bg-success/30'
      : sets <= 5
      ? 'bg-success/60'
      : 'bg-success';
  return isFuture ? `${base} opacity-40` : base;
}

function buildWeekColumns(monthStart: Date, monthEnd: Date): (Date | null)[][] {
  // We want Mon-Sun rows, week columns
  // Pad from the first Monday at or before monthStart
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
  const allDays = eachDayOfInterval({ start: gridStart, end: gridEnd });

  // chunk into weeks (7 days each)
  const weeks: (Date | null)[][] = [];
  for (let i = 0; i < allDays.length; i += 7) {
    const week = allDays.slice(i, i + 7).map((d) => {
      // only include days that belong to this month
      if (d < monthStart || d > monthEnd) return null;
      return d;
    });
    weeks.push(week);
  }
  return weeks;
}

function MonthGrid({
  monthDate,
  clock,
  daySetCounts,
  onDayClick,
}: {
  monthDate: Date;
  clock: Date;
  daySetCounts: Record<string, number>;
  onDayClick: (dayKey: string) => void;
}) {
  const locale = dateFnsLocale();
  const monthStart = startOfMonth(monthDate);
  const monthEnd = endOfMonth(monthDate);
  const label = format(monthDate, 'LLLL yyyy', { locale });
  const weeks = buildWeekColumns(monthStart, monthEnd);

  // Day-of-week labels: Mo Di Mi Do Fr Sa So
  const dowLabels = [
    tx('Mo'),
    tx('Di'),
    tx('Mi'),
    tx('Do'),
    tx('Fr'),
    tx('Sa'),
    tx('So'),
  ];

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold text-foreground capitalize">{label}</span>
      <div className="flex gap-1">
        {/* Day-of-week label column */}
        <div className="flex flex-col gap-1 mr-1">
          {dowLabels.map((lbl) => (
            <span
              key={lbl}
              className="w-4 h-4 flex items-center justify-center text-[9px] text-muted-foreground leading-none"
            >
              {lbl}
            </span>
          ))}
        </div>
        {/* Week columns */}
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-1">
            {week.map((day, di) => {
              if (!day) {
                return <div key={di} className="w-4 h-4" />;
              }
              const dayKey = format(day, 'yyyy-MM-dd');
              const sets = daySetCounts[dayKey] ?? 0;
              const isToday = isSameDay(day, clock);
              const isFuture = day > clock;
              const intensityClass = getIntensityClass(sets, isFuture);
              const title = tx`${sets} Sets – ${dayKey}`;

              return (
                <button
                  key={di}
                  type="button"
                  onClick={() => onDayClick(dayKey)}
                  title={title}
                  aria-label={title}
                  className={[
                    'w-4 h-4 rounded-sm transition-opacity',
                    intensityClass,
                    isToday ? 'ring-1 ring-primary' : '',
                    'hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TrainingHeatmap({ daySetCounts, clock, onDayClick }: TrainingHeatmapProps) {
  const prevMonth = subMonths(clock, 1);

  const legendItems: { label: string; cls: string }[] = [
    { label: tx('0'), cls: 'bg-muted' },
    { label: tx('wenig'), cls: 'bg-success/30' },
    { label: tx('mittel'), cls: 'bg-success/60' },
    { label: tx('viel'), cls: 'bg-success' },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-8">
        <MonthGrid
          monthDate={prevMonth}
          clock={clock}
          daySetCounts={daySetCounts}
          onDayClick={onDayClick}
        />
        <MonthGrid
          monthDate={clock}
          clock={clock}
          daySetCounts={daySetCounts}
          onDayClick={onDayClick}
        />
      </div>
      {/* Legend */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{tx('Intensität')}:</span>
        {legendItems.map((item) => (
          <div key={item.label} className="flex items-center gap-1">
            <div className={`w-3 h-3 rounded-sm ${item.cls}`} />
            <span className="text-xs text-muted-foreground">{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

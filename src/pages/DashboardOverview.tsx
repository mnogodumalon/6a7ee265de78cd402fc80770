import { useDashboardData } from '@/hooks/useDashboardData';
import { useEntityCrud } from '@/components/EntityCrud';
import { DashboardSkeleton, DashboardError } from '@/components/DashboardStates';
import { DashboardGrid } from '@/components/DashboardGrid';
import { StatStrip, StatStripItem } from '@/components/StatCard';
import { WorkList } from '@/components/WorkList';
import { tx, appLabel } from '@/i18n';
import { useClock, gruss, namen, undoToast } from '@/lib/polish';
import { ActivityHeatmap } from '@/components/custom/ActivityHeatmap';
import { ChartWidget } from '@/components/widgets/ChartWidget';
import { APP_IDS, LOOKUP_OPTIONS, lookupOption } from '@/types/app';
import type { EnrichedTrainingslog } from '@/types/enriched';
import { LivingAppsService, createRecordUrl, extractRecordId } from '@/services/livingAppsService';
import { formatDate } from '@/lib/formatters';
import {
  IconBarbell,
  IconFlame,
  IconTrendingUp,
  IconPlus,
  IconCalendar,
  IconDumbbell,
} from '@tabler/icons-react';
import { useState, useMemo, useCallback } from 'react';
import { format, subMonths, startOfMonth, parseISO, isValid } from 'date-fns';
import { Button } from '@/components/ui/button';

export default function DashboardOverview() {
  const data = useDashboardData();
  const { uebungen, trainingslog, uebungenMap, loading, error, fetchAll } = data;
  const crud = useEntityCrud(data);
  const enrichedTrainingslog = crud.enriched.trainingslog;
  const clock = useClock();

  // Heatmap month navigation
  const [heatmapMonth, setHeatmapMonth] = useState<Date>(() => startOfMonth(new Date()));
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // Selected exercise filter for strength chart
  const [selectedUebungId, setSelectedUebungId] = useState<string | null>(null);

  // Build day counts for heatmap
  const dayCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const entry of trainingslog) {
      if (!entry.fields.datum) continue;
      try {
        const d = parseISO(entry.fields.datum);
        if (!isValid(d)) continue;
        const key = format(d, 'yyyy-MM-dd');
        counts[key] = (counts[key] ?? 0) + 1;
      } catch {
        // ignore
      }
    }
    return counts;
  }, [trainingslog]);

  // Today's training entries
  const todayKey = format(clock, 'yyyy-MM-dd');
  const todayEntries = useMemo(() =>
    enrichedTrainingslog.filter(e => {
      if (!e.fields.datum) return false;
      try {
        return format(parseISO(e.fields.datum), 'yyyy-MM-dd') === todayKey;
      } catch { return false; }
    }),
    [enrichedTrainingslog, todayKey]
  );

  // This week's training days
  const weekEntries = useMemo(() => {
    const days = new Set<string>();
    const weekStart = format(clock, 'yyyy-') + 'W' + format(clock, 'ww');
    for (const e of trainingslog) {
      if (!e.fields.datum) continue;
      try {
        const d = parseISO(e.fields.datum);
        if (!isValid(d)) continue;
        const key = format(d, 'yyyy-MM-dd');
        const ws = format(d, 'yyyy-') + 'W' + format(d, 'ww');
        if (ws === weekStart) days.add(key);
      } catch { /* skip */ }
    }
    return days.size;
  }, [trainingslog, clock]);

  // Total sets logged
  const totalSets = trainingslog.length;

  // Most trained exercise today (for context line)
  const todayExerciseNames = useMemo(() => {
    const names = todayEntries
      .map(e => e.uebungName)
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
    return names;
  }, [todayEntries]);

  // Strength progress per exercise: compare best set (max weight) last 30 days vs prev 30 days
  const strengthProgress = useMemo(() => {
    if (!selectedUebungId) return null;
    const now = clock;
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const forExercise = trainingslog.filter(e => {
      const id = extractRecordId(e.fields.uebung);
      return id === selectedUebungId;
    });

    const recent = forExercise.filter(e => {
      if (!e.fields.datum) return false;
      try {
        const d = parseISO(e.fields.datum);
        return d >= thirtyDaysAgo && d <= now;
      } catch { return false; }
    });
    const prev = forExercise.filter(e => {
      if (!e.fields.datum) return false;
      try {
        const d = parseISO(e.fields.datum);
        return d >= sixtyDaysAgo && d < thirtyDaysAgo;
      } catch { return false; }
    });

    const maxRecent = recent.reduce((m, e) => Math.max(m, e.fields.gewicht_kg ?? 0), 0);
    const maxPrev = prev.reduce((m, e) => Math.max(m, e.fields.gewicht_kg ?? 0), 0);

    if (maxPrev === 0) return maxRecent > 0 ? { pct: null, kg: maxRecent } : null;
    const pct = Math.round(((maxRecent - maxPrev) / maxPrev) * 100);
    return { pct, kg: maxRecent };
  }, [trainingslog, selectedUebungId, clock]);

  // Quick-log: last set defaults for the same exercise (for quick repeat)
  const lastEntry = useMemo(() =>
    enrichedTrainingslog.length > 0
      ? [...enrichedTrainingslog].sort((a, b) =>
          (b.fields.datum ?? '').localeCompare(a.fields.datum ?? '')
        )[0]
      : null,
    [enrichedTrainingslog]
  );

  // Entries for selected day (heatmap drill)
  const selectedDayEntries = useMemo(() => {
    if (!selectedDay) return [];
    return enrichedTrainingslog.filter(e => {
      if (!e.fields.datum) return false;
      try {
        return format(parseISO(e.fields.datum), 'yyyy-MM-dd') === selectedDay;
      } catch { return false; }
    });
  }, [enrichedTrainingslog, selectedDay]);

  // Quick log handler: open create dialog pre-filled with now + last exercise defaults
  const handleQuickLog = useCallback(() => {
    const now = format(clock, "yyyy-MM-dd'T'HH:mm");
    const defaults: Record<string, unknown> = { datum: now };
    if (lastEntry) {
      defaults.uebung = extractRecordId(lastEntry.fields.uebung) ?? undefined;
      defaults.satz_nummer = (lastEntry.fields.satz_nummer ?? 0) + 1;
      defaults.gewicht_kg = lastEntry.fields.gewicht_kg;
      defaults.wiederholungen = lastEntry.fields.wiederholungen;
    }
    crud.trainingslog.openCreate(defaults);
  }, [clock, lastEntry, crud]);

  // Exercises for the strength chart row selector (shown in aside)
  const uebungenOptions = useMemo(() =>
    uebungen.map(u => ({ id: u.record_id, name: u.fields.name ?? '—' })),
    [uebungen]
  );

  // Chart rows for strength over time (for selected exercise)
  const chartRows = useMemo(() => {
    const srcId = selectedUebungId;
    return trainingslog
      .filter(e => {
        if (!srcId) return true;
        return extractRecordId(e.fields.uebung) === srcId;
      })
      .filter(e => e.fields.datum && e.fields.gewicht_kg != null)
      .map(e => ({
        id: `trainingslog:${e.record_id}`,
        data: e,
      }));
  }, [trainingslog, selectedUebungId]);

  if (loading) return <DashboardSkeleton />;
  if (error) return <DashboardError error={error} onRetry={fetchAll} />;

  // Context line
  const contextLine = todayEntries.length > 0
    ? tx`Heute: ${namen(todayExerciseNames)} — ${todayEntries.length} ${todayEntries.length === 1 ? tx('Satz') : tx('Sätze')} absolviert.`
    : totalSets === 0
      ? tx('Starte deinen ersten Trainingseintrag!')
      : tx('Noch kein Training heute — Zeit für eine Session!');

  const selectedUebung = selectedUebungId
    ? uebungen.find(u => u.record_id === selectedUebungId)
    : null;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">{gruss(clock)}</h1>
          <p className="text-muted-foreground text-sm mt-0.5 truncate">{contextLine}</p>
        </div>
        {/* Big CTA: 2-tap quick log on mobile */}
        <Button
          size="lg"
          className="shrink-0 mt-2 sm:mt-0 gap-2 text-base"
          onClick={handleQuickLog}
        >
          <IconPlus size={18} className="shrink-0" />
          {tx('Satz erfassen')}
        </Button>
      </div>

      <DashboardGrid
        variant="wide"
        kpis={
          <StatStrip>
            <StatStripItem
              title={tx('Heute')}
              value={todayEntries.length}
              icon={<IconFlame size={16} className="shrink-0" />}
              tone={todayEntries.length > 0 ? 'success' : 'default'}
            />
            <StatStripItem
              title={tx('Diese Woche')}
              value={tx`${weekEntries} ${weekEntries === 1 ? tx('Tag') : tx('Tage')}`}
              icon={<IconCalendar size={16} className="shrink-0" />}
              tone={weekEntries >= 3 ? 'success' : weekEntries > 0 ? 'primary' : 'default'}
            />
            <StatStripItem
              title={tx('Gesamt Sätze')}
              value={totalSets}
              icon={<IconBarbell size={16} className="shrink-0" />}
            />
            <StatStripItem
              title={tx('Übungen')}
              value={uebungen.length}
              icon={<IconDumbbell size={16} className="shrink-0" />}
            />
          </StatStrip>
        }
        primary={
          <div className="space-y-6">
            {/* Activity Heatmap */}
            <div className="rounded-xl border bg-card p-4">
              <ActivityHeatmap
                dayCounts={dayCounts}
                month={heatmapMonth}
                selectedDay={selectedDay}
                onDayClick={(key) => {
                  setSelectedDay(prev => prev === key ? null : key);
                }}
                onPrevMonth={() => setHeatmapMonth(m => {
                  const d = new Date(m);
                  d.setMonth(d.getMonth() - 1);
                  return startOfMonth(d);
                })}
                onNextMonth={() => setHeatmapMonth(m => {
                  const d = new Date(m);
                  d.setMonth(d.getMonth() + 1);
                  return startOfMonth(d);
                })}
              />

              {/* Selected day drill: show entries */}
              {selectedDay && selectedDayEntries.length > 0 && (
                <div className="mt-4 border-t pt-3 space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    {formatDate(selectedDay)}
                  </p>
                  {selectedDayEntries.map(e => (
                    <div
                      key={e.record_id}
                      className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 cursor-pointer hover:bg-muted/70 transition-colors"
                      onClick={() => crud.trainingslog.openDetail(e)}
                    >
                      <div className="min-w-0">
                        <span className="font-medium text-sm truncate block">{e.uebungName || tx('Übung')}</span>
                        <span className="text-xs text-muted-foreground">
                          {tx`Satz ${e.fields.satz_nummer ?? '—'}`} · {e.fields.gewicht_kg ?? '—'} {tx('kg ·')} {e.fields.wiederholungen ?? '—'} {tx('Wdh.')}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {selectedDay && selectedDayEntries.length === 0 && (
                <div className="mt-4 border-t pt-3 text-center text-sm text-muted-foreground py-2">
                  {tx('Kein Training an diesem Tag.')}
                </div>
              )}
            </div>

            {/* Strength Progress Chart */}
            <div className="space-y-3">
              {/* Exercise selector */}
              {uebungenOptions.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {uebungenOptions.map(u => (
                    <button
                      key={u.id}
                      onClick={() => setSelectedUebungId(prev => prev === u.id ? null : u.id)}
                      className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors border ${
                        selectedUebungId === u.id
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-muted/40 text-muted-foreground border-border hover:bg-muted'
                      }`}
                    >
                      {u.name}
                    </button>
                  ))}
                </div>
              )}

              {/* Strength progress info */}
              {selectedUebungId && strengthProgress && (
                <div className="flex items-center gap-3 rounded-lg bg-muted/40 px-4 py-2.5">
                  <IconTrendingUp size={20} className="text-green-600 dark:text-green-400 shrink-0" />
                  <div className="min-w-0">
                    {strengthProgress.pct !== null ? (
                      <span className="font-semibold text-sm">
                        {strengthProgress.pct > 0
                          ? tx`+${strengthProgress.pct}% stärker`
                          : strengthProgress.pct < 0
                            ? tx`${strengthProgress.pct}% im letzten Monat`
                            : tx('Gleiches Niveau wie letzten Monat')}
                        {' '}<span className="text-muted-foreground font-normal">
                          ({strengthProgress.kg} {tx('kg max.)')}
                        </span>
                      </span>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        {tx`Aktuell bis zu ${strengthProgress.kg} kg — noch kein Vergleichsmonat.`}
                      </span>
                    )}
                  </div>
                </div>
              )}

              <ChartWidget
                title={selectedUebung ? tx`Gewicht: ${selectedUebung.fields.name ?? ''}` : tx('Gewichtsverlauf alle Übungen')}
                rows={chartRows}
                dimension={{
                  kind: 'time',
                  accessor: (r) => r.data.fields.datum ?? null,
                }}
                measure={{
                  aggregate: 'avg',
                  label: tx('Ø Gewicht (kg)'),
                  value: (r) => r.data.fields.gewicht_kg ?? null,
                  format: 'number',
                }}
                timeEnd={format(clock, "yyyy-MM-dd'T'HH:mm")}
              />
            </div>
          </div>
        }
        aside={
          <>
            {/* Recent sets today */}
            <WorkList
              title={tx('Heutige Sets')}
              items={todayEntries.map(e => ({
                id: e.record_id,
                title: e.uebungName || tx('Übung'),
                secondLine: (
                  <span className="text-muted-foreground text-xs">
                    {tx`Satz ${e.fields.satz_nummer ?? '—'}`} · <span className="font-medium">{e.fields.gewicht_kg ?? '—'} {tx('kg')}</span> · {e.fields.wiederholungen ?? '—'} {tx('Wdh.')}
                  </span>
                ),
                action: {
                  label: tx('+1 Satz'),
                  onClick: () => {
                    const now = format(clock, "yyyy-MM-dd'T'HH:mm");
                    crud.trainingslog.openCreate({
                      datum: now,
                      uebung: extractRecordId(e.fields.uebung) ?? undefined,
                      satz_nummer: (e.fields.satz_nummer ?? 0) + 1,
                      gewicht_kg: e.fields.gewicht_kg,
                      wiederholungen: e.fields.wiederholungen,
                    });
                  },
                },
              }))}
              onItemClick={(id) => {
                const rec = enrichedTrainingslog.find(e => e.record_id === id);
                if (rec) crud.trainingslog.openDetail(rec);
              }}
              empty={{
                text: tx('Noch kein Satz heute — starte jetzt!'),
                action: { label: tx('Satz erfassen'), onClick: handleQuickLog },
              }}
            />

            {/* Exercises list */}
            <WorkList
              title={appLabel('uebungen')}
              items={uebungen.slice(0, 8).map(u => ({
                id: u.record_id,
                title: u.fields.name ?? '—',
                secondLine: (
                  <span className="text-muted-foreground text-xs">
                    {u.fields.muskelgruppe?.label ?? tx('Keine Muskelgruppe')}
                  </span>
                ),
                action: {
                  label: tx('Erfassen'),
                  onClick: () => {
                    const now = format(clock, "yyyy-MM-dd'T'HH:mm");
                    const lastForThis = [...enrichedTrainingslog]
                      .filter(e => extractRecordId(e.fields.uebung) === u.record_id)
                      .sort((a, b) => (b.fields.datum ?? '').localeCompare(a.fields.datum ?? ''))[0];
                    crud.trainingslog.openCreate({
                      datum: now,
                      uebung: u.record_id,
                      satz_nummer: lastForThis ? (lastForThis.fields.satz_nummer ?? 0) + 1 : 1,
                      gewicht_kg: lastForThis?.fields.gewicht_kg,
                      wiederholungen: lastForThis?.fields.wiederholungen,
                    });
                  },
                },
              }))}
              onItemClick={(id) => {
                const rec = uebungen.find(u => u.record_id === id);
                if (rec) crud.uebungen.openDetail(rec);
              }}
              empty={{
                text: tx('Noch keine Übungen angelegt.'),
                action: { label: tx('Übung anlegen'), onClick: () => crud.uebungen.openCreate({}) },
              }}
            />
          </>
        }
      />

      {crud.surfaces}
    </div>
  );
}

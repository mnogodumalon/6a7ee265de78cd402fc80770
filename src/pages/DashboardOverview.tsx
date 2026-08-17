import { useDashboardData } from '@/hooks/useDashboardData';
import { useEntityCrud } from '@/components/EntityCrud';
import { DashboardSkeleton, DashboardError } from '@/components/DashboardStates';
import { DashboardGrid } from '@/components/DashboardGrid';
import { StatStrip, StatStripItem } from '@/components/StatCard';
import { WorkList } from '@/components/WorkList';
import { ChartWidget, type ChartRow } from '@/components/widgets/ChartWidget';
import { TrainingHeatmap } from '@/components/custom/TrainingHeatmap';
import { tx, appLabel } from '@/i18n';
import { useClock, gruss, undoToast } from '@/lib/polish';
import { format, parseISO, subDays, differenceInDays, startOfWeek, endOfWeek, isWithinInterval } from 'date-fns';
import { useState, useMemo, useCallback } from 'react';
import {
  IconPlus,
  IconBarbell,
  IconFlame,
  IconTrophy,
  IconCalendar,
} from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { LivingAppsService, createRecordUrl } from '@/services/livingAppsService';
import { APP_IDS, LOOKUP_OPTIONS } from '@/types/app';
import type { EnrichedTrainingslog } from '@/types/enriched';

export default function DashboardOverview() {
  const data = useDashboardData();
  const {
    uebungen, trainingslog,
    uebungenMap,
    loading, error, fetchAll,
  } = data;

  const crud = useEntityCrud(data);
  const enrichedTrainingslog = crud.enriched.trainingslog;
  const clock = useClock();

  // ─── Filter state ────────────────────────────────────────────────────────
  const [selectedMuscle, setSelectedMuscle] = useState<string | null>(null);
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);

  // ─── Derived data ─────────────────────────────────────────────────────────

  // Day-key map: yyyy-MM-dd → set count
  const daySetCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const log of trainingslog) {
      if (!log.fields.datum) continue;
      const key = log.fields.datum.slice(0, 10);
      m[key] = (m[key] ?? 0) + 1;
    }
    return m;
  }, [trainingslog]);

  // Today key
  const todayKey = format(clock, 'yyyy-MM-dd');

  // Training streak (consecutive days with at least 1 set, ending today or yesterday)
  const streak = useMemo(() => {
    let count = 0;
    let d = new Date(clock);
    // Allow streak to include today even if not yet trained
    if (!daySetCounts[format(d, 'yyyy-MM-dd')]) {
      d = subDays(d, 1);
    }
    while (daySetCounts[format(d, 'yyyy-MM-dd')]) {
      count++;
      d = subDays(d, 1);
    }
    return count;
  }, [daySetCounts, clock]);

  // Total sets this week
  const weekSets = useMemo(() => {
    const weekStart = startOfWeek(clock, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(clock, { weekStartsOn: 1 });
    return trainingslog.filter(log => {
      if (!log.fields.datum) return false;
      const d = parseISO(log.fields.datum);
      return isWithinInterval(d, { start: weekStart, end: weekEnd });
    }).length;
  }, [trainingslog, clock]);

  // Strength progress: for each exercise, compare best weight in last 30 days vs. 30–60 days ago
  const strengthProgress = useMemo(() => {
    const now = clock;
    const recentLogs = trainingslog.filter(log => {
      if (!log.fields.datum || !log.fields.gewicht_kg) return false;
      const d = parseISO(log.fields.datum);
      return differenceInDays(now, d) <= 30;
    });
    const olderLogs = trainingslog.filter(log => {
      if (!log.fields.datum || !log.fields.gewicht_kg) return false;
      const d = parseISO(log.fields.datum);
      const diff = differenceInDays(now, d);
      return diff > 30 && diff <= 60;
    });

    // Per exercise: max weight recent vs older
    const recentMax: Record<string, number> = {};
    const olderMax: Record<string, number> = {};
    for (const log of recentLogs) {
      const id = log.fields.uebung ?? '';
      const w = log.fields.gewicht_kg ?? 0;
      if (!recentMax[id] || w > recentMax[id]) recentMax[id] = w;
    }
    for (const log of olderLogs) {
      const id = log.fields.uebung ?? '';
      const w = log.fields.gewicht_kg ?? 0;
      if (!olderMax[id] || w > olderMax[id]) olderMax[id] = w;
    }

    let totalPercent = 0;
    let count = 0;
    for (const [id, recent] of Object.entries(recentMax)) {
      const older = olderMax[id];
      if (older && older > 0) {
        totalPercent += ((recent - older) / older) * 100;
        count++;
      }
    }
    if (count === 0) return null;
    return Math.round(totalPercent / count);
  }, [trainingslog, clock]);

  // Recent logs for WorkList (today + yesterday)
  const recentLogs = useMemo(() => {
    return (enrichedTrainingslog as EnrichedTrainingslog[])
      .filter(log => {
        if (!log.fields.datum) return false;
        const dayKey = log.fields.datum.slice(0, 10);
        return differenceInDays(clock, parseISO(log.fields.datum)) <= 1 && dayKey <= todayKey;
      })
      .sort((a, b) => (b.fields.datum ?? '').localeCompare(a.fields.datum ?? ''))
      .slice(0, 8);
  }, [enrichedTrainingslog, clock, todayKey]);

  // Logs for selected day (from heatmap click)
  const selectedDayLogs = useMemo(() => {
    if (!selectedDayKey) return [];
    return (enrichedTrainingslog as EnrichedTrainingslog[])
      .filter(log => log.fields.datum?.slice(0, 10) === selectedDayKey)
      .sort((a, b) => (a.fields.satz_nummer ?? 0) - (b.fields.satz_nummer ?? 0));
  }, [enrichedTrainingslog, selectedDayKey]);

  // ChartWidget rows — muscle groups
  const muscleChartRows: ChartRow<EnrichedTrainingslog>[] = useMemo(() => {
    return (enrichedTrainingslog as EnrichedTrainingslog[]).map(log => ({
      id: `trainingslog:${log.record_id}`,
      data: log,
    }));
  }, [enrichedTrainingslog]);

  // Quick log: open create dialog with exercise pre-selected from the last used one
  const handleQuickLog = useCallback(() => {
    const last = [...trainingslog]
      .sort((a, b) => (b.fields.datum ?? '').localeCompare(a.fields.datum ?? ''))[0];
    const defaults: Record<string, unknown> = {
      datum: format(clock, "yyyy-MM-dd'T'HH:mm"),
    };
    if (last?.fields.uebung) {
      defaults.uebung = last.fields.uebung;
      // Next set number for this exercise today
      const todaySets = trainingslog.filter(l =>
        l.fields.uebung === last.fields.uebung &&
        l.fields.datum?.slice(0, 10) === todayKey
      );
      defaults.satz_nummer = todaySets.length + 1;
    }
    crud.trainingslog.openCreate(defaults);
  }, [trainingslog, clock, todayKey, crud]);

  // ─── Hooks ABOVE early returns — done ──────────────────────────────────
  if (loading) return <DashboardSkeleton />;
  if (error) return <DashboardError error={error} onRetry={fetchAll} />;

  // ─── Plain derivations below ────────────────────────────────────────────

  const todaySets = daySetCounts[todayKey] ?? 0;
  const contextLine = uebungen.length === 0
    ? tx('Leg los — füge deine erste Übung hinzu.')
    : todaySets > 0
    ? tx`${todaySets} Sätze heute · Streak: ${streak} ${streak === 1 ? tx('Tag') : tx('Tage')}`
    : streak > 0
    ? tx`${streak} ${streak === 1 ? tx('Tag') : tx('Tage')} Streak — trainier heute weiter!`
    : tx('Noch kein Training heute — leg los!');

  // If no exercises exist yet → empty state CTA
  if (uebungen.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{gruss(clock)}</h1>
          <p className="text-muted-foreground mt-1">{contextLine}</p>
        </div>
        <div className="flex flex-col items-center justify-center py-20 gap-6 text-center">
          <IconBarbell size={48} className="text-muted-foreground" stroke={1.5} />
          <div>
            <h2 className="text-xl font-semibold mb-2">{tx('Richte deinen Fitnesstracker ein')}</h2>
            <p className="text-muted-foreground max-w-sm">
              {tx('Füge zuerst deine Übungen hinzu, dann kannst du mit dem Loggen beginnen.')}
            </p>
          </div>
          <div className="flex gap-3 flex-wrap justify-center">
            <Button onClick={() => crud.uebungen.openCreate()}>
              <IconPlus size={16} className="mr-2 shrink-0" />
              {tx('Erste Übung anlegen')}
            </Button>
          </div>
        </div>
        {crud.surfaces}
      </div>
    );
  }

  const muscleOptions = LOOKUP_OPTIONS['uebungen']?.['muskelgruppe'] ?? [];

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">{gruss(clock)}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{contextLine}</p>
        </div>
        <Button onClick={handleQuickLog} className="shrink-0">
          <IconPlus size={16} className="mr-2 shrink-0" />
          {tx('Satz loggen')}
        </Button>
      </div>

      <DashboardGrid
        variant="wide"
        kpis={
          <StatStrip>
            <StatStripItem
              title={tx('Heute')}
              value={todaySets}
              icon={<IconBarbell size={16} />}
              tone={todaySets > 0 ? 'success' : 'default'}
            />
            <StatStripItem
              title={tx('Diese Woche')}
              value={weekSets}
              icon={<IconCalendar size={16} />}
              tone={weekSets >= 10 ? 'success' : 'default'}
            />
            <StatStripItem
              title={tx('Streak')}
              value={streak > 0 ? tx`${streak}d` : '—'}
              icon={<IconFlame size={16} />}
              tone={streak >= 3 ? 'warning' : 'default'}
            />
            <StatStripItem
              title={tx('Stärker')}
              value={strengthProgress != null ? `+${strengthProgress}%` : '—'}
              icon={<IconTrophy size={16} />}
              tone={strengthProgress != null && strengthProgress > 0 ? 'success' : 'default'}
            />
          </StatStrip>
        }
        primary={
          <div className="space-y-6">
            {/* Heatmap */}
            <div className="rounded-xl border bg-card p-4 overflow-x-auto">
              <h2 className="text-sm font-semibold text-foreground mb-3">{tx('Trainings-Aktivität')}</h2>
              <TrainingHeatmap
                daySetCounts={daySetCounts}
                clock={clock}
                onDayClick={(dayKey) => setSelectedDayKey(prev => prev === dayKey ? null : dayKey)}
              />
              {selectedDayKey && (
                <div className="mt-4 border-t pt-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {selectedDayKey}
                    </span>
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => setSelectedDayKey(null)}
                    >
                      ✕
                    </button>
                  </div>
                  {selectedDayLogs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{tx('Kein Training an diesem Tag.')}</p>
                  ) : (
                    <div className="space-y-1">
                      {selectedDayLogs.map(log => (
                        <button
                          key={log.record_id}
                          className="w-full text-left px-3 py-2 rounded-lg bg-muted/50 hover:bg-muted text-sm flex items-center justify-between gap-2"
                          onClick={() => crud.trainingslog.openDetail(log)}
                        >
                          <span className="font-medium truncate min-w-0">{log.uebungName || appLabel('uebungen')}</span>
                          <span className="text-muted-foreground shrink-0 text-xs">
                            {log.fields.satz_nummer != null && tx`Satz ${log.fields.satz_nummer}`}
                            {log.fields.gewicht_kg != null && ` · ${log.fields.gewicht_kg} kg`}
                            {log.fields.wiederholungen != null && ` × ${log.fields.wiederholungen}`}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Muscle group chart */}
            <ChartWidget
              title={tx('Sätze pro Muskelgruppe')}
              rows={muscleChartRows}
              dimension={{
                kind: 'category',
                accessor: (row) => {
                  const uebungId = row.data.fields.uebung;
                  if (!uebungId) return null;
                  const ueb = uebungenMap.get(
                    uebungId.match(/([a-f0-9]{24})$/i)?.[1] ?? ''
                  );
                  return ueb?.fields.muskelgruppe ?? null;
                },
                label: tx('Muskelgruppe'),
              }}
            />
          </div>
        }
        aside={
          <>
            {/* Recent sets / today */}
            <WorkList
              title={tx('Heute & gestern')}
              items={recentLogs.map(log => ({
                id: log.record_id,
                title: log.uebungName || appLabel('uebungen'),
                secondLine: (
                  <>
                    <span className="font-medium text-foreground">
                      {log.fields.satz_nummer != null && tx`Satz ${log.fields.satz_nummer}`}
                    </span>
                    {log.fields.gewicht_kg != null && (
                      <span className="text-muted-foreground"> · {log.fields.gewicht_kg} {tx('kg ×')} {log.fields.wiederholungen}</span>
                    )}
                    <span className="text-muted-foreground"> · {log.fields.datum?.slice(0, 10)}</span>
                  </>
                ),
                action: {
                  label: tx('+ Satz'),
                  onClick: () => {
                    const sameExerciseSets = trainingslog.filter(l =>
                      l.fields.uebung === log.fields.uebung &&
                      l.fields.datum?.slice(0, 10) === todayKey
                    );
                    crud.trainingslog.openCreate({
                      uebung: log.fields.uebung,
                      datum: format(clock, "yyyy-MM-dd'T'HH:mm"),
                      satz_nummer: sameExerciseSets.length + 1,
                    });
                  },
                },
              }))}
              onItemClick={(id) => {
                const log = enrichedTrainingslog.find(l => l.record_id === id);
                if (log) crud.trainingslog.openDetail(log);
              }}
              empty={{
                text: tx('Noch keine Sätze heute — tippe auf + Satz loggen'),
                action: { label: tx('Satz loggen'), onClick: handleQuickLog },
              }}
            />

            {/* Exercise library quick-access */}
            <WorkList
              title={appLabel('uebungen')}
              items={uebungen.slice(0, 6).map(ueb => ({
                id: ueb.record_id,
                title: ueb.fields.name ?? '—',
                secondLine: (
                  <span className="text-muted-foreground">
                    {ueb.fields.muskelgruppe?.label ?? '—'}
                  </span>
                ),
                action: {
                  label: tx('Loggen'),
                  onClick: () => {
                    const todaySetsForExercise = trainingslog.filter(l =>
                      l.fields.uebung === createRecordUrl(APP_IDS.UEBUNGEN, ueb.record_id) &&
                      l.fields.datum?.slice(0, 10) === todayKey
                    );
                    crud.trainingslog.openCreate({
                      uebung: createRecordUrl(APP_IDS.UEBUNGEN, ueb.record_id),
                      datum: format(clock, "yyyy-MM-dd'T'HH:mm"),
                      satz_nummer: todaySetsForExercise.length + 1,
                    });
                  },
                },
              }))}
              onItemClick={(id) => {
                const ueb = uebungen.find(u => u.record_id === id);
                if (ueb) crud.uebungen.openDetail(ueb);
              }}
              empty={{
                text: tx('Noch keine Übungen — lege jetzt deine erste an.'),
                action: { label: tx('Übung anlegen'), onClick: () => crud.uebungen.openCreate() },
              }}
            />
          </>
        }
      />

      {crud.surfaces}
    </div>
  );
}

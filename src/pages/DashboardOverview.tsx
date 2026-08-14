import { useState, useMemo, useCallback } from 'react';
import { format, parseISO } from 'date-fns';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useEntityCrud } from '@/components/EntityCrud';
import { DashboardSkeleton, DashboardError } from '@/components/DashboardStates';
import { DashboardGrid } from '@/components/DashboardGrid';
import { StatStrip, StatStripItem } from '@/components/StatCard';
import { WorkList } from '@/components/WorkList';
import { tx, appLabel } from '@/i18n';
import { useClock, gruss, undoToast } from '@/lib/polish';
import { LivingAppsService, createRecordUrl, extractRecordId } from '@/services/livingAppsService';
import { APP_IDS, LOOKUP_OPTIONS } from '@/types/app';
import { ChartWidget, type ChartRow } from '@/components/widgets/ChartWidget';
import { ChartSkeleton } from '@/components/widgets/ChartWidget';
import { TrainingHeatmap } from '@/components/custom/TrainingHeatmap';
import { QuickLogPanel } from '@/components/custom/QuickLogPanel';
import type { EnrichedTrainingslog } from '@/types/enriched';
import {
  IconBarbell,
  IconFlame,
  IconTrendingUp,
  IconCalendar,
} from '@tabler/icons-react';

export default function DashboardOverview() {
  const data = useDashboardData();
  const {
    uebungen, trainingslog,
    uebungenMap,
    loading, error, fetchAll,
    setTrainingslog,
  } = data;

  const crud = useEntityCrud(data);
  const enrichedTrainingslog = crud.enriched.trainingslog;

  const clock = useClock();

  // ── Quick-log state ──
  const [saving, setSaving] = useState(false);

  // ── Heatmap: which month to show (current by default) ──
  const currentMonth = format(clock, 'yyyy-MM');
  const today = format(clock, 'yyyy-MM-dd');

  // ── Derived: dayCounts for heatmap (sets per day) ──
  const dayCounts = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const log of trainingslog) {
      if (!log.fields.datum) continue;
      const day = log.fields.datum.slice(0, 10);
      counts[day] = (counts[day] ?? 0) + 1;
    }
    return counts;
  }, [trainingslog]);

  // ── KPI: total training days this month ──
  const trainingDaysThisMonth = useMemo(() => {
    const prefix = currentMonth;
    return Object.keys(dayCounts).filter(d => d.startsWith(prefix)).length;
  }, [dayCounts, currentMonth]);

  // ── KPI: total sets this month ──
  const setsThisMonth = useMemo(() => {
    const prefix = currentMonth;
    return Object.entries(dayCounts)
      .filter(([d]) => d.startsWith(prefix))
      .reduce((sum, [, c]) => sum + c, 0);
  }, [dayCounts, currentMonth]);

  // ── KPI: streak (consecutive training days up to today) ──
  const streak = useMemo(() => {
    let s = 0;
    const d = new Date(clock);
    while (true) {
      const key = format(d, 'yyyy-MM-dd');
      if (!dayCounts[key]) break;
      s++;
      d.setDate(d.getDate() - 1);
    }
    return s;
  }, [dayCounts, clock]);

  // ── Strength progress: find best (max gewicht_kg) per exercise ──
  const strengthProgress = useMemo(() => {
    // For each exercise, find earliest max and latest max
    const byExercise: Record<string, Array<{ datum: string; gewicht: number; reps: number }>> = {};
    for (const log of trainingslog) {
      const id = extractRecordId(log.fields.uebung);
      if (!id || !log.fields.datum || log.fields.gewicht_kg == null) continue;
      if (!byExercise[id]) byExercise[id] = [];
      byExercise[id].push({ datum: log.fields.datum, gewicht: log.fields.gewicht_kg, reps: log.fields.wiederholungen ?? 1 });
    }
    const results: Array<{ name: string; progressPct: number; currentMax: number }> = [];
    for (const [id, entries] of Object.entries(byExercise)) {
      if (entries.length < 2) continue;
      const sorted = [...entries].sort((a, b) => (a.datum ?? '').localeCompare(b.datum ?? ''));
      const firstMax = Math.max(...sorted.slice(0, Math.ceil(sorted.length / 2)).map(e => e.gewicht));
      const lastMax = Math.max(...sorted.slice(Math.floor(sorted.length / 2)).map(e => e.gewicht));
      if (firstMax <= 0) continue;
      const progressPct = Math.round(((lastMax - firstMax) / firstMax) * 100);
      const name = uebungenMap.get(id)?.fields.name ?? id;
      results.push({ name, progressPct, currentMax: lastMax });
    }
    return results.sort((a, b) => b.progressPct - a.progressPct).slice(0, 5);
  }, [trainingslog, uebungenMap]);

  // ── nextSetNumber: last satz_nummer for an exercise + 1 ──
  const nextSetNumber = useCallback((exerciseId: string): number => {
    const url = createRecordUrl(APP_IDS.UEBUNGEN, exerciseId);
    const sets = trainingslog.filter(l => {
      if (!l.fields.uebung) return false;
      const id = extractRecordId(l.fields.uebung);
      return id === exerciseId;
    }).filter(l => l.fields.datum?.startsWith(today));
    if (sets.length === 0) return 1;
    const max = Math.max(...sets.map(l => l.fields.satz_nummer ?? 0));
    return max + 1;
  }, [trainingslog, today]);

  // ── exercises list for QuickLogPanel ──
  const exerciseList = useMemo(() =>
    uebungen.map(u => ({
      id: u.record_id,
      name: u.fields.name ?? u.record_id,
      muskelgruppe: u.fields.muskelgruppe?.label,
    })),
    [uebungen]
  );

  // ── ChartWidget rows: per Muskelgruppe ──
  const chartRows = useMemo<ChartRow<EnrichedTrainingslog>[]>(() =>
    enrichedTrainingslog.map(r => ({
      id: `trainingslog:${r.record_id}`,
      data: r,
    })),
    [enrichedTrainingslog]
  );

  // ── Recent sets for aside WorkList ──
  const recentSets = useMemo(() =>
    [...enrichedTrainingslog]
      .filter(r => r.fields.datum)
      .sort((a, b) => (b.fields.datum ?? '').localeCompare(a.fields.datum ?? ''))
      .slice(0, 6),
    [enrichedTrainingslog]
  );

  // ── Handle quick log submit ──
  const handleLog = useCallback(async (payload: {
    exerciseId: string;
    satz_nummer: number;
    gewicht_kg: number;
    wiederholungen: number;
  }) => {
    setSaving(true);
    const datumNow = format(clock, "yyyy-MM-dd'T'HH:mm");
    try {
      const result = await LivingAppsService.createTrainingslogEntry({
        datum: datumNow,
        uebung: createRecordUrl(APP_IDS.UEBUNGEN, payload.exerciseId),
        satz_nummer: payload.satz_nummer,
        gewicht_kg: payload.gewicht_kg,
        wiederholungen: payload.wiederholungen,
      });
      const newRecord = {
        record_id: result.record_id,
        created_at: datumNow,
        updated_at: null,
        createdat: datumNow,
        updatedat: null,
        fields: {
          datum: datumNow,
          uebung: createRecordUrl(APP_IDS.UEBUNGEN, payload.exerciseId),
          satz_nummer: payload.satz_nummer,
          gewicht_kg: payload.gewicht_kg,
          wiederholungen: payload.wiederholungen,
        },
      };
      setTrainingslog(prev => [newRecord, ...prev]);
      const exerciseName = uebungenMap.get(payload.exerciseId)?.fields.name ?? '';
      undoToast(
        tx`${exerciseName} — Satz ${String(payload.satz_nummer)} gespeichert`,
        async () => {
          await LivingAppsService.deleteTrainingslogEntry(result.record_id);
          setTrainingslog(prev => prev.filter(r => r.record_id !== result.record_id));
        }
      );
    } catch {
      fetchAll();
    } finally {
      setSaving(false);
    }
  }, [clock, uebungenMap, setTrainingslog, fetchAll]);

  // ── hooks end — early returns below ──

  if (loading) return <DashboardSkeleton />;
  if (error) return <DashboardError error={error} onRetry={fetchAll} />;

  // ── Context line ──
  const contextLine = recentSets.length > 0
    ? tx`Zuletzt: ${recentSets[0].uebungName} · ${String(recentSets[0].fields.gewicht_kg ?? 0)} kg`
    : tx('Noch keine Sätze erfasst — leg los!');

  // ── Empty state ──
  if (uebungen.length === 0) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{gruss(clock)}</h1>
          <p className="text-muted-foreground mt-1">{tx('Richte deinen FitTrack ein')}</p>
        </div>
        <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
          <IconBarbell size={48} className="text-muted-foreground" stroke={1.5} />
          <p className="text-muted-foreground max-w-xs">
            {tx('Füge zuerst eine Übung hinzu, dann kannst du dein Training tracken.')}
          </p>
          <button
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() => crud.uebungen.openCreate({})}
          >
            <IconBarbell size={16} />
            {tx('Erste Übung anlegen')}
          </button>
        </div>
        {crud.surfaces}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-foreground">{gruss(clock)}</h1>
          <p className="text-muted-foreground mt-0.5 truncate">{contextLine}</p>
        </div>
        <button
          className="shrink-0 inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          onClick={() => crud.uebungen.openCreate({})}
        >
          <IconBarbell size={16} className="shrink-0" />
          <span className="hidden sm:inline">{tx('Übung anlegen')}</span>
        </button>
      </div>

      <DashboardGrid
        variant="wide"
        kpis={
          <StatStrip>
            <StatStripItem
              title={tx('Trainingstage')}
              value={trainingDaysThisMonth}
              icon={<IconCalendar size={14} className="shrink-0" />}
            />
            <StatStripItem
              title={tx('Sätze diesen Monat')}
              value={setsThisMonth}
              icon={<IconBarbell size={14} className="shrink-0" />}
            />
            <StatStripItem
              title={tx('Streak')}
              value={streak > 0 ? tx`${String(streak)} Tage` : tx('—')}
              icon={<IconFlame size={14} className="shrink-0" />}
              tone={streak >= 7 ? 'success' : streak >= 3 ? 'primary' : 'default'}
            />
            <StatStripItem
              title={tx('Übungen')}
              value={uebungen.length}
              icon={<IconTrendingUp size={14} className="shrink-0" />}
            />
          </StatStrip>
        }
        primary={
          <div className="space-y-6">
            {/* 2-tap quick-log panel */}
            <div>
              <h2 className="text-base font-semibold text-foreground mb-3">{tx('Satz erfassen')}</h2>
              <QuickLogPanel
                exercises={exerciseList}
                onLog={handleLog}
                nextSetNumber={nextSetNumber}
                saving={saving}
              />
            </div>

            {/* Heatmap */}
            <div>
              <h2 className="text-base font-semibold text-foreground mb-3">{tx('Trainingsübersicht')}</h2>
              <TrainingHeatmap
                dayCounts={dayCounts}
                month={currentMonth}
                today={today}
                onDayClick={(dayKey) => {
                  // open create pre-filled for that day
                  crud.trainingslog.openCreate({ datum: dayKey + 'T09:00' });
                }}
              />
            </div>
          </div>
        }
        aside={
          <>
            {/* Recent sets */}
            <WorkList
              title={tx('Zuletzt erfasst')}
              items={recentSets.map(r => ({
                id: r.record_id,
                title: r.uebungName || tx('Übung'),
                secondLine: (
                  <span className="text-muted-foreground text-sm">
                    {r.fields.gewicht_kg != null ? `${r.fields.gewicht_kg} kg` : '—'}
                    {r.fields.wiederholungen != null ? tx` · ${r.fields.wiederholungen} Wdh` : ''}
                    {r.fields.satz_nummer != null ? tx` · Satz ${r.fields.satz_nummer}` : ''}
                  </span>
                ),
              }))}
              onItemClick={id => {
                const rec = enrichedTrainingslog.find(r => r.record_id === id);
                if (rec) crud.trainingslog.openDetail(rec);
              }}
              empty={{
                text: tx('Noch keine Sätze — erfasse deinen ersten Satz!'),
                action: { label: tx('Satz erfassen'), onClick: () => crud.trainingslog.openCreate({}) },
              }}
            />

            {/* Strength progress chart */}
            {strengthProgress.length > 0 ? (
              <div className="rounded-xl border bg-card p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <IconTrendingUp size={16} className="text-muted-foreground shrink-0" />
                  <span className="text-sm font-semibold text-foreground">{tx('Stärkefortschritt')}</span>
                </div>
                <div className="space-y-2">
                  {strengthProgress.map(item => (
                    <div key={item.name} className="space-y-1">
                      <div className="flex justify-between items-baseline gap-2">
                        <span className="text-sm text-foreground truncate min-w-0">{item.name}</span>
                        <span className={`text-sm font-semibold shrink-0 ${item.progressPct > 0 ? 'text-green-600' : item.progressPct < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                          {item.progressPct > 0 ? '+' : ''}{item.progressPct}%
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full ${item.progressPct > 0 ? 'bg-green-500' : 'bg-muted-foreground'}`}
                          style={{ width: `${Math.min(Math.abs(item.progressPct), 100)}%` }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">{tx`Max: ${String(item.currentMax)} kg`}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border bg-card p-4">
                <div className="flex items-center gap-2 mb-2">
                  <IconTrendingUp size={16} className="text-muted-foreground shrink-0" />
                  <span className="text-sm font-semibold text-foreground">{tx('Stärkefortschritt')}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {tx('Sobald du mehrere Sätze erfasst hast, siehst du hier deinen Fortschritt.')}
                </p>
              </div>
            )}

            {/* Chart: sets per muscle group */}
            <ChartWidget
              rows={chartRows}
              title={tx('Sätze pro Muskelgruppe')}
              dimension={{
                kind: 'category',
                accessor: r => {
                  const id = extractRecordId(r.data.fields.uebung);
                  if (!id) return null;
                  const u = uebungenMap.get(id);
                  return u?.fields.muskelgruppe ?? null;
                },
              }}
            />
          </>
        }
      />

      {crud.surfaces}
    </div>
  );
}

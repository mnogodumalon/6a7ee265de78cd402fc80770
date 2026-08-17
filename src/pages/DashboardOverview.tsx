import { useDashboardData } from '@/hooks/useDashboardData';
import { useEntityCrud } from '@/components/EntityCrud';
import { DashboardSkeleton, DashboardError } from '@/components/DashboardStates';
import { DashboardGrid } from '@/components/DashboardGrid';
import { StatStrip, StatStripItem } from '@/components/StatCard';
import { WorkList } from '@/components/WorkList';
import { TrainingHeatmap } from '@/components/custom/TrainingHeatmap';
import { ChartWidget, ChartSkeleton } from '@/components/widgets/ChartWidget';
import { useClock, gruss, undoToast } from '@/lib/polish';
import { tx, appLabel } from '@/i18n';
import { format, parseISO, subDays, isAfter, startOfDay } from 'date-fns';
import { useState, useMemo, useCallback } from 'react';
import { extractRecordId, createRecordUrl } from '@/services/livingAppsService';
import { LivingAppsService } from '@/services/livingAppsService';
import { APP_IDS } from '@/types/app';
import {
  IconBarbell,
  IconFlame,
  IconTrendingUp,
  IconPlus,
  IconChartBar,
} from '@tabler/icons-react';
import { Button } from '@/components/ui/button';

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

  // Filter state: which day is selected in the heatmap
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  // Filter state: which exercise to show strength progress for
  const [selectedUebungId, setSelectedUebungId] = useState<string | null>(null);

  // Day-keyed sets map for heatmap
  const daySets = useMemo(() => {
    const map: Record<string, number> = {};
    for (const log of trainingslog) {
      if (!log.fields.datum) continue;
      const dayKey = log.fields.datum.slice(0, 10);
      map[dayKey] = (map[dayKey] ?? 0) + 1;
    }
    return map;
  }, [trainingslog]);

  // KPI: total sets
  const totalSets = trainingslog.length;

  // KPI: training days in last 30 days
  const thirtyDaysAgo = useMemo(() => startOfDay(subDays(clock, 30)), [clock]);
  const recentDays = useMemo(() => {
    const days = new Set<string>();
    for (const log of trainingslog) {
      if (!log.fields.datum) continue;
      const d = parseISO(log.fields.datum);
      if (isAfter(d, thirtyDaysAgo)) {
        days.add(log.fields.datum.slice(0, 10));
      }
    }
    return days.size;
  }, [trainingslog, thirtyDaysAgo]);

  // KPI: most trained exercise
  const topUebung = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const log of trainingslog) {
      const id = extractRecordId(log.fields.uebung);
      if (id) counts[id] = (counts[id] ?? 0) + 1;
    }
    let topId = null as string | null;
    let topCount = 0;
    for (const [id, count] of Object.entries(counts)) {
      if (count > topCount) { topId = id; topCount = count; }
    }
    if (!topId) return null;
    const rec = uebungenMap.get(topId);
    return rec ? rec.fields.name ?? null : null;
  }, [trainingslog, uebungenMap]);

  // Heatmap: filter trainingslog by selected day
  const displayedLogs = useMemo(() => {
    if (!selectedDay) return enrichedTrainingslog;
    return enrichedTrainingslog.filter(l => l.fields.datum?.slice(0, 10) === selectedDay);
  }, [enrichedTrainingslog, selectedDay]);

  // Recent sets for WorkList (last 10 or day-filtered)
  const recentSets = useMemo(() => {
    const sorted = [...displayedLogs].sort((a, b) => {
      const da = a.fields.datum ?? '';
      const db = b.fields.datum ?? '';
      return db.localeCompare(da);
    });
    return sorted.slice(0, 10);
  }, [displayedLogs]);

  // Strength progress: max weight per exercise over time (for ChartWidget)
  const strengthRows = useMemo(() => {
    return trainingslog
      .filter(l => {
        if (!selectedUebungId) return true;
        return extractRecordId(l.fields.uebung) === selectedUebungId;
      })
      .map(l => ({
        id: `trainingslog:${l.record_id}`,
        data: l,
      }));
  }, [trainingslog, selectedUebungId]);

  // Quick-log handler: open create dialog with today pre-filled
  const handleQuickLog = useCallback(() => {
    const now = format(clock, "yyyy-MM-dd'T'HH:mm");
    crud.trainingslog.openCreate({ datum: now });
  }, [clock, crud.trainingslog]);

  // Handle heatmap day click
  const handleDayClick = useCallback((dayKey: string) => {
    setSelectedDay(prev => prev === dayKey ? null : dayKey);
  }, []);

  if (loading) return <DashboardSkeleton />;
  if (error) return <DashboardError error={error} onRetry={fetchAll} />;

  const todayKey = format(clock, 'yyyy-MM-dd');
  const todaySets = daySets[todayKey] ?? 0;
  const contextLine = todaySets > 0
    ? tx`Heute: ${todaySets} ${todaySets === 1 ? tx('Satz') : tx('Sätze')} erfasst.`
    : tx('Noch kein Training heute — starte deinen ersten Satz!');

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {gruss(clock)}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">{contextLine}</p>
        </div>
        <Button
          onClick={handleQuickLog}
          className="shrink-0 flex items-center gap-1.5"
          size="sm"
        >
          <IconPlus size={16} className="shrink-0" />
          <span>{tx('Satz erfassen')}</span>
        </Button>
      </div>

      <DashboardGrid
        variant="wide"
        kpis={
          <StatStrip>
            <StatStripItem
              title={tx('Sätze gesamt')}
              value={totalSets}
              icon={<IconBarbell size={16} />}
              tone="default"
            />
            <StatStripItem
              title={tx('Trainingstage (30 Tage)')}
              value={recentDays}
              icon={<IconFlame size={16} />}
              tone={recentDays >= 12 ? 'success' : recentDays >= 6 ? 'default' : 'warning'}
            />
            <StatStripItem
              title={tx('Top-Übung')}
              value={topUebung ?? '—'}
              icon={<IconTrendingUp size={16} />}
              tone="default"
            />
          </StatStrip>
        }
        primary={
          <div className="space-y-4">
            {/* Heatmap */}
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-sm text-foreground">
                  {tx('Trainingsaktivität')}
                </h2>
                {selectedDay && (
                  <button
                    onClick={() => setSelectedDay(null)}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {tx('Filter aufheben')}
                  </button>
                )}
              </div>
              <TrainingHeatmap
                daySets={daySets}
                today={clock}
                months={3}
                onDayClick={handleDayClick}
              />
            </div>

            {/* Strength progress chart */}
            <div>
              {uebungen.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  <button
                    onClick={() => setSelectedUebungId(null)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${!selectedUebungId ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
                  >
                    {tx('Alle Übungen')}
                  </button>
                  {uebungen.slice(0, 6).map(u => (
                    <button
                      key={u.record_id}
                      onClick={() => setSelectedUebungId(prev => prev === u.record_id ? null : u.record_id)}
                      className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${selectedUebungId === u.record_id ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
                    >
                      {u.fields.name}
                    </button>
                  ))}
                </div>
              )}
              <ChartWidget
                title={tx('Stärkefortschritt — max. Gewicht (kg)')}
                rows={strengthRows}
                dimension={{ kind: 'time', accessor: r => r.data.fields.datum ?? null }}
                measure={{ aggregate: 'avg', label: tx('Ø Gewicht (kg)'), value: r => r.data.fields.gewicht_kg ?? null, format: 'number' }}
                timeEnd={format(clock, "yyyy-MM-dd'T'HH:mm")}
              />
            </div>
          </div>
        }
        aside={
          <>
            <WorkList
              title={selectedDay ? tx`Sätze am ${selectedDay}` : tx('Letzte Sätze')}
              items={recentSets.map(r => ({
                id: r.record_id,
                title: r.uebungName || appLabel('uebungen'),
                secondLine: (
                  <span className="text-muted-foreground text-xs">
                    {r.fields.satz_nummer ? tx`Satz ${r.fields.satz_nummer} · ` : ''}
                    {r.fields.gewicht_kg != null ? `${r.fields.gewicht_kg} kg` : ''}
                    {r.fields.wiederholungen != null ? ` × ${r.fields.wiederholungen}` : ''}
                    {r.fields.datum ? ` · ${r.fields.datum.slice(0, 10)}` : ''}
                  </span>
                ),
                action: {
                  label: tx('Bearbeiten'),
                  onClick: () => crud.trainingslog.openEdit(r),
                },
              }))}
              onItemClick={id => {
                const rec = enrichedTrainingslog.find(r => r.record_id === id);
                if (rec) crud.trainingslog.openDetail(rec);
              }}
              empty={{
                text: tx('Noch keine Sätze — erfasse deinen ersten Satz!'),
                action: { label: tx('Satz erfassen'), onClick: handleQuickLog },
              }}
            />

            {/* Übungen quick access */}
            <WorkList
              title={appLabel('uebungen')}
              items={uebungen.slice(0, 6).map(u => ({
                id: u.record_id,
                title: u.fields.name ?? '—',
                secondLine: (
                  <span className="text-muted-foreground text-xs">
                    {u.fields.muskelgruppe?.label ?? ''}
                  </span>
                ),
                action: {
                  label: tx('Trainieren'),
                  onClick: () => {
                    const now = format(clock, "yyyy-MM-dd'T'HH:mm");
                    crud.trainingslog.openCreate({
                      datum: now,
                      uebung: u.record_id,
                    });
                  },
                },
              }))}
              onItemClick={id => {
                const rec = uebungen.find(u => u.record_id === id);
                if (rec) crud.uebungen.openDetail(rec);
              }}
              empty={{
                text: tx('Noch keine Übungen — lege deine erste Übung an!'),
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

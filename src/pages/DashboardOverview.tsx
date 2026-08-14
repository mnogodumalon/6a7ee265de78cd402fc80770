import { useState, useMemo, useCallback } from 'react';
import { format, parseISO, isToday, subDays, startOfDay } from 'date-fns';
import { useDashboardData } from '@/hooks/useDashboardData';
import { enrichTrainingslog } from '@/lib/enrich';
import type { EnrichedTrainingslog } from '@/types/enriched';
import type { Uebungen, Trainingslog } from '@/types/app';
import { APP_IDS, LOOKUP_OPTIONS } from '@/types/app';
import { LivingAppsService, extractRecordId, createRecordUrl } from '@/services/livingAppsService';
import { formatDate, displayLookup } from '@/lib/formatters';
import { DashboardSkeleton, DashboardError } from '@/components/DashboardStates';
import { DashboardGrid } from '@/components/DashboardGrid';
import { WorkList } from '@/components/WorkList';
import { StatStrip, StatStripItem } from '@/components/StatCard';
import {
  RecordOverlayHost,
  RecordHeader,
  useRecordOverlayStack,
} from '@/components/widgets/RecordView';
import { TrainingslogDetails } from '@/components/details/TrainingslogDetails';
import { UebungenDetails } from '@/components/details/UebungenDetails';
import { TrainingslogDialog } from '@/components/dialogs/TrainingslogDialog';
import type { TrainingslogDialogDefaults } from '@/components/dialogs/TrainingslogDialog';
import { UebungenDialog } from '@/components/dialogs/UebungenDialog';
import { ChartWidget } from '@/components/widgets/ChartWidget';
import type { ChartRow, ChartSegment } from '@/components/widgets/ChartWidget';
import { ActivityHeatmap } from '@/components/custom/ActivityHeatmap';
import { AI_PHOTO_SCAN, AI_PHOTO_LOCATION } from '@/config/ai-features';
import { useClock, gruss, undoToast } from '@/lib/polish';
import { tx, appLabel, fieldLabel } from '@/i18n';
import {
  IconPlus,
  IconBarbell,
  IconFlame,
  IconTrendingUp,
  IconChartBar,
  IconCalendar,
} from '@tabler/icons-react';
import { Button } from '@/components/ui/button';

// Pre-generated overlay union
export type OverlayItem =
  | { type: 'uebungen'; record: Uebungen }
  | { type: 'trainingslog'; record: EnrichedTrainingslog };

export default function DashboardOverview() {
  const {
    uebungen, trainingslog,
    uebungenMap,
    loading, error, fetchAll,
  } = useDashboardData();

  const clock = useClock();
  const overlay = useRecordOverlayStack<OverlayItem>();

  // Dialog state
  const [logDialogOpen, setLogDialogOpen] = useState(false);
  const [logDefaults, setLogDefaults] = useState<TrainingslogDialogDefaults | undefined>(undefined);
  const [editLogRecord, setEditLogRecord] = useState<EnrichedTrainingslog | null>(null);

  const [uebungDialogOpen, setUebungDialogOpen] = useState(false);
  const [editUebungRecord, setEditUebungRecord] = useState<Uebungen | null>(null);

  // Selected day filter from heatmap
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);

  // Muscle group filter from chart
  const [selectedMuscleKey, setSelectedMuscleKey] = useState<string | null>(null);

  // Chart segment state
  const [muscleChartSel, setMuscleChartSel] = useState<ChartSegment<Trainingslog> | null>(null);

  const enrichedTrainingslog = useMemo(
    () => enrichTrainingslog(trainingslog, { uebungenMap }),
    [trainingslog, uebungenMap]
  );

  const todayKey = format(clock, 'yyyy-MM-dd');

  // Heatmap data: group trainingslog by day
  const heatmapDays = useMemo(() => {
    const dayMap = new Map<string, number>();
    for (const r of trainingslog) {
      if (!r.fields.datum) continue;
      const dk = r.fields.datum.slice(0, 10);
      dayMap.set(dk, (dayMap.get(dk) ?? 0) + 1);
    }
    return Array.from(dayMap.entries()).map(([dayKey, sets]) => ({ dayKey, sets }));
  }, [trainingslog]);

  // Today's sets
  const todaySets = useMemo(
    () => trainingslog.filter(r => r.fields.datum?.slice(0, 10) === todayKey).length,
    [trainingslog, todayKey]
  );

  // Streak: how many consecutive days with training (backwards from today)
  const streak = useMemo(() => {
    const days = new Set(trainingslog.map(r => r.fields.datum?.slice(0, 10)).filter(Boolean));
    let count = 0;
    let d = startOfDay(clock);
    // If no training today, streak starts from yesterday
    if (!days.has(format(d, 'yyyy-MM-dd'))) {
      d = subDays(d, 1);
    }
    while (days.has(format(d, 'yyyy-MM-dd'))) {
      count++;
      d = subDays(d, 1);
    }
    return count;
  }, [trainingslog, clock]);

  // Strength progress: compare last 30 days avg max weight to prior 30 days, for exercises with data
  const strengthProgress = useMemo(() => {
    const now = clock;
    const thirtyAgo = subDays(now, 30);
    const sixtyAgo = subDays(now, 60);
    const recent: number[] = [];
    const prior: number[] = [];
    for (const r of trainingslog) {
      if (!r.fields.datum || !r.fields.gewicht_kg) continue;
      const d = parseISO(r.fields.datum);
      if (d >= thirtyAgo) recent.push(r.fields.gewicht_kg);
      else if (d >= sixtyAgo) prior.push(r.fields.gewicht_kg);
    }
    if (!recent.length || !prior.length) return null;
    const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
    const avgPrior = prior.reduce((a, b) => a + b, 0) / prior.length;
    if (avgPrior === 0) return null;
    return Math.round(((avgRecent - avgPrior) / avgPrior) * 100);
  }, [trainingslog, clock]);

  // Recent log entries for WorkList (last 5, filtered by selected day if set)
  const recentLogs = useMemo(() => {
    let logs = enrichedTrainingslog
      .filter(r => r.fields.datum)
      .sort((a, b) => (b.fields.datum ?? '').localeCompare(a.fields.datum ?? ''));
    if (selectedDayKey) {
      logs = logs.filter(r => r.fields.datum?.slice(0, 10) === selectedDayKey);
    }
    return logs.slice(0, 8);
  }, [enrichedTrainingslog, selectedDayKey]);

  // Chart rows: trainingslog for muscle group breakdown
  const chartRows: ChartRow<Trainingslog>[] = useMemo(
    () => trainingslog.map(r => ({ id: `trainingslog:${r.record_id}`, data: r })),
    [trainingslog]
  );

  // Quick log: open dialog for a new set, optionally pre-filled with an exercise
  const openQuickLog = useCallback((uebungId?: string) => {
    const defaults: TrainingslogDialogDefaults = {
      datum: format(clock, "yyyy-MM-dd'T'HH:mm"),
      ...(uebungId ? { uebung: uebungId } : {}),
    };
    setLogDefaults(defaults);
    setEditLogRecord(null);
    setLogDialogOpen(true);
  }, [clock]);

  const handleLogSubmit = useCallback(async (fields: Trainingslog['fields']) => {
    if (editLogRecord) {
      await LivingAppsService.updateTrainingslogEntry(editLogRecord.record_id, fields);
      undoToast(tx`Satz aktualisiert`, async () => {
        await LivingAppsService.updateTrainingslogEntry(editLogRecord.record_id, editLogRecord.fields);
        fetchAll();
      });
    } else {
      await LivingAppsService.createTrainingslogEntry(fields);
      undoToast(tx`Satz erfasst`);
    }
    fetchAll();
  }, [editLogRecord, fetchAll]);

  const handleUebungSubmit = useCallback(async (fields: Uebungen['fields']) => {
    if (editUebungRecord) {
      await LivingAppsService.updateUebungenEntry(editUebungRecord.record_id, fields);
      undoToast(tx`Übung aktualisiert`);
    } else {
      await LivingAppsService.createUebungenEntry(fields);
      undoToast(tx`Übung angelegt`);
    }
    fetchAll();
  }, [editUebungRecord, fetchAll]);

  // All hooks ABOVE early returns
  if (loading) return <DashboardSkeleton />;
  if (error) return <DashboardError error={error} onRetry={fetchAll} />;

  const totalSets = trainingslog.length;
  const totalExercises = uebungen.length;

  const strengthLabel = strengthProgress === null
    ? tx('—')
    : strengthProgress >= 0
      ? `+${strengthProgress}%`
      : `${strengthProgress}%`;

  const strengthTone = strengthProgress === null ? 'default' : strengthProgress > 0 ? 'success' : 'warning';

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {gruss(clock)} 💪
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {todaySets > 0
              ? tx`${todaySets} Sätze heute — weiter so!`
              : tx('Bereit für die nächste Einheit?')}
          </p>
        </div>
        <Button
          onClick={() => openQuickLog()}
          className="w-full sm:w-auto shrink-0"
          size="lg"
        >
          <IconPlus size={18} className="shrink-0 mr-2" />
          {tx('Satz erfassen')}
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
              tone={todaySets > 0 ? 'primary' : 'default'}
            />
            <StatStripItem
              title={tx('Streak')}
              value={streak > 0 ? tx`${streak} Tage` : tx('—')}
              icon={<IconFlame size={16} />}
              tone={streak >= 3 ? 'success' : streak > 0 ? 'primary' : 'default'}
            />
            <StatStripItem
              title={tx('Stärker (30 Tage)')}
              value={strengthLabel}
              icon={<IconTrendingUp size={16} />}
              tone={strengthTone}
            />
            <StatStripItem
              title={tx('Übungen')}
              value={totalExercises}
              icon={<IconChartBar size={16} />}
            />
            <StatStripItem
              title={tx('Sätze gesamt')}
              value={totalSets}
              icon={<IconCalendar size={16} />}
            />
          </StatStrip>
        }
        primary={
          <div className="space-y-6">
            {/* Activity Heatmap */}
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-foreground">{tx('Trainingsaktivität')}</h2>
                {selectedDayKey && (
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setSelectedDayKey(null)}
                  >
                    {tx('Filter zurücksetzen')} ✕
                  </button>
                )}
              </div>
              <ActivityHeatmap
                days={heatmapDays}
                todayKey={todayKey}
                onDayClick={(dk) => setSelectedDayKey(prev => prev === dk ? null : dk)}
              />
              {selectedDayKey && (
                <p className="text-xs text-muted-foreground mt-2">
                  {tx`Zeige Sätze vom `}{formatDate(selectedDayKey)}
                </p>
              )}
            </div>

            {/* Chart: Sets per muscle group */}
            <ChartWidget
              title={tx('Trainingsvolumen nach Muskelgruppe')}
              rows={chartRows}
              dimension={{
                kind: 'category',
                accessor: (row) => {
                  const uebId = extractRecordId(row.data.fields.uebung);
                  const ueb = uebId ? uebungenMap.get(uebId) : undefined;
                  return ueb?.fields.muskelgruppe ?? null;
                },
              }}
            />
          </div>
        }
        aside={
          <>
            <WorkList
              title={selectedDayKey
                ? tx`Sätze am ${formatDate(selectedDayKey)}`
                : tx('Letzte Sätze')}
              items={recentLogs.map(r => ({
                id: r.record_id,
                title: r.uebungName || tx('Unbekannte Übung'),
                secondLine: (
                  <span className="text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {r.fields.gewicht_kg ?? '—'} {tx('kg')}
                    </span>
                    {' · '}
                    {r.fields.wiederholungen ?? '—'} {tx('Wdh.')}
                    {r.fields.satz_nummer ? ` · ${tx('Satz')} ${r.fields.satz_nummer}` : ''}
                  </span>
                ),
                action: {
                  label: tx('Satz + 1'),
                  onClick: () => {
                    const uebId = extractRecordId(r.fields.uebung);
                    openQuickLog(uebId ?? undefined);
                  },
                },
              }))}
              onItemClick={(id) => {
                const rec = enrichedTrainingslog.find(r => r.record_id === id);
                if (rec) overlay.replace({ type: 'trainingslog', record: rec });
              }}
              empty={{
                text: tx('Noch kein Training — erfasse deinen ersten Satz!'),
                action: { label: tx('Satz erfassen'), onClick: () => openQuickLog() },
              }}
            />

            <WorkList
              title={tx('Übungen')}
              items={uebungen.slice(0, 6).map(u => ({
                id: u.record_id,
                title: u.fields.name ?? tx('Unbenannt'),
                secondLine: (
                  <span className="text-muted-foreground">
                    {u.fields.muskelgruppe?.label ?? tx('Keine Gruppe')}
                  </span>
                ),
                action: {
                  label: tx('Trainieren'),
                  onClick: () => openQuickLog(u.record_id),
                },
              }))}
              onItemClick={(id) => {
                const rec = uebungen.find(u => u.record_id === id);
                if (rec) overlay.replace({ type: 'uebungen', record: rec });
              }}
              empty={{
                text: tx('Noch keine Übungen — lege deine erste an!'),
                action: {
                  label: tx('Übung anlegen'),
                  onClick: () => {
                    setEditUebungRecord(null);
                    setUebungDialogOpen(true);
                  },
                },
              }}
            />
          </>
        }
      />

      {/* Trainingslog Dialog */}
      <TrainingslogDialog
        open={logDialogOpen}
        onClose={() => setLogDialogOpen(false)}
        onSubmit={handleLogSubmit}
        defaultValues={editLogRecord ? editLogRecord.fields : logDefaults}
        recordId={editLogRecord?.record_id}
        uebungenList={uebungen}
        enablePhotoScan={AI_PHOTO_SCAN['Trainingslog']}
        enablePhotoLocation={AI_PHOTO_LOCATION['Trainingslog']}
      />

      {/* Übungen Dialog */}
      <UebungenDialog
        open={uebungDialogOpen}
        onClose={() => setUebungDialogOpen(false)}
        onSubmit={handleUebungSubmit}
        defaultValues={editUebungRecord?.fields}
        recordId={editUebungRecord?.record_id}
        enablePhotoScan={AI_PHOTO_SCAN['Uebungen']}
        enablePhotoLocation={AI_PHOTO_LOCATION['Uebungen']}
      />

      {/* Overlay Host */}
      <RecordOverlayHost
        overlay={overlay}
        render={(top) => {
          if (top.type === 'uebungen') {
            return (
              <>
                <RecordHeader
                  title={top.record.fields.name ?? appLabel('uebungen')}
                  badges={top.record.fields.muskelgruppe ? (
                    <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                      {top.record.fields.muskelgruppe.label}
                    </span>
                  ) : undefined}
                />
                <UebungenDetails
                  record={top.record}
                  trainingslogList={trainingslog}
                  onOpenTrainingslog={(r) => {
                    const enriched = enrichedTrainingslog.find(e => e.record_id === r.record_id);
                    if (enriched) overlay.push({ type: 'trainingslog', record: enriched });
                  }}
                  onAddTrainingslog={() => {
                    overlay.close();
                    openQuickLog(top.record.record_id);
                  }}
                />
              </>
            );
          }
          if (top.type === 'trainingslog') {
            return (
              <>
                <RecordHeader
                  title={top.record.uebungName || appLabel('trainingslog')}
                  subtitle={formatDate(top.record.fields.datum)}
                />
                <TrainingslogDetails
                  record={top.record}
                  uebungenList={uebungen}
                  onOpenUebungen={(u) => overlay.push({ type: 'uebungen', record: u })}
                />
              </>
            );
          }
          return null;
        }}
        onEdit={(top) => {
          if (top.type === 'trainingslog') {
            setEditLogRecord(top.record);
            setLogDefaults(undefined);
            setLogDialogOpen(true);
            overlay.close();
          } else if (top.type === 'uebungen') {
            setEditUebungRecord(top.record);
            setUebungDialogOpen(true);
            overlay.close();
          }
        }}
        footer={(top) => {
          if (top.type === 'trainingslog') {
            const uebId = extractRecordId(top.record.fields.uebung);
            return {
              label: tx('Nächsten Satz erfassen'),
              onClick: () => {
                overlay.close();
                openQuickLog(uebId ?? undefined);
              },
            };
          }
          if (top.type === 'uebungen') {
            return {
              label: tx('Jetzt trainieren'),
              onClick: () => {
                overlay.close();
                openQuickLog(top.record.record_id);
              },
            };
          }
          return undefined;
        }}
      />
    </div>
  );
}

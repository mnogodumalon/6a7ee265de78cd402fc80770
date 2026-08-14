import { useState, useMemo, useCallback } from 'react';
import { useDashboardData } from '@/hooks/useDashboardData';
import { enrichTrainingslog } from '@/lib/enrich';
import type { EnrichedTrainingslog } from '@/types/enriched';
import type { Uebungen } from '@/types/app';
import { APP_IDS, LOOKUP_OPTIONS } from '@/types/app';
import { LivingAppsService, extractRecordId, createRecordUrl } from '@/services/livingAppsService';
import { formatDate } from '@/lib/formatters';
import { DashboardSkeleton, DashboardError } from '@/components/DashboardStates';
import { tx, appLabel } from '@/i18n';
import { useClock, gruss, namen, undoToast } from '@/lib/polish';
import { format, parseISO, startOfWeek, endOfWeek, isWithinInterval, subWeeks } from 'date-fns';
import { DashboardGrid } from '@/components/DashboardGrid';
import { StatStrip, StatStripItem } from '@/components/StatCard';
import { WorkList } from '@/components/WorkList';
import {
  useRecordOverlayStack,
  RecordOverlayHost,
  RecordHeader,
  RecordAttachments,
} from '@/components/widgets/RecordView';
import { TrainingslogDetails } from '@/components/details/TrainingslogDetails';
import { UebungenDetails } from '@/components/details/UebungenDetails';
import { TrainingslogDialog } from '@/components/dialogs/TrainingslogDialog';
import { UebungenDialog } from '@/components/dialogs/UebungenDialog';
import type { TrainingslogDialogDefaults } from '@/components/dialogs/TrainingslogDialog';
import { AI_PHOTO_SCAN, AI_PHOTO_LOCATION } from '@/config/ai-features';
import { ChartWidget } from '@/components/widgets/ChartWidget';
import { TrainingHeatmap } from '@/components/custom/TrainingHeatmap';
import {
  IconPlus,
  IconBarbell,
  IconFlame,
  IconTrendingUp,
  IconCalendar,
  IconDumbbell,
} from '@tabler/icons-react';
import { Button } from '@/components/ui/button';

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
  const enrichedTrainingslog = enrichTrainingslog(trainingslog, { uebungenMap });

  // Overlay stack
  const overlay = useRecordOverlayStack<OverlayItem>();

  // Dialog state
  const [logDialogOpen, setLogDialogOpen] = useState(false);
  const [logDefaults, setLogDefaults] = useState<TrainingslogDialogDefaults | undefined>(undefined);
  const [editingLog, setEditingLog] = useState<EnrichedTrainingslog | null>(null);
  const [uebungDialogOpen, setUebungDialogOpen] = useState(false);
  const [editingUebung, setEditingUebung] = useState<Uebungen | null>(null);
  const [addLogForUebung, setAddLogForUebung] = useState<Uebungen | null>(null);

  // Heatmap selected day
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // KPI: this week's training days
  const thisWeekStart = useMemo(() => startOfWeek(clock, { weekStartsOn: 1 }), [clock]);
  const thisWeekEnd = useMemo(() => endOfWeek(clock, { weekStartsOn: 1 }), [clock]);

  const thisWeekEntries = useMemo(() =>
    trainingslog.filter(r => {
      if (!r.fields.datum) return false;
      try {
        return isWithinInterval(parseISO(r.fields.datum), { start: thisWeekStart, end: thisWeekEnd });
      } catch { return false; }
    }), [trainingslog, thisWeekStart, thisWeekEnd]);

  const thisWeekSets = thisWeekEntries.length;

  const thisWeekDays = useMemo(() => {
    const days = new Set<string>();
    thisWeekEntries.forEach(r => {
      const d = r.fields.datum;
      if (!d) return;
      try { days.add(format(parseISO(d), 'yyyy-MM-dd')); } catch {}
    });
    return days.size;
  }, [thisWeekEntries]);

  // KPI: strength progress — compare last 4 weeks vs prev 4 weeks per exercise (max weight)
  const strengthProgress = useMemo(() => {
    const now = clock;
    const fourWeeksAgo = subWeeks(now, 4);
    const eightWeeksAgo = subWeeks(now, 8);

    const recent: Record<string, number> = {};
    const prev: Record<string, number> = {};

    trainingslog.forEach(r => {
      if (!r.fields.datum || !r.fields.uebung || !r.fields.gewicht_kg) return;
      try {
        const d = parseISO(r.fields.datum);
        const uebId = extractRecordId(r.fields.uebung);
        if (!uebId) return;
        const kg = r.fields.gewicht_kg;
        if (isWithinInterval(d, { start: fourWeeksAgo, end: now })) {
          recent[uebId] = Math.max(recent[uebId] ?? 0, kg);
        } else if (isWithinInterval(d, { start: eightWeeksAgo, end: fourWeeksAgo })) {
          prev[uebId] = Math.max(prev[uebId] ?? 0, kg);
        }
      } catch {}
    });

    let totalImprovement = 0;
    let count = 0;
    Object.keys(recent).forEach(id => {
      if (prev[id] && prev[id] > 0) {
        totalImprovement += ((recent[id] - prev[id]) / prev[id]) * 100;
        count++;
      }
    });
    return count > 0 ? Math.round(totalImprovement / count) : null;
  }, [trainingslog, clock]);

  // Recent sets for WorkList
  const recentSets = useMemo(() =>
    [...enrichedTrainingslog]
      .sort((a, b) => {
        const da = a.fields.datum ?? '';
        const db = b.fields.datum ?? '';
        return db.localeCompare(da);
      })
      .slice(0, 8),
    [enrichedTrainingslog]
  );

  // Filtered by selected day
  const dayFilteredSets = useMemo(() => {
    if (!selectedDay) return recentSets;
    return enrichedTrainingslog
      .filter(r => {
        if (!r.fields.datum) return false;
        try { return format(parseISO(r.fields.datum), 'yyyy-MM-dd') === selectedDay; } catch { return false; }
      })
      .sort((a, b) => (a.fields.datum ?? '').localeCompare(b.fields.datum ?? ''));
  }, [selectedDay, enrichedTrainingslog, recentSets]);

  // Chart rows for muscle group breakdown
  const chartRows = useMemo(() =>
    enrichedTrainingslog.map(r => ({
      id: `trainingslog:${r.record_id}`,
      data: r,
    })),
    [enrichedTrainingslog]
  );

  // Lookup options inside component (locale-aware)
  const muskelgruppeOptions = LOOKUP_OPTIONS['uebungen']?.['muskelgruppe'] ?? [];

  // Open log dialog with optional pre-fill
  const openLogDialog = useCallback((defaults?: TrainingslogDialogDefaults) => {
    setEditingLog(null);
    setLogDefaults(defaults ?? { datum: format(clock, "yyyy-MM-dd'T'HH:mm") });
    setLogDialogOpen(true);
  }, [clock]);

  // Quick-log from exercise name
  const openLogForExercise = useCallback((ueb: Uebungen) => {
    setEditingLog(null);
    setLogDefaults({
      uebung: ueb.record_id,
      datum: format(clock, "yyyy-MM-dd'T'HH:mm"),
    });
    setLogDialogOpen(true);
  }, [clock]);

  if (loading) return <DashboardSkeleton />;
  if (error) return <DashboardError error={error} onRetry={fetchAll} />;

  const todayKey = format(clock, 'yyyy-MM-dd');
  const activeTrainingDays = new Set(
    trainingslog
      .filter(r => r.fields.datum)
      .map(r => { try { return format(parseISO(r.fields.datum!), 'yyyy-MM-dd'); } catch { return ''; } })
      .filter(Boolean)
  ).size;

  // Context line: last exercise done
  const lastSet = recentSets[0];
  const contextLine = lastSet
    ? tx`Zuletzt: ${lastSet.uebungName || tx('Übung')} — ${lastSet.fields.gewicht_kg ?? '—'} kg × ${lastSet.fields.wiederholungen ?? '—'} Wdh.`
    : tx('Noch kein Training erfasst — leg jetzt los!');

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {gruss(clock)} 💪
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">{contextLine}</p>
        </div>
        {/* Primary CTA: 2-tap log — big and always visible on mobile */}
        <Button
          size="lg"
          className="shrink-0 gap-2"
          onClick={() => openLogDialog()}
        >
          <IconPlus size={18} className="shrink-0" />
          <span className="hidden sm:inline">{tx('Satz erfassen')}</span>
          <span className="sm:hidden">{tx('Satz +')}</span>
        </Button>
      </div>

      <DashboardGrid
        variant="wide"
        kpis={
          <StatStrip>
            <StatStripItem
              title={tx('Trainingstage')}
              value={activeTrainingDays}
              icon={<IconCalendar size={16} />}
              tone="default"
            />
            <StatStripItem
              title={tx('Sätze diese Woche')}
              value={thisWeekSets}
              icon={<IconBarbell size={16} />}
              tone={thisWeekDays >= 3 ? 'success' : thisWeekSets > 0 ? 'primary' : 'default'}
            />
            <StatStripItem
              title={tx('Trainingstage Woche')}
              value={thisWeekDays}
              icon={<IconFlame size={16} />}
              tone={thisWeekDays >= 3 ? 'success' : 'default'}
            />
            <StatStripItem
              title={tx('Stärker (4 Wo.)')}
              value={strengthProgress !== null ? `+${strengthProgress}%` : tx('—')}
              icon={<IconTrendingUp size={16} />}
              tone={strengthProgress !== null && strengthProgress > 0 ? 'success' : 'default'}
            />
          </StatStrip>
        }
        primary={
          <div className="space-y-4">
            {/* Heatmap — primary hero on mobile */}
            <TrainingHeatmap
              entries={trainingslog}
              today={clock}
              selectedDay={selectedDay}
              onDayClick={(day) => setSelectedDay(prev => prev === day ? null : day)}
            />

            {/* Quick-log exercise buttons: one per exercise for 2-tap logging */}
            {uebungen.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {tx('Schnell erfassen')}
                </p>
                <div className="flex flex-wrap gap-2">
                  {uebungen.map(ueb => (
                    <button
                      key={ueb.record_id}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full border border-border bg-background hover:bg-accent text-sm font-medium transition-colors"
                      onClick={() => openLogForExercise(ueb)}
                    >
                      <IconDumbbell size={14} className="shrink-0 text-muted-foreground" />
                      {ueb.fields.name ?? appLabel('uebungen')}
                    </button>
                  ))}
                  <button
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full border border-dashed border-border bg-background hover:bg-accent text-sm text-muted-foreground transition-colors"
                    onClick={() => setUebungDialogOpen(true)}
                  >
                    <IconPlus size={14} className="shrink-0" />
                    {tx('Neue Übung')}
                  </button>
                </div>
              </div>
            )}

            {uebungen.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 gap-3 rounded-xl border border-dashed border-border">
                <IconDumbbell size={48} className="text-muted-foreground" stroke={1.5} />
                <div className="text-center">
                  <p className="font-semibold text-foreground">{tx('Erste Übung anlegen')}</p>
                  <p className="text-sm text-muted-foreground mt-1">{tx('Erstelle deine erste Übung, dann kannst du Sätze erfassen.')}</p>
                </div>
                <Button onClick={() => setUebungDialogOpen(true)}>
                  <IconPlus size={16} className="mr-1.5" />
                  {tx('Übung anlegen')}
                </Button>
              </div>
            )}
          </div>
        }
        aside={
          <>
            <WorkList
              title={selectedDay ? tx('Sätze am ausgewählten Tag') : tx('Letzte Sätze')}
              items={dayFilteredSets.map(r => ({
                id: r.record_id,
                title: r.uebungName || appLabel('uebungen'),
                secondLine: (
                  <>
                    <span className="font-medium text-foreground">
                      {r.fields.gewicht_kg ?? '—'} {tx('kg')}
                    </span>
                    <span className="text-muted-foreground">
                      {' '}× {r.fields.wiederholungen ?? '—'} {tx('Wdh.')}
                    </span>
                    {r.fields.satz_nummer && (
                      <span className="text-muted-foreground"> · {tx('Satz')} {r.fields.satz_nummer}</span>
                    )}
                  </>
                ),
                action: {
                  label: tx('Bearbeiten'),
                  onClick: () => {
                    setEditingLog(r);
                    setLogDefaults({
                      datum: r.fields.datum,
                      uebung: extractRecordId(r.fields.uebung) ?? undefined,
                      satz_nummer: r.fields.satz_nummer,
                      gewicht_kg: r.fields.gewicht_kg,
                      wiederholungen: r.fields.wiederholungen,
                      notiz: r.fields.notiz,
                    });
                    setLogDialogOpen(true);
                  },
                },
              }))}
              onItemClick={id => {
                const r = enrichedTrainingslog.find(x => x.record_id === id);
                if (r) overlay.push({ type: 'trainingslog', record: r });
              }}
              empty={{
                text: selectedDay
                  ? tx('Kein Training an diesem Tag.')
                  : tx('Noch keine Sätze erfasst — starte dein erstes Training!'),
                action: { label: tx('Satz erfassen'), onClick: () => openLogDialog() },
              }}
            />

            {/* Chart: sets per muscle group */}
            <ChartWidget
              title={tx('Sätze pro Muskelgruppe')}
              rows={uebungen.map(ueb => ({
                id: `uebungen:${ueb.record_id}`,
                data: {
                  muskelgruppe: ueb.fields.muskelgruppe,
                  satzCount: trainingslog.filter(r => extractRecordId(r.fields.uebung) === ueb.record_id).length,
                },
              }))}
              dimension={{
                kind: 'category',
                accessor: r => r.data.muskelgruppe,
              }}
              measure={{
                aggregate: 'sum',
                label: tx('Sätze'),
                value: r => r.data.satzCount ?? null,
                format: 'number',
              }}
            />
          </>
        }
      />

      {/* Training log dialog */}
      <TrainingslogDialog
        open={logDialogOpen}
        onClose={() => { setLogDialogOpen(false); setEditingLog(null); setAddLogForUebung(null); }}
        onSubmit={async (fields) => {
          if (editingLog) {
            await LivingAppsService.updateTrainingslogEntry(editingLog.record_id, fields);
            undoToast(tx`${editingLog.uebungName || tx('Satz')} — aktualisiert`, async () => {
              await LivingAppsService.updateTrainingslogEntry(editingLog.record_id, editingLog.fields as any);
              fetchAll();
            });
          } else {
            await LivingAppsService.createTrainingslogEntry(fields);
            undoToast(tx('Satz erfasst'));
          }
          fetchAll();
        }}
        defaultValues={logDefaults}
        recordId={editingLog?.record_id}
        uebungenList={uebungen}
        enablePhotoScan={AI_PHOTO_SCAN['Trainingslog']}
        enablePhotoLocation={AI_PHOTO_LOCATION['Trainingslog']}
      />

      {/* Uebungen dialog */}
      <UebungenDialog
        open={uebungDialogOpen || !!editingUebung}
        onClose={() => { setUebungDialogOpen(false); setEditingUebung(null); }}
        onSubmit={async (fields) => {
          if (editingUebung) {
            await LivingAppsService.updateUebungenEntry(editingUebung.record_id, fields);
            undoToast(tx`${editingUebung.fields.name ?? tx('Übung')} — aktualisiert`);
          } else {
            await LivingAppsService.createUebungenEntry(fields);
            undoToast(tx('Übung angelegt'));
          }
          fetchAll();
        }}
        defaultValues={editingUebung?.fields}
        recordId={editingUebung?.record_id}
        enablePhotoScan={AI_PHOTO_SCAN['Uebungen']}
        enablePhotoLocation={AI_PHOTO_LOCATION['Uebungen']}
      />

      {/* Record overlay host */}
      <RecordOverlayHost
        overlay={overlay}
        render={top => {
          if (top.type === 'trainingslog') {
            const r = top.record;
            return (
              <>
                <RecordHeader
                  title={r.uebungName || appLabel('trainingslog')}
                  subtitle={r.fields.datum ? formatDate(r.fields.datum) : undefined}
                />
                <TrainingslogDetails
                  record={r}
                  uebungenList={uebungen}
                  onOpenUebungen={ueb => overlay.push({ type: 'uebungen', record: ueb })}
                />
              </>
            );
          }
          if (top.type === 'uebungen') {
            const r = top.record;
            return (
              <>
                <RecordHeader
                  title={r.fields.name ?? appLabel('uebungen')}
                  subtitle={r.fields.muskelgruppe?.label}
                />
                <UebungenDetails
                  record={r}
                  trainingslogList={trainingslog}
                  onOpenTrainingslog={log => {
                    const enriched = enrichedTrainingslog.find(x => x.record_id === log.record_id);
                    if (enriched) overlay.push({ type: 'trainingslog', record: enriched });
                  }}
                  onAddTrainingslog={() => {
                    overlay.close();
                    openLogForExercise(r);
                  }}
                />
              </>
            );
          }
          return null;
        }}
        onEdit={top => {
          if (top.type === 'trainingslog') {
            const r = top.record;
            setEditingLog(r);
            setLogDefaults({
              datum: r.fields.datum,
              uebung: extractRecordId(r.fields.uebung) ?? undefined,
              satz_nummer: r.fields.satz_nummer,
              gewicht_kg: r.fields.gewicht_kg,
              wiederholungen: r.fields.wiederholungen,
              notiz: r.fields.notiz,
            });
            setLogDialogOpen(true);
          } else if (top.type === 'uebungen') {
            setEditingUebung(top.record);
          }
        }}
        footer={top => {
          if (top.type === 'trainingslog') {
            const uebId = extractRecordId(top.record.fields.uebung);
            const ueb = uebId ? uebungen.find(u => u.record_id === uebId) : null;
            if (!ueb) return undefined;
            return {
              label: tx`Weiterer Satz — ${ueb.fields.name ?? tx('Übung')}`,
              onClick: () => { overlay.close(); openLogForExercise(ueb); },
            };
          }
          return undefined;
        }}
      />
    </div>
  );
}

import { useState, useMemo, useCallback } from 'react';
import { useDashboardData } from '@/hooks/useDashboardData';
import { enrichTrainingslog } from '@/lib/enrich';
import type { EnrichedTrainingslog } from '@/types/enriched';
import type { Uebungen } from '@/types/app';
import { APP_IDS } from '@/types/app';
import { LivingAppsService, extractRecordId, createRecordUrl } from '@/services/livingAppsService';
import { formatDate } from '@/lib/formatters';
// Pre-generated loading/error surfaces (self-repair flow inside) — keep these
// imports and the two early-returns below; never re-implement them here.
import { DashboardSkeleton, DashboardError } from '@/components/DashboardStates';
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
import type { TrainingslogDialogDefaults } from '@/components/dialogs/TrainingslogDialog';
import { UebungenDialog } from '@/components/dialogs/UebungenDialog';
import { AI_PHOTO_SCAN } from '@/config/ai-features';
import { useClock, gruss, namen, undoToast } from '@/lib/polish';
import { tx, appLabel, fieldLabel } from '@/i18n';
import { format, parseISO, startOfMonth, endOfMonth, eachDayOfInterval, getDay, subMonths, isSameDay, isToday } from 'date-fns';
import {
  IconPlus, IconFlame, IconTrendingUp, IconBarbell,
  IconCalendar, IconChevronLeft, IconChevronRight,
} from '@tabler/icons-react';

// Pre-generated overlay union — keep both branches
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

  // Heatmap month navigation
  const [heatmapOffset, setHeatmapOffset] = useState(0); // 0 = current month

  // ─── All hooks above early returns ───────────────────────────────────────

  // Derived training data
  const todayKey = format(clock, 'yyyy-MM-dd');

  const logsByDay = useMemo(() => {
    const map = new Map<string, EnrichedTrainingslog[]>();
    for (const r of enrichedTrainingslog) {
      if (!r.fields.datum) continue;
      const key = r.fields.datum.slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return map;
  }, [enrichedTrainingslog]);

  // Heatmap data for a given month
  const heatmapMonth = useMemo(() => {
    const base = subMonths(clock, heatmapOffset);
    const start = startOfMonth(base);
    const end = endOfMonth(base);
    const days = eachDayOfInterval({ start, end });
    const maxSets = Math.max(1, ...days.map(d => {
      const key = format(d, 'yyyy-MM-dd');
      return logsByDay.get(key)?.length ?? 0;
    }));
    return {
      label: format(base, 'MMMM yyyy'),
      days: days.map(d => {
        const key = format(d, 'yyyy-MM-dd');
        const sets = logsByDay.get(key)?.length ?? 0;
        const weekday = getDay(d); // 0=Sun
        return { date: d, key, sets, weekday, isToday: isToday(d) };
      }),
      maxSets,
      startWeekday: getDay(start), // offset for grid
    };
  }, [clock, heatmapOffset, logsByDay]);

  // Strength progress: for each exercise, compare last session vs first session max weight
  const strengthProgress = useMemo(() => {
    const byUebung = new Map<string, { name: string; sessions: { date: string; maxWeight: number }[] }>();
    for (const r of enrichedTrainingslog) {
      if (!r.fields.uebung || !r.fields.gewicht_kg) continue;
      const id = extractRecordId(r.fields.uebung);
      if (!id) continue;
      const name = r.uebungName || id;
      if (!byUebung.has(id)) byUebung.set(id, { name, sessions: [] });
      const dateKey = r.fields.datum?.slice(0, 10) ?? '';
      const entry = byUebung.get(id)!;
      const existing = entry.sessions.find(s => s.date === dateKey);
      if (existing) {
        existing.maxWeight = Math.max(existing.maxWeight, r.fields.gewicht_kg);
      } else {
        entry.sessions.push({ date: dateKey, maxWeight: r.fields.gewicht_kg });
      }
    }
    const result: { id: string; name: string; firstWeight: number; lastWeight: number; pct: number }[] = [];
    for (const [id, data] of byUebung.entries()) {
      if (data.sessions.length < 2) continue;
      const sorted = [...data.sessions].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
      const first = sorted[0].maxWeight;
      const last = sorted[sorted.length - 1].maxWeight;
      const pct = first > 0 ? Math.round(((last - first) / first) * 100) : 0;
      result.push({ id, name: data.name, firstWeight: first, lastWeight: last, pct });
    }
    return result.sort((a, b) => b.pct - a.pct);
  }, [enrichedTrainingslog]);

  // KPI stats
  const todaySets = logsByDay.get(todayKey)?.length ?? 0;
  const weekKeys = useMemo(() => {
    const keys: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(clock);
      d.setDate(d.getDate() - i);
      keys.push(format(d, 'yyyy-MM-dd'));
    }
    return keys;
  }, [clock]);
  const weekSets = weekKeys.reduce((acc, k) => acc + (logsByDay.get(k)?.length ?? 0), 0);
  const totalSessions = useMemo(() => {
    const days = new Set(enrichedTrainingslog.map(r => r.fields.datum?.slice(0, 10)).filter(Boolean));
    return days.size;
  }, [enrichedTrainingslog]);

  // Recent logs for the aside work list
  const recentLogs = useMemo(() =>
    [...enrichedTrainingslog]
      .sort((a, b) => (b.fields.datum ?? '').localeCompare(a.fields.datum ?? ''))
      .slice(0, 10),
    [enrichedTrainingslog]
  );

  // Open quick-log dialog with today's date pre-filled
  const openQuickLog = useCallback(() => {
    setEditingLog(null);
    setLogDefaults({ datum: format(clock, "yyyy-MM-dd'T'HH:mm") });
    setLogDialogOpen(true);
  }, [clock]);

  // Open log dialog pre-filled for a specific exercise
  const openLogForUebung = useCallback((uebung: Uebungen) => {
    setAddLogForUebung(uebung);
    setEditingLog(null);
    setLogDefaults({ datum: format(clock, "yyyy-MM-dd'T'HH:mm"), uebung: uebung.record_id });
    setLogDialogOpen(true);
  }, [clock]);

  if (loading) return <DashboardSkeleton />;
  if (error) return <DashboardError error={error} onRetry={fetchAll} />;

  // ─── Below this line: JSX only ───────────────────────────────────────────

  const hasData = enrichedTrainingslog.length > 0;
  const bestGain = strengthProgress[0];

  // Heatmap intensity class helper
  function heatCell(sets: number, maxSets: number): string {
    if (sets === 0) return 'bg-muted/50';
    const ratio = sets / maxSets;
    if (ratio < 0.25) return 'bg-primary/20';
    if (ratio < 0.5) return 'bg-primary/40';
    if (ratio < 0.75) return 'bg-primary/65';
    return 'bg-primary';
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {gruss(clock)}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {hasData
              ? todaySets > 0
                ? tx`${todaySets} Sätze heute — weiter so!`
                : tx`Noch kein Training heute — leg los!`
              : tx`Bereit für dein erstes Training?`}
          </p>
        </div>
        {/* Primary CTA — mobile quick-log in 2 taps */}
        <button
          onClick={openQuickLog}
          className="shrink-0 flex items-center gap-2 rounded-xl bg-primary text-primary-foreground font-semibold px-4 py-3 text-sm shadow-lg active:scale-95 transition-transform"
        >
          <IconPlus size={18} className="shrink-0" />
          <span>{tx('Satz loggen')}</span>
        </button>
      </div>

      <DashboardGrid
        variant="wide"
        kpis={
          <StatStrip>
            <StatStripItem
              title={tx('Heute')}
              value={todaySets}
              icon={<IconFlame size={16} />}
              tone={todaySets > 0 ? 'success' : 'default'}
            />
            <StatStripItem
              title={tx('Diese Woche')}
              value={weekSets}
              icon={<IconBarbell size={16} />}
              tone={weekSets >= 15 ? 'success' : weekSets >= 5 ? 'primary' : 'default'}
            />
            <StatStripItem
              title={tx('Trainingstage')}
              value={totalSessions}
              icon={<IconCalendar size={16} />}
            />
            {bestGain && (
              <StatStripItem
                title={bestGain.name}
                value={`+${bestGain.pct}%`}
                icon={<IconTrendingUp size={16} />}
                tone={bestGain.pct > 0 ? 'success' : 'default'}
              />
            )}
          </StatStrip>
        }
        primary={
          <div className="space-y-6">
            {/* Heatmap */}
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold text-base">{tx('Trainings-Heatmap')}</h2>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setHeatmapOffset(o => o + 1)}
                    className="rounded-lg p-1.5 hover:bg-muted text-muted-foreground"
                    aria-label={tx('Vorheriger Monat')}
                  >
                    <IconChevronLeft size={16} />
                  </button>
                  <span className="text-sm font-medium min-w-[120px] text-center">
                    {heatmapMonth.label}
                  </span>
                  <button
                    onClick={() => setHeatmapOffset(o => Math.max(0, o - 1))}
                    className="rounded-lg p-1.5 hover:bg-muted text-muted-foreground disabled:opacity-40"
                    disabled={heatmapOffset === 0}
                    aria-label={tx('Nächster Monat')}
                  >
                    <IconChevronRight size={16} />
                  </button>
                </div>
              </div>
              {/* Weekday labels */}
              <div className="grid grid-cols-7 gap-1 mb-1">
                {[tx('So'), tx('Mo'), tx('Di'), tx('Mi'), tx('Do'), tx('Fr'), tx('Sa')].map((d, i) => (
                  <div key={i} className="text-center text-[10px] text-muted-foreground font-medium">{d}</div>
                ))}
              </div>
              {/* Day cells */}
              <div className="grid grid-cols-7 gap-1">
                {/* Offset cells for first weekday */}
                {Array.from({ length: heatmapMonth.startWeekday }, (_, i) => (
                  <div key={`off-${i}`} />
                ))}
                {heatmapMonth.days.map(({ date, key, sets, isToday: today }) => (
                  <button
                    key={key}
                    title={`${format(date, 'd. MMM')}: ${sets} ${tx('Sätze')}`}
                    onClick={() => {
                      const dayLogs = logsByDay.get(key);
                      if (dayLogs && dayLogs.length > 0) {
                        overlay.replace({ type: 'trainingslog', record: dayLogs[0] });
                      } else {
                        setLogDefaults({ datum: `${key}T12:00` });
                        setEditingLog(null);
                        setLogDialogOpen(true);
                      }
                    }}
                    className={[
                      'aspect-square rounded-md transition-all active:scale-90',
                      heatCell(sets, heatmapMonth.maxSets),
                      today ? 'ring-2 ring-primary ring-offset-1' : '',
                    ].join(' ')}
                  />
                ))}
              </div>
              {/* Legend */}
              <div className="flex items-center gap-2 mt-3 justify-end">
                <span className="text-[10px] text-muted-foreground">{tx('Weniger')}</span>
                {['bg-muted/50', 'bg-primary/20', 'bg-primary/40', 'bg-primary/65', 'bg-primary'].map((cls, i) => (
                  <div key={i} className={`w-3 h-3 rounded-sm ${cls}`} />
                ))}
                <span className="text-[10px] text-muted-foreground">{tx('Mehr')}</span>
              </div>
            </div>

            {/* Strength progress */}
            {strengthProgress.length > 0 && (
              <div className="rounded-xl border bg-card p-4">
                <h2 className="font-semibold text-base mb-3">{tx('Kraftfortschritt')}</h2>
                <div className="space-y-2">
                  {strengthProgress.slice(0, 6).map(ex => (
                    <div key={ex.id} className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium truncate">{ex.name}</span>
                          <span className={`text-sm font-bold shrink-0 ${ex.pct > 0 ? 'text-green-600' : ex.pct < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                            {ex.pct > 0 ? `+${ex.pct}%` : `${ex.pct}%`}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${ex.pct > 0 ? 'bg-green-500' : ex.pct < 0 ? 'bg-destructive' : 'bg-muted-foreground'}`}
                              style={{ width: `${Math.min(100, Math.abs(ex.pct))}%` }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {ex.firstWeight} → {ex.lastWeight} {tx('kg')}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Empty state */}
            {!hasData && (
              <div className="rounded-xl border bg-card p-8 flex flex-col items-center gap-4 text-center">
                <IconBarbell size={48} className="text-muted-foreground" stroke={1.5} />
                <div>
                  <h3 className="font-semibold text-lg mb-1">{tx('Starte dein Training')}</h3>
                  <p className="text-sm text-muted-foreground">{tx('Logge deinen ersten Satz und verfolge deinen Fortschritt.')}</p>
                </div>
                <button
                  onClick={openQuickLog}
                  className="flex items-center gap-2 rounded-xl bg-primary text-primary-foreground font-semibold px-5 py-3 text-sm shadow active:scale-95 transition-transform"
                >
                  <IconPlus size={16} />
                  {tx('Ersten Satz loggen')}
                </button>
              </div>
            )}
          </div>
        }
        aside={
          <>
            {/* Recent sets */}
            <WorkList
              title={tx('Letzte Sätze')}
              items={recentLogs.map(r => ({
                id: r.record_id,
                title: r.uebungName || tx('Unbekannte Übung'),
                secondLine: (
                  <span className="text-muted-foreground">
                    {r.fields.gewicht_kg != null && r.fields.wiederholungen != null
                      ? tx`${r.fields.gewicht_kg} kg × ${r.fields.wiederholungen} Wdh.`
                      : formatDate(r.fields.datum)}
                  </span>
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
                if (r) overlay.replace({ type: 'trainingslog', record: r });
              }}
              empty={{
                text: tx('Noch keine Sätze geloggt'),
                action: { label: tx('Ersten Satz loggen'), onClick: openQuickLog },
              }}
            />

            {/* Exercises list */}
            <WorkList
              title={appLabel('uebungen')}
              items={uebungen.map(u => ({
                id: u.record_id,
                title: u.fields.name ?? '—',
                secondLine: (
                  <span className="text-muted-foreground">
                    {u.fields.muskelgruppe?.label ?? ''}
                  </span>
                ),
                action: {
                  label: tx('Satz loggen'),
                  onClick: () => openLogForUebung(u),
                },
              }))}
              onItemClick={id => {
                const u = uebungen.find(x => x.record_id === id);
                if (u) overlay.replace({ type: 'uebungen', record: u });
              }}
              empty={{
                text: tx('Noch keine Übungen angelegt'),
                action: {
                  label: tx('Übung anlegen'),
                  onClick: () => {
                    setEditingUebung(null);
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
        onClose={() => {
          setLogDialogOpen(false);
          setEditingLog(null);
          setAddLogForUebung(null);
          setLogDefaults(undefined);
        }}
        onSubmit={async (fields) => {
          if (editingLog) {
            await LivingAppsService.updateTrainingslogEntry(editingLog.record_id, fields);
            undoToast(
              tx`Satz aktualisiert`,
              async () => {
                await LivingAppsService.updateTrainingslogEntry(editingLog.record_id, editingLog.fields as any);
                fetchAll();
              }
            );
          } else {
            await LivingAppsService.createTrainingslogEntry(fields);
            undoToast(tx`Satz geloggt`);
          }
          fetchAll();
        }}
        defaultValues={logDefaults}
        recordId={editingLog?.record_id}
        uebungenList={uebungen}
        enablePhotoScan={AI_PHOTO_SCAN['Trainingslog']}
      />

      {/* Uebungen Dialog */}
      <UebungenDialog
        open={uebungDialogOpen}
        onClose={() => {
          setUebungDialogOpen(false);
          setEditingUebung(null);
        }}
        onSubmit={async (fields) => {
          if (editingUebung) {
            await LivingAppsService.updateUebungenEntry(editingUebung.record_id, fields);
            undoToast(tx`Übung aktualisiert`);
          } else {
            await LivingAppsService.createUebungenEntry(fields);
            undoToast(tx`Übung angelegt`);
          }
          fetchAll();
        }}
        defaultValues={editingUebung?.fields}
        recordId={editingUebung?.record_id}
        enablePhotoScan={AI_PHOTO_SCAN['Uebungen']}
      />

      {/* Record overlay */}
      <RecordOverlayHost
        overlay={overlay}
        render={top => {
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
                  onOpenUebungen={u => overlay.push({ type: 'uebungen', record: u })}
                />
              </>
            );
          }
          if (top.type === 'uebungen') {
            return (
              <>
                <RecordHeader
                  title={top.record.fields.name ?? appLabel('uebungen')}
                  subtitle={top.record.fields.muskelgruppe?.label}
                />
                <UebungenDetails
                  record={top.record}
                  trainingslogList={trainingslog}
                  onOpenTrainingslog={r => {
                    const enriched = enrichedTrainingslog.find(e => e.record_id === r.record_id);
                    if (enriched) overlay.push({ type: 'trainingslog', record: enriched });
                  }}
                  onAddTrainingslog={() => openLogForUebung(top.record)}
                />
              </>
            );
          }
          return null;
        }}
        onEdit={top => {
          if (top.type === 'trainingslog') {
            setEditingLog(top.record);
            setLogDefaults({
              datum: top.record.fields.datum,
              uebung: extractRecordId(top.record.fields.uebung) ?? undefined,
              satz_nummer: top.record.fields.satz_nummer,
              gewicht_kg: top.record.fields.gewicht_kg,
              wiederholungen: top.record.fields.wiederholungen,
              notiz: top.record.fields.notiz,
            });
            setLogDialogOpen(true);
          } else if (top.type === 'uebungen') {
            setEditingUebung(top.record);
            setUebungDialogOpen(true);
          }
        }}
        footer={top => {
          if (top.type === 'uebungen') {
            return {
              label: tx('Satz loggen'),
              onClick: () => openLogForUebung(top.record),
            };
          }
          return undefined;
        }}
      />
    </div>
  );
}

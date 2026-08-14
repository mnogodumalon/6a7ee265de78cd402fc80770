import { useState, useMemo, useCallback } from 'react';
import { format, parseISO, startOfMonth, endOfMonth, eachDayOfInterval, subMonths, isToday } from 'date-fns';
import { useDashboardData } from '@/hooks/useDashboardData';
import { enrichTrainingslog } from '@/lib/enrich';
import type { EnrichedTrainingslog } from '@/types/enriched';
import type { Uebungen } from '@/types/app';
import { APP_IDS, LOOKUP_OPTIONS } from '@/types/app';
import { LivingAppsService, extractRecordId, createRecordUrl } from '@/services/livingAppsService';
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
import { useClock, gruss, undoToast } from '@/lib/polish';
import { tx, appLabel, fieldLabel } from '@/i18n';
import { AI_PHOTO_SCAN, AI_PHOTO_LOCATION } from '@/config/ai-features';
import {
  IconPlus,
  IconBarbell,
  IconFlame,
  IconTrophy,
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
} from '@tabler/icons-react';
import { Button } from '@/components/ui/button';

// layout-opt-out: not used — using DashboardGrid variant="wide"

export type OverlayItem =
  | { type: 'uebungen'; record: Uebungen }
  | { type: 'trainingslog'; record: EnrichedTrainingslog };

// Heatmap: CalendarWidget is rejected because it renders TIME-BASED events
// with click-open overlays and a week/month navigation UI — it cannot render
// per-day intensity tiles (heat colors scaled by set count) without forking.
// We hand-build a compact month heatmap grid specifically for that purpose.

const HEATMAP_COLORS = [
  'bg-muted',
  'bg-primary/20',
  'bg-primary/40',
  'bg-primary/60',
  'bg-primary/80',
  'bg-primary',
];

function getHeatLevel(count: number, max: number): number {
  if (count === 0) return 0;
  if (max === 0) return 1;
  return Math.min(5, Math.ceil((count / max) * 5));
}

export default function DashboardOverview() {
  const {
    uebungen, trainingslog,
    uebungenMap,
    loading, error, fetchAll,
  } = useDashboardData();

  const clock = useClock();
  const overlay = useRecordOverlayStack<OverlayItem>();

  // Heatmap month navigation
  const [heatmapOffset, setHeatmapOffset] = useState(0); // 0 = current month

  // Quick-log dialog state
  const [logDialogOpen, setLogDialogOpen] = useState(false);
  const [logDefaults, setLogDefaults] = useState<TrainingslogDialogDefaults | undefined>(undefined);
  const [editingLog, setEditingLog] = useState<EnrichedTrainingslog | null>(null);

  // Übung create dialog
  const [uebungDialogOpen, setUebungDialogOpen] = useState(false);
  const [editingUebung, setEditingUebung] = useState<Uebungen | null>(null);

  // Selected exercise for strength progress
  const [selectedUebungId, setSelectedUebungId] = useState<string | null>(null);

  const enrichedTrainingslog = enrichTrainingslog(trainingslog, { uebungenMap });

  // ─── Every hook goes ABOVE this line ───
  if (loading) return <DashboardSkeleton />;
  if (error) return <DashboardError error={error} onRetry={fetchAll} />;

  // ─── Plain derivations below ───

  const today = format(clock, 'yyyy-MM-dd');
  const todayDate = clock;

  // Training days (unique days with any log entry)
  const trainingDaySet = new Set<string>();
  const daySetCounts = new Map<string, number>();
  for (const r of enrichedTrainingslog) {
    if (!r.fields.datum) continue;
    const day = r.fields.datum.slice(0, 10);
    trainingDaySet.add(day);
    daySetCounts.set(day, (daySetCounts.get(day) ?? 0) + 1);
  }

  // Heatmap month
  const heatmapMonth = subMonths(todayDate, heatmapOffset);
  const monthStart = startOfMonth(heatmapMonth);
  const monthEnd = endOfMonth(heatmapMonth);
  const monthDays = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const maxSetsInDay = Math.max(0, ...Array.from(daySetCounts.values()));

  // Weekday offset for grid start (Mon=0)
  const firstWeekday = (monthStart.getDay() + 6) % 7;

  // Stats
  const totalSets = enrichedTrainingslog.length;
  const thisWeekStart = format(new Date(clock.getFullYear(), clock.getMonth(), clock.getDate() - clock.getDay() + (clock.getDay() === 0 ? -6 : 1)), 'yyyy-MM-dd');
  const setsThisWeek = enrichedTrainingslog.filter(r => r.fields.datum && r.fields.datum.slice(0, 10) >= thisWeekStart).length;
  const trainingsThisMonth = new Set(
    enrichedTrainingslog
      .filter(r => r.fields.datum && r.fields.datum.startsWith(format(clock, 'yyyy-MM')))
      .map(r => r.fields.datum!.slice(0, 10))
  ).size;

  // Strength progress: best weight per exercise (last 30 days vs prev 30 days)
  const thirtyDaysAgo = format(new Date(clock.getTime() - 30 * 24 * 60 * 60 * 1000), 'yyyy-MM-dd');
  const sixtyDaysAgo = format(new Date(clock.getTime() - 60 * 24 * 60 * 60 * 1000), 'yyyy-MM-dd');

  const strengthByExercise = new Map<string, { current: number; prev: number; name: string }>();
  for (const r of enrichedTrainingslog) {
    if (!r.fields.datum || !r.fields.gewicht_kg) continue;
    const day = r.fields.datum.slice(0, 10);
    const uid = extractRecordId(r.fields.uebung);
    if (!uid) continue;
    const name = r.uebungName || uid;
    const existing = strengthByExercise.get(uid) ?? { current: 0, prev: 0, name };
    if (day >= thirtyDaysAgo) {
      existing.current = Math.max(existing.current, r.fields.gewicht_kg);
    } else if (day >= sixtyDaysAgo) {
      existing.prev = Math.max(existing.prev, r.fields.gewicht_kg);
    }
    strengthByExercise.set(uid, existing);
  }

  const strengthEntries = Array.from(strengthByExercise.entries())
    .filter(([, v]) => v.current > 0)
    .map(([id, v]) => ({
      id,
      name: v.name,
      current: v.current,
      prev: v.prev,
      pct: v.prev > 0 ? Math.round(((v.current - v.prev) / v.prev) * 100) : null,
    }))
    .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));

  // Recent sets for WorkList
  const recentSets = [...enrichedTrainingslog]
    .sort((a, b) => (b.fields.datum ?? '').localeCompare(a.fields.datum ?? ''))
    .slice(0, 8);

  // Today's sets
  const todaySets = enrichedTrainingslog.filter(r => r.fields.datum && r.fields.datum.startsWith(today));

  // Quick log with exercise preselect
  function openQuickLog(uebungId?: string) {
    setLogDefaults({
      datum: format(clock, "yyyy-MM-dd'T'HH:mm"),
      uebung: uebungId,
    });
    setEditingLog(null);
    setLogDialogOpen(true);
  }

  function openEditLog(r: EnrichedTrainingslog) {
    setEditingLog(r);
    setLogDefaults(r.fields as TrainingslogDialogDefaults);
    setLogDialogOpen(true);
  }

  // Most-used exercise as default for quick-log
  const exerciseUsageCounts = new Map<string, number>();
  for (const r of enrichedTrainingslog) {
    const uid = extractRecordId(r.fields.uebung);
    if (uid) exerciseUsageCounts.set(uid, (exerciseUsageCounts.get(uid) ?? 0) + 1);
  }
  const topExerciseId = Array.from(exerciseUsageCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];

  const weekDayLabels = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {gruss(clock)} 💪
          </h1>
          <p className="text-muted-foreground mt-1">
            {todaySets.length > 0
              ? tx`${todaySets.length} Sätze heute — weiter so!`
              : setsThisWeek > 0
              ? tx`${setsThisWeek} Sätze diese Woche`
              : tx`Leg los — erfasse deinen ersten Satz!`}
          </p>
        </div>
        <Button
          onClick={() => openQuickLog(topExerciseId)}
          size="lg"
          className="gap-2 shrink-0"
        >
          <IconPlus size={18} />
          {tx('Satz erfassen')}
        </Button>
      </div>

      <DashboardGrid
        variant="wide"
        kpis={
          <StatStrip>
            <StatStripItem
              title={tx('Heute')}
              value={todaySets.length}
              icon={<IconFlame size={16} />}
              tone={todaySets.length > 0 ? 'success' : 'default'}
            />
            <StatStripItem
              title={tx('Diese Woche')}
              value={setsThisWeek}
              icon={<IconBarbell size={16} />}
              tone={setsThisWeek > 5 ? 'primary' : 'default'}
            />
            <StatStripItem
              title={tx('Trainingstage diesen Monat')}
              value={trainingsThisMonth}
              icon={<IconCalendar size={16} />}
              tone="default"
            />
            <StatStripItem
              title={tx('Sätze gesamt')}
              value={totalSets}
              icon={<IconTrophy size={16} />}
              tone="default"
            />
          </StatStrip>
        }
        primary={
          // Heatmap: CalendarWidget rejected — it renders event items, not heat-intensity tiles.
          // A workout heatmap needs per-day color intensity scaled by set count, not event cards.
          <div className="rounded-xl border bg-card p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-base">
                {tx('Trainings-Heatmap')} — {format(heatmapMonth, 'MMMM yyyy')}
              </h2>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setHeatmapOffset(o => o + 1)}
                >
                  <IconChevronLeft size={16} />
                </Button>
                {heatmapOffset > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setHeatmapOffset(0)}
                  >
                    {tx('Heute')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setHeatmapOffset(o => Math.max(0, o - 1))}
                  disabled={heatmapOffset === 0}
                >
                  <IconChevronRight size={16} />
                </Button>
              </div>
            </div>

            {/* Weekday headers */}
            <div className="grid grid-cols-7 gap-1 text-center">
              {weekDayLabels.map(d => (
                <div key={d} className="text-xs text-muted-foreground font-medium py-1">{d}</div>
              ))}
            </div>

            {/* Day tiles */}
            <div className="grid grid-cols-7 gap-1">
              {/* Empty cells before month start */}
              {Array.from({ length: firstWeekday }).map((_, i) => (
                <div key={`empty-${i}`} />
              ))}
              {monthDays.map(day => {
                const dayKey = format(day, 'yyyy-MM-dd');
                const count = daySetCounts.get(dayKey) ?? 0;
                const level = getHeatLevel(count, maxSetsInDay);
                const isCurrentDay = dayKey === today;
                return (
                  <button
                    key={dayKey}
                    onClick={() => {
                      if (count > 0) {
                        // Filter recent sets view to this day
                        openQuickLog(topExerciseId);
                      } else {
                        openQuickLog(topExerciseId);
                      }
                    }}
                    title={count > 0 ? tx`${count} Sätze` : tx('Kein Training')}
                    className={[
                      'aspect-square rounded-md flex items-center justify-center text-xs font-medium transition-all',
                      HEATMAP_COLORS[level],
                      isCurrentDay ? 'ring-2 ring-primary ring-offset-1' : '',
                      level > 0 ? 'text-primary-foreground' : 'text-muted-foreground',
                      'hover:opacity-80 cursor-pointer',
                    ].filter(Boolean).join(' ')}
                  >
                    {format(day, 'd')}
                  </button>
                );
              })}
            </div>

            {/* Legend */}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{tx('Weniger')}</span>
              {HEATMAP_COLORS.map((c, i) => (
                <div key={i} className={`w-3 h-3 rounded-sm ${c}`} />
              ))}
              <span>{tx('Mehr')}</span>
              <span className="ml-auto">{tx('Sätze pro Tag')}</span>
            </div>
          </div>
        }
        aside={
          <>
            {/* Strength Progress */}
            <div className="rounded-xl border bg-card p-4 space-y-3">
              <h2 className="font-semibold text-base flex items-center gap-2">
                <IconTrophy size={16} className="shrink-0 text-muted-foreground" />
                {tx('Kraftentwicklung')}
              </h2>
              {strengthEntries.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  {tx('Noch keine Daten — erfasse Gewicht beim Training.')}
                </p>
              ) : (
                <div className="space-y-2">
                  {strengthEntries.slice(0, 6).map(e => (
                    <button
                      key={e.id}
                      onClick={() => {
                        setSelectedUebungId(e.id);
                        const ue = uebungenMap.get(e.id);
                        if (ue) overlay.replace({ type: 'uebungen', record: ue });
                      }}
                      className="w-full flex items-center justify-between text-sm hover:bg-muted/50 rounded-lg px-2 py-1.5 transition-colors text-left"
                    >
                      <span className="font-medium min-w-0 truncate">{e.name}</span>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        <span className="text-muted-foreground">{e.current} {tx('kg')}</span>
                        {e.pct !== null && (
                          <span className={`text-xs font-semibold ${e.pct > 0 ? 'text-green-600' : e.pct < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                            {e.pct > 0 ? '+' : ''}{e.pct}%
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {uebungen.length === 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full mt-2"
                  onClick={() => { setEditingUebung(null); setUebungDialogOpen(true); }}
                >
                  <IconPlus size={14} className="mr-1" />
                  {tx('Erste Übung anlegen')}
                </Button>
              )}
            </div>

            {/* Recent Sets */}
            <WorkList
              title={tx('Letzte Sätze')}
              items={recentSets.map(r => ({
                id: r.record_id,
                title: r.uebungName || appLabel('uebungen'),
                secondLine: (
                  <span className="text-muted-foreground text-xs">
                    {r.fields.gewicht_kg != null && (
                      <><span className="font-medium text-foreground">{r.fields.gewicht_kg} {tx('kg')}</span>{' · '}</>
                    )}
                    {r.fields.wiederholungen != null && (
                      <><span className="font-medium text-foreground">{r.fields.wiederholungen}×</span>{' · '}</>
                    )}
                    {r.fields.satz_nummer != null && (
                      <span>{tx('Satz')} {r.fields.satz_nummer}</span>
                    )}
                  </span>
                ),
                action: {
                  label: tx('Bearbeiten'),
                  onClick: () => openEditLog(r),
                },
              }))}
              onItemClick={id => {
                const r = enrichedTrainingslog.find(x => x.record_id === id);
                if (r) overlay.replace({ type: 'trainingslog', record: r });
              }}
              empty={{
                text: tx('Noch keine Sätze — leg jetzt los!'),
                action: { label: tx('Ersten Satz erfassen'), onClick: () => openQuickLog() },
              }}
            />
          </>
        }
      />

      {/* Quick exercises panel for 2-tap logging */}
      {uebungen.length > 0 && (
        <div className="space-y-3">
          <h2 className="font-semibold text-base">{tx('Schnell erfassen')}</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {uebungen.map(u => {
              const recentForU = enrichedTrainingslog
                .filter(r => extractRecordId(r.fields.uebung) === u.record_id)
                .sort((a, b) => (b.fields.datum ?? '').localeCompare(a.fields.datum ?? ''));
              const lastWeight = recentForU[0]?.fields.gewicht_kg;
              const muskelKey = u.fields.muskelgruppe?.key;
              const muskelColors: Record<string, string> = {
                brust: 'text-red-500',
                ruecken: 'text-blue-500',
                schultern: 'text-purple-500',
                arme: 'text-orange-500',
                beine: 'text-green-600',
                bauch: 'text-yellow-500',
                ganzkoerper: 'text-primary',
              };
              const colorClass = muskelKey ? (muskelColors[muskelKey] ?? 'text-muted-foreground') : 'text-muted-foreground';
              return (
                <button
                  key={u.record_id}
                  onClick={() => openQuickLog(u.record_id)}
                  className="flex flex-col items-start gap-1 rounded-xl border bg-card p-3 hover:bg-accent transition-colors text-left"
                >
                  <IconBarbell size={18} className={`shrink-0 ${colorClass}`} />
                  <span className="font-medium text-sm leading-tight line-clamp-2 min-w-0 w-full">
                    {u.fields.name}
                  </span>
                  {lastWeight != null && (
                    <span className="text-xs text-muted-foreground">{lastWeight} {tx('kg')}</span>
                  )}
                  {u.fields.muskelgruppe?.label && (
                    <span className="text-xs text-muted-foreground truncate w-full">
                      {u.fields.muskelgruppe.label}
                    </span>
                  )}
                </button>
              );
            })}
            <button
              onClick={() => { setEditingUebung(null); setUebungDialogOpen(true); }}
              className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-card/50 p-3 hover:bg-accent transition-colors text-muted-foreground"
            >
              <IconPlus size={18} />
              <span className="text-xs font-medium">{tx('Neue Übung')}</span>
            </button>
          </div>
        </div>
      )}

      {/* Trainingslog create/edit dialog */}
      <TrainingslogDialog
        open={logDialogOpen}
        onClose={() => { setLogDialogOpen(false); setEditingLog(null); setLogDefaults(undefined); }}
        onSubmit={async (fields) => {
          if (editingLog) {
            await LivingAppsService.updateTrainingslogEntry(editingLog.record_id, fields);
            undoToast(
              tx`Satz aktualisiert`,
              async () => {
                await LivingAppsService.updateTrainingslogEntry(editingLog.record_id, editingLog.fields);
                fetchAll();
              }
            );
          } else {
            await LivingAppsService.createTrainingslogEntry(fields);
            undoToast(tx`Satz erfasst`);
          }
          fetchAll();
        }}
        defaultValues={logDefaults}
        recordId={editingLog?.record_id}
        uebungenList={uebungen}
        enablePhotoScan={AI_PHOTO_SCAN['Trainingslog']}
        enablePhotoLocation={AI_PHOTO_LOCATION['Trainingslog']}
      />

      {/* Übungen create/edit dialog */}
      <UebungenDialog
        open={uebungDialogOpen}
        onClose={() => { setUebungDialogOpen(false); setEditingUebung(null); }}
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
        enablePhotoLocation={AI_PHOTO_LOCATION['Uebungen']}
      />

      {/* Record overlay stack */}
      <RecordOverlayHost
        overlay={overlay}
        render={top => {
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
                  subtitle={top.record.fields.datum ? top.record.fields.datum.replace('T', ' ').slice(0, 16) : undefined}
                />
                <TrainingslogDetails
                  record={top.record}
                  uebungenList={uebungen}
                  onOpenUebungen={u => overlay.push({ type: 'uebungen', record: u })}
                />
              </>
            );
          }
          return null;
        }}
        onEdit={top => {
          overlay.close();
          if (top.type === 'trainingslog') openEditLog(top.record);
          if (top.type === 'uebungen') { setEditingUebung(top.record); setUebungDialogOpen(true); }
        }}
      />
    </div>
  );
}

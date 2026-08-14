import { useDashboardData } from '@/hooks/useDashboardData';
import { enrichTrainingslog } from '@/lib/enrich';
import type { EnrichedTrainingslog } from '@/types/enriched';
import type { Uebungen, Trainingslog } from '@/types/app';
import { APP_IDS, LOOKUP_OPTIONS } from '@/types/app';
import { LivingAppsService, extractRecordId, createRecordUrl } from '@/services/livingAppsService';
import { formatDate } from '@/lib/formatters';
import { DashboardSkeleton, DashboardError } from '@/components/DashboardStates';
import { useState, useMemo, useCallback } from 'react';
import { format, parseISO, startOfMonth, endOfMonth, eachDayOfInterval, subMonths, differenceInCalendarDays } from 'date-fns';
import { useClock, gruss, undoToast } from '@/lib/polish';
import { tx, appLabel, fieldLabel } from '@/i18n';
import { DashboardGrid } from '@/components/DashboardGrid';
import { StatCardRow, StatCard } from '@/components/StatCard';
import { WorkList } from '@/components/WorkList';
import { useRecordOverlayStack, RecordOverlayHost, RecordHeader, RecordSection, RecordField, RecordAttachments } from '@/components/widgets/RecordView';
import { TrainingslogDetails } from '@/components/details/TrainingslogDetails';
import { UebungenDetails } from '@/components/details/UebungenDetails';
import { TrainingslogDialog } from '@/components/dialogs/TrainingslogDialog';
import type { TrainingslogDialogDefaults } from '@/components/dialogs/TrainingslogDialog';
import { UebungenDialog } from '@/components/dialogs/UebungenDialog';
import { AI_PHOTO_SCAN, AI_PHOTO_LOCATION } from '@/config/ai-features';
import {
  IconBarbell,
  IconFlame,
  IconTrendingUp,
  IconPlus,
  IconChevronLeft,
  IconChevronRight,
} from '@tabler/icons-react';

export type OverlayItem =
  | { type: 'uebungen'; record: Uebungen }
  | { type: 'trainingslog'; record: EnrichedTrainingslog };

// ── Trainings-Heatmap (inline custom component) ────────────────────────────
interface HeatmapProps {
  trainingslog: Trainingslog[];
  clock: Date;
}

function TrainingHeatmap({ trainingslog, clock }: HeatmapProps) {
  const [offset, setOffset] = useState(0); // months back from current
  const targetMonth = subMonths(clock, offset);
  const monthStart = startOfMonth(targetMonth);
  const monthEnd = endOfMonth(targetMonth);
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });

  // Count sets per day
  const countByDay = useMemo(() => {
    const m = new Map<string, number>();
    trainingslog.forEach(r => {
      if (!r.fields.datum) return;
      const key = r.fields.datum.slice(0, 10);
      m.set(key, (m.get(key) ?? 0) + 1);
    });
    return m;
  }, [trainingslog]);

  const maxCount = Math.max(...Array.from(countByDay.values()), 1);

  function toneClass(count: number): string {
    if (count === 0) return 'bg-muted/40';
    const ratio = count / maxCount;
    if (ratio > 0.75) return 'bg-primary';
    if (ratio > 0.4) return 'bg-primary/60';
    return 'bg-primary/30';
  }

  // Weekday offset for first day (Mon=0)
  const firstDow = (monthStart.getDay() + 6) % 7;
  const blanks = Array(firstDow).fill(null);
  const allCells = [...blanks, ...days];

  const monthLabel = format(targetMonth, 'MMMM yyyy');
  const totalSets = days.reduce((s, d) => s + (countByDay.get(format(d, 'yyyy-MM-dd')) ?? 0), 0);
  const trainedDays = days.filter(d => (countByDay.get(format(d, 'yyyy-MM-dd')) ?? 0) > 0).length;

  return (
    <div className="rounded-2xl bg-card border border-border px-4 py-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{tx('Trainingsaktivität')}</h3>
          <p className="text-xs text-muted-foreground">
            {trainedDays} {tx('Tage')} · {totalSets} {tx('Sätze')}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setOffset(o => o + 1)}
            className="p-1.5 rounded-lg hover:bg-muted transition-colors"
            aria-label={tx('Vorheriger Monat')}
          >
            <IconChevronLeft size={16} className="text-muted-foreground shrink-0" />
          </button>
          <span className="text-xs font-medium text-muted-foreground min-w-[90px] text-center">{monthLabel}</span>
          <button
            onClick={() => setOffset(o => Math.max(0, o - 1))}
            disabled={offset === 0}
            className="p-1.5 rounded-lg hover:bg-muted transition-colors disabled:opacity-40"
            aria-label={tx('Nächster Monat')}
          >
            <IconChevronRight size={16} className="text-muted-foreground shrink-0" />
          </button>
        </div>
      </div>
      {/* Weekday labels */}
      <div className="grid grid-cols-7 gap-1 text-center">
        {[tx('Mo'), tx('Di'), tx('Mi'), tx('Do'), tx('Fr'), tx('Sa'), tx('So')].map((d, i) => (
          <div key={i} className="text-[10px] text-muted-foreground font-medium">{d}</div>
        ))}
      </div>
      {/* Day cells */}
      <div className="grid grid-cols-7 gap-1">
        {allCells.map((d, i) => {
          if (!d) return <div key={`blank-${i}`} />;
          const key = format(d as Date, 'yyyy-MM-dd');
          const count = countByDay.get(key) ?? 0;
          const isToday = differenceInCalendarDays(d as Date, clock) === 0;
          return (
            <div
              key={key}
              title={count > 0 ? tx`${format(d as Date, 'd. MMM')}: ${count} Sätze` : format(d as Date, 'd. MMM')}
              className={`aspect-square rounded-md ${toneClass(count)} ${isToday ? 'ring-2 ring-primary ring-offset-1' : ''} transition-colors`}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-2 justify-end">
        <span className="text-[10px] text-muted-foreground">{tx('Weniger')}</span>
        {[0, 0.2, 0.5, 0.8, 1].map((r, i) => (
          <div key={i} className={`w-3 h-3 rounded-sm ${r === 0 ? 'bg-muted/40' : r <= 0.2 ? 'bg-primary/30' : r <= 0.5 ? 'bg-primary/60' : r <= 0.8 ? 'bg-primary/80' : 'bg-primary'}`} />
        ))}
        <span className="text-[10px] text-muted-foreground">{tx('Mehr')}</span>
      </div>
    </div>
  );
}

// ── Stärkefortschritt (% max-Gewicht gewachsen) ─────────────────────────────
function computeStrengthGain(trainingslog: Trainingslog[], uebungenMap: Map<string, Uebungen>): {
  uebungName: string;
  gainPct: number;
  currentMax: number;
  startMax: number;
}[] {
  // Group by exercise
  const byExercise = new Map<string, Trainingslog[]>();
  trainingslog.forEach(r => {
    const id = extractRecordId(r.fields.uebung);
    if (!id) return;
    if (!byExercise.has(id)) byExercise.set(id, []);
    byExercise.get(id)!.push(r);
  });

  const results: { uebungName: string; gainPct: number; currentMax: number; startMax: number }[] = [];

  byExercise.forEach((logs, id) => {
    const uebung = uebungenMap.get(id);
    if (!uebung) return;
    const sorted = [...logs].filter(r => r.fields.datum && r.fields.gewicht_kg != null)
      .sort((a, b) => (a.fields.datum ?? '').localeCompare(b.fields.datum ?? ''));
    if (sorted.length < 2) return;

    // First 20% of sessions vs. last 20%
    const n = sorted.length;
    const slice = Math.max(1, Math.floor(n * 0.2));
    const startLogs = sorted.slice(0, slice);
    const currentLogs = sorted.slice(-slice);
    const startMax = Math.max(...startLogs.map(r => r.fields.gewicht_kg ?? 0));
    const currentMax = Math.max(...currentLogs.map(r => r.fields.gewicht_kg ?? 0));

    if (startMax <= 0) return;
    const gainPct = Math.round(((currentMax - startMax) / startMax) * 100);
    results.push({ uebungName: uebung.fields.name ?? '?', gainPct, currentMax, startMax });
  });

  return results.sort((a, b) => b.gainPct - a.gainPct);
}

export default function DashboardOverview() {
  const {
    uebungen, trainingslog,
    uebungenMap,
    loading, error, fetchAll,
  } = useDashboardData();

  const clock = useClock();
  const enrichedTrainingslog = enrichTrainingslog(trainingslog, { uebungenMap });

  // ── Dialog state ──────────────────────────────────────────────────────────
  const [logDialogOpen, setLogDialogOpen] = useState(false);
  const [logDefaults, setLogDefaults] = useState<TrainingslogDialogDefaults | undefined>(undefined);
  const [editLog, setEditLog] = useState<EnrichedTrainingslog | null>(null);
  const [uebungDialogOpen, setUebungDialogOpen] = useState(false);
  const [editUebung, setEditUebung] = useState<Uebungen | null>(null);
  const [addLogForUebung, setAddLogForUebung] = useState<string | undefined>(undefined);

  // ── Overlay stack ─────────────────────────────────────────────────────────
  const overlay = useRecordOverlayStack<OverlayItem>();

  // ── Quick-Log: open dialog with now prefilled ────────────────────────────
  const openQuickLog = useCallback((uebungId?: string) => {
    const now = format(clock, "yyyy-MM-dd'T'HH:mm");
    setLogDefaults({
      datum: now,
      ...(uebungId ? { uebung: uebungId } : {}),
    });
    setEditLog(null);
    setLogDialogOpen(true);
  }, [clock]);

  // ── Derived data ──────────────────────────────────────────────────────────
  const today = format(clock, 'yyyy-MM-dd');
  const todayLogs = useMemo(
    () => enrichedTrainingslog.filter(r => r.fields.datum?.startsWith(today)),
    [enrichedTrainingslog, today]
  );
  const totalSetsToday = todayLogs.length;

  // Most used exercises recently (last 30 days)
  const recentCutoff = format(subMonths(clock, 1), 'yyyy-MM-dd');
  const recentLogs = useMemo(
    () => trainingslog.filter(r => (r.fields.datum ?? '') >= recentCutoff),
    [trainingslog, recentCutoff]
  );

  // Last 7-day training days
  const last7Days = useMemo(() => {
    const set = new Set<string>();
    trainingslog.forEach(r => {
      if (!r.fields.datum) return;
      const key = r.fields.datum.slice(0, 10);
      const daysAgo = differenceInCalendarDays(clock, parseISO(key));
      if (daysAgo >= 0 && daysAgo < 7) set.add(key);
    });
    return set.size;
  }, [trainingslog, clock]);

  // Strength gain data
  const strengthGains = useMemo(
    () => computeStrengthGain(trainingslog, uebungenMap),
    [trainingslog, uebungenMap]
  );
  const bestGain = strengthGains[0];

  // Top exercises for quick log buttons
  const topUebungen = useMemo(() => {
    const countMap = new Map<string, number>();
    recentLogs.forEach(r => {
      const id = extractRecordId(r.fields.uebung);
      if (id) countMap.set(id, (countMap.get(id) ?? 0) + 1);
    });
    return uebungen
      .filter(u => countMap.has(u.record_id))
      .sort((a, b) => (countMap.get(b.record_id) ?? 0) - (countMap.get(a.record_id) ?? 0))
      .slice(0, 6);
  }, [uebungen, recentLogs]);

  // ── All hooks above early returns ─────────────────────────────────────────
  if (loading) return <DashboardSkeleton />;
  if (error) return <DashboardError error={error} onRetry={fetchAll} />;

  // Context line
  const contextLine = todayLogs.length > 0
    ? tx`${totalSetsToday} Sätze heute — weiter so!`
    : last7Days > 0
      ? tx`${last7Days} Trainingstage diese Woche — gut dabei!`
      : tx('Noch kein Training heute — starte jetzt!');

  // ── Handlers ──────────────────────────────────────────────────────────────
  async function handleLogSubmit(fields: Trainingslog['fields']) {
    if (editLog) {
      await LivingAppsService.updateTrainingslogEntry(editLog.record_id, fields);
      undoToast(tx`Satz aktualisiert`, async () => {
        await LivingAppsService.updateTrainingslogEntry(editLog.record_id, editLog.fields);
        fetchAll();
      });
    } else {
      await LivingAppsService.createTrainingslogEntry(fields);
      undoToast(tx`Satz erfasst`);
    }
    fetchAll();
  }

  async function handleUebungSubmit(fields: Uebungen['fields']) {
    if (editUebung) {
      await LivingAppsService.updateUebungenEntry(editUebung.record_id, fields);
      undoToast(tx`Übung aktualisiert`, async () => {
        await LivingAppsService.updateUebungenEntry(editUebung.record_id, editUebung.fields);
        fetchAll();
      });
    } else {
      await LivingAppsService.createUebungenEntry(fields);
      undoToast(tx`Übung angelegt`);
    }
    fetchAll();
  }

  // ── Quick-Log Panel (mobile-first 2-click logging) ────────────────────────
  const quickLogPanel = (
    <div className="rounded-2xl bg-card border border-border px-4 py-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <IconBarbell size={16} className="text-primary shrink-0" />
          {tx('Schnell-Eintrag')}
        </h3>
        <button
          onClick={() => openQuickLog()}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-xl text-xs font-semibold hover:bg-primary/90 transition-colors"
        >
          <IconPlus size={14} className="shrink-0" />
          {tx('Neuer Satz')}
        </button>
      </div>

      {/* 2-click buttons for most-used exercises */}
      {topUebungen.length > 0 ? (
        <div className="grid grid-cols-2 gap-2">
          {topUebungen.map(u => (
            <button
              key={u.record_id}
              onClick={() => openQuickLog(u.record_id)}
              className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-muted/60 hover:bg-muted text-left transition-colors"
            >
              <IconBarbell size={14} className="text-primary shrink-0" />
              <span className="text-xs font-medium text-foreground truncate">{u.fields.name}</span>
            </button>
          ))}
        </div>
      ) : uebungen.length === 0 ? (
        <div className="text-center py-4">
          <p className="text-xs text-muted-foreground">{tx('Lege zuerst Übungen an')}</p>
          <button
            onClick={() => { setEditUebung(null); setUebungDialogOpen(true); }}
            className="mt-2 px-3 py-1.5 bg-primary text-primary-foreground rounded-xl text-xs font-semibold hover:bg-primary/90 transition-colors"
          >
            {tx('Erste Übung anlegen')}
          </button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{tx('Trainiere eine Übung, damit sie hier erscheint')}</p>
      )}
    </div>
  );

  // ── Strength Gain Panel ───────────────────────────────────────────────────
  const strengthPanel = strengthGains.length > 0 ? (
    <div className="rounded-2xl bg-card border border-border px-4 py-4 space-y-3">
      <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
        <IconTrendingUp size={16} className="text-success shrink-0" />
        {tx('Kraftfortschritt')}
      </h3>
      <div className="space-y-2">
        {strengthGains.slice(0, 5).map(g => (
          <div key={g.uebungName} className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-foreground truncate">{g.uebungName}</p>
              <p className="text-[10px] text-muted-foreground">
                {g.startMax} {tx('kg →')} {g.currentMax} {tx('kg')}
              </p>
            </div>
            <span className={`text-xs font-bold shrink-0 ${g.gainPct > 0 ? 'text-success' : g.gainPct < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
              {g.gainPct > 0 ? '+' : ''}{g.gainPct}%
            </span>
          </div>
        ))}
      </div>
    </div>
  ) : null;

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const kpis = (
    <StatCardRow>
      <StatCard
        title={tx('Sätze heute')}
        value={totalSetsToday}
        description={totalSetsToday > 0 ? tx('Super — weiter so!') : tx('Noch nichts erfasst')}
        icon={<IconBarbell size={18} className="text-muted-foreground" />}
        tone={totalSetsToday > 0 ? 'success' : 'default'}
        onClick={() => openQuickLog()}
      />
      <StatCard
        title={tx('Trainingstage (7 Tage)')}
        value={last7Days}
        description={last7Days >= 3 ? tx('Tolle Konsistenz!') : tx('Ziel: 3× pro Woche')}
        icon={<IconFlame size={18} className="text-muted-foreground" />}
        tone={last7Days >= 3 ? 'success' : last7Days >= 1 ? 'warning' : 'default'}
      />
      {bestGain && (
        <StatCard
          title={tx('Bester Fortschritt')}
          value={`+${bestGain.gainPct}%`}
          description={bestGain.uebungName}
          icon={<IconTrendingUp size={18} className="text-muted-foreground" />}
          tone={bestGain.gainPct > 0 ? 'primary' : 'default'}
        />
      )}
    </StatCardRow>
  );

  // ── Today's work list ─────────────────────────────────────────────────────
  const workList = (
    <WorkList
      title={tx('Heutige Sätze')}
      items={todayLogs.slice().reverse().map(r => ({
        id: r.record_id,
        title: r.uebungName || tx('Unbekannte Übung'),
        secondLine: (
          <span className="text-muted-foreground text-xs">
            {r.fields.gewicht_kg != null ? `${r.fields.gewicht_kg} kg` : '—'}
            {' · '}
            {r.fields.wiederholungen != null ? tx`${r.fields.wiederholungen} Wdh.` : '—'}
            {r.fields.satz_nummer != null ? tx` · Satz ${r.fields.satz_nummer}` : ''}
          </span>
        ),
        action: {
          label: tx('Bearbeiten'),
          onClick: () => {
            setEditLog(r);
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
        const rec = enrichedTrainingslog.find(r => r.record_id === id);
        if (rec) overlay.replace({ type: 'trainingslog', record: rec });
      }}
      empty={{
        text: tx('Noch keine Sätze heute — auf geht\'s!'),
        action: { label: tx('Satz erfassen'), onClick: () => openQuickLog() },
      }}
    />
  );

  // ── Primary = Quick-Log + Heatmap ─────────────────────────────────────────
  const primary = (
    <div className="space-y-4">
      {quickLogPanel}
      <TrainingHeatmap trainingslog={trainingslog} clock={clock} />
      {strengthPanel}
    </div>
  );

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">{gruss(clock)}</h1>
        <p className="text-muted-foreground mt-1">{contextLine}</p>
        <button
          onClick={() => openQuickLog()}
          className="mt-3 flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-xl font-semibold text-sm hover:bg-primary/90 transition-colors"
        >
          <IconPlus size={16} className="shrink-0" />
          {tx('Satz erfassen')}
        </button>
      </div>

      <DashboardGrid
        variant="split"
        kpis={kpis}
        aside={workList}
        primary={primary}
      />

      {/* ── Overlay stack ─────────────────────────────────────────────────── */}
      <RecordOverlayHost
        overlay={overlay}
        render={top => {
          if (top.type === 'trainingslog') {
            return (
              <>
                <RecordHeader
                  title={top.record.uebungName || tx('Trainingslog')}
                  subtitle={top.record.fields.datum ? formatDate(top.record.fields.datum) : undefined}
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
                  onAddTrainingslog={() => {
                    setAddLogForUebung(top.record.record_id);
                    setLogDefaults({
                      datum: format(clock, "yyyy-MM-dd'T'HH:mm"),
                      uebung: top.record.record_id,
                    });
                    setEditLog(null);
                    setLogDialogOpen(true);
                  }}
                />
              </>
            );
          }
          return null;
        }}
        onEdit={top => {
          if (top.type === 'trainingslog') {
            setEditLog(top.record);
            setLogDefaults({
              datum: top.record.fields.datum,
              uebung: extractRecordId(top.record.fields.uebung) ?? undefined,
              satz_nummer: top.record.fields.satz_nummer,
              gewicht_kg: top.record.fields.gewicht_kg,
              wiederholungen: top.record.fields.wiederholungen,
              notiz: top.record.fields.notiz,
            });
            setLogDialogOpen(true);
          }
          if (top.type === 'uebungen') {
            setEditUebung(top.record);
            setUebungDialogOpen(true);
          }
        }}
      />

      {/* ── Dialogs ──────────────────────────────────────────────────────── */}
      <TrainingslogDialog
        open={logDialogOpen}
        onClose={() => { setLogDialogOpen(false); setEditLog(null); setAddLogForUebung(undefined); }}
        onSubmit={handleLogSubmit}
        defaultValues={logDefaults}
        recordId={editLog?.record_id}
        uebungenList={uebungen}
        enablePhotoScan={AI_PHOTO_SCAN['Trainingslog']}
        enablePhotoLocation={AI_PHOTO_LOCATION['Trainingslog']}
      />

      <UebungenDialog
        open={uebungDialogOpen}
        onClose={() => { setUebungDialogOpen(false); setEditUebung(null); }}
        onSubmit={handleUebungSubmit}
        defaultValues={editUebung?.fields}
        recordId={editUebung?.record_id}
        enablePhotoScan={AI_PHOTO_SCAN['Uebungen']}
        enablePhotoLocation={AI_PHOTO_LOCATION['Uebungen']}
      />
    </>
  );
}

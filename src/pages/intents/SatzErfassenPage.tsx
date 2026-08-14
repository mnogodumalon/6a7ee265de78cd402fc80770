/**
 * Satz erfassen — 2-Schritt-Wizard für schnelle Trainingslog-Einträge.
 * Steps: 1) Übung wählen (alle Übungen, gruppiert nach Muskelgruppe) →
 *         2) Gewicht & Wiederholungen eingeben → Trainingslog-Eintrag anlegen.
 * Reads: uebungen, trainingslog. Writes: trainingslog (createTrainingslogEntry).
 * Composes: IntentWizardShell, EntitySelectStep.
 */
import { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { IconPlus, IconMinus, IconBarbell, IconCheck, IconRefresh } from '@tabler/icons-react';
import { tx } from '@/i18n';
import { useDashboardData } from '@/hooks/useDashboardData';
import type { Uebungen } from '@/types/app';
import { APP_IDS, LOOKUP_OPTIONS } from '@/types/app';
import { LivingAppsService, createRecordUrl, extractRecordId } from '@/services/livingAppsService';
import { lookupKey } from '@/lib/formatters';
import { IntentWizardShell } from '@/components/blocks/IntentWizardShell';
import { EntitySelectStep } from '@/components/blocks/EntitySelectStep';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

export default function SatzErfassenPage() {
  const { uebungen, trainingslog, loading, error, fetchAll } = useDashboardData();

  const [step, setStep] = useState(1);
  const [selectedUebung, setSelectedUebung] = useState<Uebungen | null>(null);
  const [gewichtKg, setGewichtKg] = useState<number>(0);
  const [wiederholungen, setWiederholungen] = useState<number>(10);
  const [notiz, setNotiz] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);

  // Muskelgruppe-Optionen für Gruppierung
  const muskelgruppenOptions = useMemo(
    () => LOOKUP_OPTIONS['uebungen']?.['muskelgruppe'] ?? [],
    []
  );

  // Heutige Logs für die gewählte Übung
  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const heutigeLogsFuerUebung = useMemo(() => {
    if (!selectedUebung) return [];
    return trainingslog.filter(log => {
      const logDatum = log.fields.datum ? log.fields.datum.slice(0, 10) : '';
      const logUebungId = extractRecordId(log.fields.uebung ?? '');
      return logDatum === todayStr && logUebungId === selectedUebung.record_id;
    });
  }, [trainingslog, selectedUebung, todayStr]);

  const naechsterSatz = heutigeLogsFuerUebung.length + 1;

  // Letztes Log für Prefill
  const letztesLog = useMemo(() => {
    if (!selectedUebung) return null;
    const logs = trainingslog
      .filter(log => extractRecordId(log.fields.uebung ?? '') === selectedUebung.record_id)
      .sort((a, b) => (b.fields.datum ?? '').localeCompare(a.fields.datum ?? ''));
    return logs[0] ?? null;
  }, [trainingslog, selectedUebung]);

  // Wenn Übung gewählt wird: Prefill aus letztem Log
  const handleSelectUebung = (id: string) => {
    const uebung = uebungen.find(u => u.record_id === id) ?? null;
    setSelectedUebung(uebung);
    setCreatedId(null);

    // Prefill aus letztem Log
    const logs = trainingslog
      .filter(log => extractRecordId(log.fields.uebung ?? '') === id)
      .sort((a, b) => (b.fields.datum ?? '').localeCompare(a.fields.datum ?? ''));
    const letztes = logs[0] ?? null;
    if (letztes) {
      setGewichtKg(letztes.fields.gewicht_kg ?? 0);
      setWiederholungen(letztes.fields.wiederholungen ?? 10);
    } else {
      setGewichtKg(0);
      setWiederholungen(10);
    }
    setNotiz('');
    setSaveError(null);
    setDone(false);
    setStep(2);
  };

  const handleSpeichern = async () => {
    if (!selectedUebung) return;
    if (createdId) return; // Idempotenz-Guard

    setSaving(true);
    setSaveError(null);
    try {
      const datum = format(new Date(), "yyyy-MM-dd'T'HH:mm");
      const result = await LivingAppsService.createTrainingslogEntry({
        datum,
        uebung: createRecordUrl(APP_IDS.UEBUNGEN, selectedUebung.record_id),
        satz_nummer: naechsterSatz,
        gewicht_kg: gewichtKg,
        wiederholungen,
        notiz: notiz || undefined,
      });
      setCreatedId(result.record_id);
      await fetchAll();
      setDone(true);
    } catch {
      setSaveError(tx('Fehler beim Speichern. Bitte erneut versuchen.'));
    } finally {
      setSaving(false);
    }
  };

  const handleNochEinenSatz = () => {
    // Übung vorausgewählt lassen, zurück zu Schritt 1
    setCreatedId(null);
    setDone(false);
    setSaveError(null);
    setNotiz('');
    // Prefill aus gerade gespeichertem Satz
    setStep(1);
  };

  const handleNeustart = () => {
    setSelectedUebung(null);
    setCreatedId(null);
    setDone(false);
    setSaveError(null);
    setGewichtKg(0);
    setWiederholungen(10);
    setNotiz('');
    setStep(1);
  };

  // Items für EntitySelectStep (Schritt 1)
  const items = useMemo(() => {
    return uebungen.map(u => {
      const mgKey = lookupKey(u.fields.muskelgruppe);
      const mgOpt = muskelgruppenOptions.find(o => o.key === mgKey);
      return {
        id: u.record_id,
        title: u.fields.name ?? '',
        subtitle: mgOpt?.label ?? mgKey ?? '',
        icon: <IconBarbell size={20} className="text-primary" />,
      };
    });
  }, [uebungen, muskelgruppenOptions]);

  // Stepper-Hilfe
  const stepperButton = (
    label: string,
    onClick: () => void,
    icon: React.ReactNode
  ) => (
    <button
      type="button"
      onClick={onClick}
      className="w-12 h-12 flex items-center justify-center rounded-xl bg-secondary text-foreground active:scale-95 transition-transform touch-manipulation"
      aria-label={label}
    >
      {icon}
    </button>
  );

  return (
    <IntentWizardShell
      title={tx('Satz erfassen')}
      subtitle={tx('Trainingslog — schnell und mobiloptimiert')}
      steps={[{ label: tx('Übung') }, { label: tx('Details') }]}
      currentStep={step}
      onStepChange={setStep}
      loading={loading}
      error={error}
      onRetry={fetchAll}
    >
      {/* ─── Schritt 1: Übung wählen ─────────────────────────────── */}
      {step === 1 && (
        <EntitySelectStep
          items={items}
          onSelect={handleSelectUebung}
          searchPlaceholder={tx('Übung suchen …')}
          emptyText={tx('Keine Übung gefunden')}
          emptyIcon={<IconBarbell size={32} className="text-muted-foreground" />}
        />
      )}

      {/* ─── Schritt 2: Satz-Details eingeben ───────────────────── */}
      {step === 2 && (
        selectedUebung ? (
          done ? (
            /* Erfolgs-Screen */
            <div className="flex flex-col items-center gap-6 py-10 px-4 text-center">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <IconCheck size={36} className="text-primary" />
              </div>
              <div className="space-y-1">
                <p className="text-lg font-semibold text-foreground">
                  {tx('Satz gespeichert!')}
                </p>
                <p className="text-sm text-muted-foreground">
                  {selectedUebung.fields.name} — {gewichtKg} {tx('kg ×')} {wiederholungen} {tx('Wdh.')}
                </p>
              </div>
              <div className="flex flex-col gap-3 w-full max-w-xs">
                <Button
                  size="lg"
                  onClick={handleNochEinenSatz}
                  className="w-full gap-2"
                >
                  <IconRefresh size={18} />
                  {tx('Noch einen Satz')}
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  asChild
                  className="w-full"
                >
                  <a href="#/">{tx('Fertig')}</a>
                </Button>
              </div>
            </div>
          ) : (
            /* Eingabe-Formular */
            <div className="space-y-6 px-1">
              {/* Übungs-Zusammenfassung */}
              <div className="rounded-2xl border bg-card p-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <IconBarbell size={20} className="text-primary" />
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-foreground truncate">
                    {selectedUebung.fields.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {selectedUebung.fields.muskelgruppe?.label}
                  </p>
                </div>
                <div className="ml-auto shrink-0">
                  <Badge variant="secondary">
                    {heutigeLogsFuerUebung.length > 0
                      ? `${heutigeLogsFuerUebung.length} ${tx('Satz heute')}`
                      : tx('Erster Satz heute')}
                  </Badge>
                </div>
              </div>

              {/* Satz-Nummer Info */}
              <div className="text-sm text-muted-foreground text-center">
                {tx('Satz')} <span className="font-bold text-foreground">{naechsterSatz}</span>
              </div>

              {/* Gewicht Stepper */}
              <div className="rounded-2xl border bg-card p-5 space-y-3">
                <label className="text-sm font-medium text-muted-foreground block">
                  {tx('Gewicht (kg)')}
                </label>
                <div className="flex items-center gap-3">
                  {stepperButton(
                    tx('Gewicht verringern'),
                    () => setGewichtKg(prev => Math.max(0, parseFloat((prev - 2.5).toFixed(2)))),
                    <IconMinus size={20} />
                  )}
                  <Input
                    type="number"
                    min={0}
                    step={2.5}
                    value={gewichtKg}
                    onChange={e => setGewichtKg(parseFloat(e.target.value) || 0)}
                    className="text-center text-2xl font-bold h-12 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  {stepperButton(
                    tx('Gewicht erhöhen'),
                    () => setGewichtKg(prev => parseFloat((prev + 2.5).toFixed(2))),
                    <IconPlus size={20} />
                  )}
                </div>
                {letztesLog?.fields.gewicht_kg != null && (
                  <p className="text-xs text-muted-foreground text-center">
                    {tx('Letztes Mal')}: {letztesLog.fields.gewicht_kg} {tx('kg')}
                  </p>
                )}
              </div>

              {/* Wiederholungen Stepper */}
              <div className="rounded-2xl border bg-card p-5 space-y-3">
                <label className="text-sm font-medium text-muted-foreground block">
                  {tx('Wiederholungen')}
                </label>
                <div className="flex items-center gap-3">
                  {stepperButton(
                    tx('Wiederholungen verringern'),
                    () => setWiederholungen(prev => Math.max(1, prev - 1)),
                    <IconMinus size={20} />
                  )}
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={wiederholungen}
                    onChange={e => setWiederholungen(parseInt(e.target.value, 10) || 1)}
                    className="text-center text-2xl font-bold h-12 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  {stepperButton(
                    tx('Wiederholungen erhöhen'),
                    () => setWiederholungen(prev => prev + 1),
                    <IconPlus size={20} />
                  )}
                </div>
                {letztesLog?.fields.wiederholungen != null && (
                  <p className="text-xs text-muted-foreground text-center">
                    {tx('Letztes Mal')}: {letztesLog.fields.wiederholungen} {tx('Wdh.')}
                  </p>
                )}
              </div>

              {/* Notiz */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground block">
                  {tx('Notiz')} ({tx('optional')})
                </label>
                <Input
                  value={notiz}
                  onChange={e => setNotiz(e.target.value)}
                  placeholder={tx('z. B. gute Ausführung, Schmerzen …')}
                />
              </div>

              {/* Fehler */}
              {saveError && (
                <p className="text-sm text-destructive text-center">{saveError}</p>
              )}

              {/* Aktionen */}
              <div className="flex flex-col gap-3 pt-2">
                <Button
                  size="lg"
                  className="w-full"
                  disabled={saving || gewichtKg <= 0 || wiederholungen <= 0}
                  onClick={handleSpeichern}
                >
                  {saving ? tx('Wird gespeichert …') : tx('Satz speichern')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={() => setStep(1)}
                >
                  {tx('Andere Übung wählen')}
                </Button>
              </div>
            </div>
          )
        ) : (
          /* Fallback: kein selectedUebung (z. B. Deep-Link auf ?step=2) */
          <div className="text-center py-12 space-y-3">
            <p className="text-sm text-muted-foreground">
              {tx('Dieser Schritt braucht die Auswahl aus Schritt 1.')}
            </p>
            <Button variant="outline" onClick={() => setStep(1)}>
              {tx('Neu starten')}
            </Button>
          </div>
        )
      )}
    </IntentWizardShell>
  );
}

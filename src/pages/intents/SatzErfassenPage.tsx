/**
 * Satz erfassen — 2-Schritt-Wizard für mobile Trainingserfassung.
 * Steps: 1) Übung wählen → 2) Satz eingeben & speichern.
 * Reads: uebungen, trainingslog. Writes: trainingslog (createTrainingslogEntry).
 * Composes: IntentWizardShell, EntitySelectStep.
 */

import { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { IconMinus, IconPlus, IconCheck, IconBarbell } from '@tabler/icons-react';
import { IntentWizardShell } from '@/components/blocks/IntentWizardShell';
import { EntitySelectStep } from '@/components/blocks/EntitySelectStep';
import { useDashboardData } from '@/hooks/useDashboardData';
import type { Uebungen } from '@/types/app';
import { APP_IDS } from '@/types/app';
import { LivingAppsService, createRecordUrl } from '@/services/livingAppsService';
import { tx } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

// ── NumericStepper ──────────────────────────────────────────────────────────

interface NumericStepperProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}

function NumericStepper({ value, onChange, min = 0, max = 9999, step = 1, suffix }: NumericStepperProps) {
  const decrement = () => onChange(Math.max(min, value - step));
  const increment = () => onChange(Math.min(max, value + step));

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={decrement}
        disabled={value <= min}
        className="w-14 h-14 rounded-full bg-secondary text-foreground text-2xl font-bold flex items-center justify-center shrink-0 disabled:opacity-30"
        aria-label={tx('Verringern')}
      >
        <IconMinus size={22} stroke={2} />
      </button>
      <div className="flex-1 text-center">
        <span className="text-4xl font-bold tabular-nums">{value}</span>
        {suffix && (
          <span className="ml-1 text-lg text-muted-foreground">{suffix}</span>
        )}
      </div>
      <button
        type="button"
        onClick={increment}
        disabled={value >= max}
        className="w-14 h-14 rounded-full bg-primary text-primary-foreground text-2xl font-bold flex items-center justify-center shrink-0 disabled:opacity-30"
        aria-label={tx('Erhöhen')}
      >
        <IconPlus size={22} stroke={2} />
      </button>
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────

export default function SatzErfassenPage() {
  const { uebungen, trainingslog, loading, error, fetchAll } = useDashboardData();

  const [step, setStep] = useState(1);
  const [selectedUebung, setSelectedUebung] = useState<Uebungen | null>(null);
  const [gewichtKg, setGewichtKg] = useState(20);
  const [wiederholungen, setWiederholungen] = useState(10);
  const [notiz, setNotiz] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // Berechne satz_nummer: bisherige Sätze dieser Übung heute + 1
  const satzNummer = useMemo(() => {
    if (!selectedUebung) return 1;
    const heute = format(new Date(), 'yyyy-MM-dd');
    const heuteEintraege = trainingslog.filter(entry => {
      // datum field is datetimeminute, starts with YYYY-MM-DD
      return (
        entry.fields.datum?.startsWith(heute) &&
        entry.fields.uebung?.includes(selectedUebung.record_id)
      );
    });
    return heuteEintraege.length + 1;
  }, [selectedUebung, trainingslog]);

  const handleUebungSelect = (id: string) => {
    const uebung = uebungen.find(u => u.record_id === id) ?? null;
    setSelectedUebung(uebung);
    setStep(2);
  };

  const handleSubmit = async () => {
    if (!selectedUebung) return;
    setSubmitting(true);
    try {
      const datum = format(new Date(), "yyyy-MM-dd'T'HH:mm");
      await LivingAppsService.createTrainingslogEntry({
        datum,
        uebung: createRecordUrl(APP_IDS.UEBUNGEN, selectedUebung.record_id),
        satz_nummer: satzNummer,
        gewicht_kg: gewichtKg,
        wiederholungen,
        ...(notiz.trim() ? { notiz: notiz.trim() } : {}),
      });
      await fetchAll();
      setDone(true);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = () => {
    setStep(1);
    setSelectedUebung(null);
    setGewichtKg(20);
    setWiederholungen(10);
    setNotiz('');
    setDone(false);
  };

  return (
    <IntentWizardShell
      title={tx('Satz erfassen')}
      subtitle={tx('Übung wählen und Satz eintragen')}
      steps={[{ label: tx('Übung') }, { label: tx('Satz') }]}
      currentStep={step}
      onStepChange={setStep}
      loading={loading}
      error={error}
      onRetry={fetchAll}
    >
      {/* ── Schritt 1: Übung wählen ─────────────────────────────────────── */}
      {step === 1 && (
        <EntitySelectStep
          items={uebungen.map(u => ({
            id: u.record_id,
            title: u.fields.name ?? u.record_id,
            subtitle: u.fields.muskelgruppe?.label,
            icon: <IconBarbell size={20} className="text-primary" stroke={1.5} />,
          }))}
          onSelect={handleUebungSelect}
          searchPlaceholder={tx('Übung suchen …')}
          emptyText={tx('Keine Übungen gefunden')}
          emptyIcon={<IconBarbell size={32} className="text-muted-foreground" stroke={1.5} />}
        />
      )}

      {/* ── Schritt 2: Satz eingeben ─────────────────────────────────────── */}
      {step === 2 && (
        selectedUebung ? (
          done ? (
            /* Erfolg */
            <div className="flex flex-col items-center gap-6 py-12 text-center">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <IconCheck size={36} className="text-primary" stroke={2} />
              </div>
              <div className="space-y-1">
                <p className="text-lg font-semibold">{tx('Satz gespeichert!')}</p>
                <p className="text-sm text-muted-foreground">
                  {tx('Satz')} {satzNummer - 1} — {gewichtKg} {tx('kg ×')} {wiederholungen} {tx('Wdh')}
                </p>
              </div>
              <div className="flex flex-col gap-3 w-full max-w-xs">
                <Button onClick={handleReset} size="lg" className="w-full">
                  {tx('Nächsten Satz erfassen')}
                </Button>
                <a href="#/" className="text-sm text-muted-foreground text-center hover:underline">
                  {tx('Zurück zum Dashboard')}
                </a>
              </div>
            </div>
          ) : (
            /* Eingabeformular */
            <div className="space-y-8 max-w-sm mx-auto py-2">
              {/* Gewählte Übung */}
              <div className="rounded-2xl border bg-secondary/40 px-4 py-3 flex items-center gap-3">
                <IconBarbell size={20} className="text-primary shrink-0" stroke={1.5} />
                <div className="min-w-0">
                  <p className="font-semibold truncate">{selectedUebung.fields.name}</p>
                  {selectedUebung.fields.muskelgruppe && (
                    <p className="text-xs text-muted-foreground">{selectedUebung.fields.muskelgruppe.label}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="ml-auto text-xs text-muted-foreground hover:text-foreground shrink-0"
                >
                  {tx('Ändern')}
                </button>
              </div>

              {/* Satz-Nummer (Readonly) */}
              <div className="flex items-center justify-between rounded-xl bg-secondary/30 px-4 py-2">
                <span className="text-sm text-muted-foreground">{tx('Satz-Nr.')}</span>
                <span className="font-bold text-lg">{satzNummer}</span>
              </div>

              {/* Gewicht */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">{tx('Gewicht')}</label>
                <NumericStepper
                  value={gewichtKg}
                  onChange={setGewichtKg}
                  min={0}
                  max={500}
                  step={2.5}
                  suffix="kg"
                />
              </div>

              {/* Wiederholungen */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">{tx('Wiederholungen')}</label>
                <NumericStepper
                  value={wiederholungen}
                  onChange={setWiederholungen}
                  min={1}
                  max={200}
                  step={1}
                  suffix={tx('Wdh')}
                />
              </div>

              {/* Notiz (optional) */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">
                  {tx('Notiz')} <span className="font-normal text-xs">({tx('optional')})</span>
                </label>
                <Textarea
                  value={notiz}
                  onChange={e => setNotiz(e.target.value)}
                  placeholder={tx('z. B. Pause, Technik-Hinweis …')}
                  rows={2}
                  className="resize-none"
                />
              </div>

              {/* Speichern */}
              <Button
                size="lg"
                className="w-full"
                onClick={handleSubmit}
                disabled={submitting}
              >
                {submitting ? tx('Wird gespeichert …') : tx('Satz speichern')}
              </Button>
            </div>
          )
        ) : (
          /* Fallback wenn step=2 ohne Auswahl (Deep-Link) */
          <div className="text-center py-12 space-y-3">
            <p className="text-sm text-muted-foreground">
              {tx('Dieser Schritt braucht eine gewählte Übung aus Schritt 1.')}
            </p>
            <Button variant="outline" onClick={() => setStep(1)}>
              {tx('Übung wählen')}
            </Button>
          </div>
        )
      )}
    </IntentWizardShell>
  );
}

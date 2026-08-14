/**
 * Satz erfassen — 2-Schritt-Wizard (mobiloptimiert).
 * Steps: 1) Übung wählen → 2) Satz eintragen → Success-Screen.
 * Reads: uebungen, trainingslog (für auto-Satznummer). Writes: trainingslog (createTrainingslogEntry).
 * Composes: IntentWizardShell, EntitySelectStep.
 */
import { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { IconBarbell, IconCheck, IconRepeat, IconWeight } from '@tabler/icons-react';
import { IntentWizardShell } from '@/components/blocks/IntentWizardShell';
import { EntitySelectStep } from '@/components/blocks/EntitySelectStep';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useDashboardData } from '@/hooks/useDashboardData';
import { LivingAppsService, createRecordUrl } from '@/services/livingAppsService';
import { APP_IDS } from '@/types/app';
import type { Uebungen } from '@/types/app';
import { tx } from '@/i18n';

export default function SatzErfassenPage() {
  const data = useDashboardData();
  const { uebungen, trainingslog, loading, error, fetchAll } = data;

  const [step, setStep] = useState(1);
  const [selectedUebung, setSelectedUebung] = useState<Uebungen | null>(null);
  const [gewicht, setGewicht] = useState('');
  const [wiederholungen, setWiederholungen] = useState('');
  const [notiz, setNotiz] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successData, setSuccessData] = useState<{
    uebungName: string;
    gewicht: string;
    wiederholungen: string;
    satzNummer: number;
  } | null>(null);

  // Auto-Satznummer: Sätze heute für diese Übung + 1
  const autoSatzNummer = useMemo(() => {
    if (!selectedUebung) return 1;
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const heutigeSaetze = trainingslog.filter((log) => {
      const logDatum = log.fields.datum ?? '';
      const logDatumStr = logDatum.length >= 10 ? logDatum.slice(0, 10) : '';
      const uebungUrl = log.fields.uebung ?? '';
      return (
        logDatumStr === todayStr &&
        uebungUrl.includes(selectedUebung.record_id)
      );
    });
    return heutigeSaetze.length + 1;
  }, [trainingslog, selectedUebung]);

  const handleUebungSelect = (id: string) => {
    const uebung = uebungen.find((u) => u.record_id === id) ?? null;
    setSelectedUebung(uebung);
    setGewicht('');
    setWiederholungen('');
    setNotiz('');
    setSubmitError(null);
    setStep(2);
  };

  const handleSubmit = async () => {
    if (!selectedUebung) return;
    if (!gewicht || !wiederholungen) {
      setSubmitError(tx('Bitte Gewicht und Wiederholungen eingeben.'));
      return;
    }
    const gewichtNum = Number(gewicht.replace(',', '.'));
    const wdhNum = Number(wiederholungen);
    if (isNaN(gewichtNum) || isNaN(wdhNum) || gewichtNum <= 0 || wdhNum <= 0) {
      setSubmitError(tx('Bitte gültige Zahlen eingeben.'));
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      await LivingAppsService.createTrainingslogEntry({
        datum: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
        uebung: createRecordUrl(APP_IDS.UEBUNGEN, selectedUebung.record_id),
        satz_nummer: autoSatzNummer,
        gewicht_kg: gewichtNum,
        wiederholungen: wdhNum,
        notiz: notiz.trim() || undefined,
      });
      await fetchAll();
      setSuccessData({
        uebungName: selectedUebung.fields.name ?? selectedUebung.record_id,
        gewicht: gewicht.replace(',', '.'),
        wiederholungen: wiederholungen,
        satzNummer: autoSatzNummer,
      });
      setStep(3);
    } catch {
      setSubmitError(tx('Fehler beim Speichern. Bitte erneut versuchen.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleWeiteren = () => {
    setGewicht('');
    setWiederholungen('');
    setNotiz('');
    setSubmitError(null);
    setSuccessData(null);
    setStep(2);
  };

  const canSubmit = gewicht.trim() !== '' && wiederholungen.trim() !== '' && !submitting;

  return (
    <IntentWizardShell
      title={tx('Satz erfassen')}
      subtitle={tx('Schnell und einfach deinen aktuellen Trainingssatz eintragen.')}
      steps={[
        { label: tx('Übung') },
        { label: tx('Satz') },
        { label: tx('Fertig') },
      ]}
      currentStep={step}
      onStepChange={setStep}
      loading={loading}
      error={error}
      onRetry={fetchAll}
    >
      {/* Step 1: Übung wählen */}
      {step === 1 && (
        <EntitySelectStep
          items={uebungen.map((u) => ({
            id: u.record_id,
            title: u.fields.name ?? u.record_id,
            subtitle: u.fields.muskelgruppe?.label,
            icon: <IconBarbell size={20} className="text-primary" />,
          }))}
          onSelect={handleUebungSelect}
          searchPlaceholder={tx('Übung suchen …')}
          emptyText={tx('Keine Übung gefunden.')}
          createLabel={tx('Neue Übung anlegen')}
          onCreateNew={() => {
            window.location.hash = '/uebungen';
          }}
        />
      )}

      {/* Step 2: Satz eintragen */}
      {step === 2 && (
        selectedUebung ? (
          <div className="space-y-6 max-w-md mx-auto">
            {/* Übungsinfo */}
            <div className="rounded-2xl bg-secondary p-4 flex items-center gap-3">
              <IconBarbell size={28} className="text-primary shrink-0" />
              <div className="min-w-0">
                <div className="font-semibold text-base truncate">
                  {selectedUebung.fields.name}
                </div>
                {selectedUebung.fields.muskelgruppe && (
                  <div className="text-sm text-muted-foreground">
                    {selectedUebung.fields.muskelgruppe.label}
                  </div>
                )}
              </div>
              <div className="ml-auto shrink-0">
                <span className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
                  {tx`Satz ${autoSatzNummer}`}
                </span>
              </div>
            </div>

            {/* Gewicht */}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-foreground flex items-center gap-2">
                <IconWeight size={16} className="shrink-0 text-muted-foreground" />
                {tx('Gewicht (kg)')}
                <span className="text-destructive">*</span>
              </label>
              <Input
                type="number"
                inputMode="decimal"
                placeholder={tx('z. B. 80')}
                value={gewicht}
                onChange={(e) => setGewicht(e.target.value)}
                className="text-2xl h-14 text-center font-bold"
                min="0"
                step="0.5"
              />
            </div>

            {/* Wiederholungen */}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-foreground flex items-center gap-2">
                <IconRepeat size={16} className="shrink-0 text-muted-foreground" />
                {tx('Wiederholungen')}
                <span className="text-destructive">*</span>
              </label>
              <Input
                type="number"
                inputMode="numeric"
                placeholder={tx('z. B. 10')}
                value={wiederholungen}
                onChange={(e) => setWiederholungen(e.target.value)}
                className="text-2xl h-14 text-center font-bold"
                min="1"
                step="1"
              />
            </div>

            {/* Notiz (optional) */}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-foreground">
                {tx('Notiz')}
                <span className="ml-1 text-xs text-muted-foreground">({tx('optional')})</span>
              </label>
              <Textarea
                placeholder={tx('z. B. Technik war gut …')}
                value={notiz}
                onChange={(e) => setNotiz(e.target.value)}
                rows={2}
                className="resize-none"
              />
            </div>

            {/* Fehler */}
            {submitError && (
              <p className="text-sm text-destructive">{submitError}</p>
            )}

            {/* Aktionen */}
            <div className="flex flex-col gap-3 pt-2">
              <Button
                size="lg"
                className="w-full text-base h-14"
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {submitting ? tx('Wird gespeichert …') : tx('Satz speichern')}
              </Button>
              <Button
                variant="outline"
                size="lg"
                className="w-full"
                onClick={() => {
                  setSelectedUebung(null);
                  setStep(1);
                }}
              >
                {tx('Andere Übung wählen')}
              </Button>
            </div>
          </div>
        ) : (
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

      {/* Step 3: Erfolg */}
      {step === 3 && (
        successData ? (
          <div className="max-w-md mx-auto space-y-6">
            {/* Erfolgs-Card */}
            <div className="rounded-2xl border bg-card p-6 flex flex-col items-center text-center gap-3 shadow-lg">
              <div className="rounded-full bg-primary/10 p-4">
                <IconCheck size={40} className="text-primary" />
              </div>
              <h2 className="text-xl font-bold">{tx('Satz gespeichert!')}</h2>
              <p className="text-muted-foreground text-sm">
                {successData.uebungName}
              </p>
              <div className="grid grid-cols-3 gap-4 w-full mt-2">
                <div className="rounded-xl bg-secondary p-3 flex flex-col items-center">
                  <span className="text-2xl font-bold">{successData.gewicht}</span>
                  <span className="text-xs text-muted-foreground mt-1">{tx('kg')}</span>
                </div>
                <div className="rounded-xl bg-secondary p-3 flex flex-col items-center">
                  <span className="text-2xl font-bold">×</span>
                  <span className="text-xs text-muted-foreground mt-1">{tx('&nbsp;')}</span>
                </div>
                <div className="rounded-xl bg-secondary p-3 flex flex-col items-center">
                  <span className="text-2xl font-bold">{successData.wiederholungen}</span>
                  <span className="text-xs text-muted-foreground mt-1">{tx('Wdh.')}</span>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                {tx`Satz ${successData.satzNummer} dieser Übung heute`}
              </p>
            </div>

            {/* Aktionen */}
            <div className="flex flex-col gap-3">
              <Button
                size="lg"
                className="w-full text-base h-14"
                onClick={handleWeiteren}
              >
                {tx('Weiteren Satz eintragen')}
              </Button>
              <Button
                variant="outline"
                size="lg"
                className="w-full"
                onClick={() => {
                  window.location.hash = '/';
                }}
              >
                {tx('Fertig — zum Dashboard')}
              </Button>
            </div>
          </div>
        ) : (
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

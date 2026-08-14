/**
 * Satz loggen — 2-Schritt-Wizard.
 * Steps: 1) Übung wählen → 2) Satz erfassen & speichern.
 * Reads: uebungen, trainingslog. Writes: trainingslog (createTrainingslogEntry).
 * Composes: IntentWizardShell, EntitySelectStep.
 */

import { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { IconBarbell, IconCheck, IconPlus } from '@tabler/icons-react';
import { IntentWizardShell } from '@/components/blocks/IntentWizardShell';
import { EntitySelectStep } from '@/components/blocks/EntitySelectStep';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useDashboardData } from '@/hooks/useDashboardData';
import type { Uebungen } from '@/types/app';
import { APP_IDS } from '@/types/app';
import { LivingAppsService, createRecordUrl, extractRecordId } from '@/services/livingAppsService';
import { tx } from '@/i18n';

export default function SatzLoggenPage() {
  const { uebungen, trainingslog, loading, error, fetchAll } = useDashboardData();

  const [step, setStep] = useState(1);
  const [selectedUebung, setSelectedUebung] = useState<Uebungen | null>(null);

  // Schritt 2 – Formularfelder
  const [satzNummer, setSatzNummer] = useState('');
  const [gewichtKg, setGewichtKg] = useState('');
  const [wiederholungen, setWiederholungen] = useState('');
  const [datum, setDatum] = useState(format(new Date(), "yyyy-MM-dd'T'HH:mm"));
  const [notiz, setNotiz] = useState('');

  // Submission state
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [lastGewicht, setLastGewicht] = useState('');
  const [lastWiederholungen, setLastWiederholungen] = useState('');

  // Heutige Sätze für die gewählte Übung zählen, um satz_nummer vorzubefüllen
  const todayStr = format(new Date(), 'yyyy-MM-dd');

  const prefillForUebung = useMemo(() => {
    if (!selectedUebung) return { satzNummer: 1, gewicht: '', wiederholungen: '' };

    const uebungUrl = createRecordUrl(APP_IDS.UEBUNGEN, selectedUebung.record_id);

    // Alle Logs dieser Übung
    const logsForUebung = trainingslog.filter(
      (log) => log.fields.uebung === uebungUrl
    );

    // Heutige Logs zählen (datum beginnt mit todayStr)
    const todayLogs = logsForUebung.filter(
      (log) => log.fields.datum?.startsWith(todayStr)
    );
    const nextSatz = todayLogs.length + 1;

    // Letzter Wert nach Datum sortiert
    const sorted = [...logsForUebung].sort((a, b) => {
      const da = a.fields.datum ?? '';
      const db = b.fields.datum ?? '';
      return db.localeCompare(da);
    });
    const last = sorted[0];
    const lastGew = last?.fields.gewicht_kg != null ? String(last.fields.gewicht_kg) : '';
    const lastWdh = last?.fields.wiederholungen != null ? String(last.fields.wiederholungen) : '';

    return { satzNummer: nextSatz, gewicht: lastGew, wiederholungen: lastWdh };
  }, [selectedUebung, trainingslog, todayStr]);

  const handleUebungSelect = (id: string) => {
    const uebung = uebungen.find((u) => u.record_id === id) ?? null;
    setSelectedUebung(uebung);

    if (uebung) {
      const uebungUrl = createRecordUrl(APP_IDS.UEBUNGEN, uebung.record_id);
      const logsForUebung = trainingslog.filter((log) => log.fields.uebung === uebungUrl);
      const todayLogs = logsForUebung.filter((log) => log.fields.datum?.startsWith(todayStr));
      const nextSatz = todayLogs.length + 1;

      const sorted = [...logsForUebung].sort((a, b) => {
        const da = a.fields.datum ?? '';
        const db = b.fields.datum ?? '';
        return db.localeCompare(da);
      });
      const last = sorted[0];
      setSatzNummer(String(nextSatz));
      setGewichtKg(last?.fields.gewicht_kg != null ? String(last.fields.gewicht_kg) : '');
      setWiederholungen(last?.fields.wiederholungen != null ? String(last.fields.wiederholungen) : '');
      setDatum(format(new Date(), "yyyy-MM-dd'T'HH:mm"));
      setNotiz('');
      setSubmitError(null);
      setSuccess(false);
    }

    setStep(2);
  };

  const handleSubmit = async () => {
    if (!selectedUebung) return;
    if (!gewichtKg || !wiederholungen || !datum) return;

    setSubmitting(true);
    setSubmitError(null);

    try {
      await LivingAppsService.createTrainingslogEntry({
        datum,
        uebung: createRecordUrl(APP_IDS.UEBUNGEN, selectedUebung.record_id),
        satz_nummer: satzNummer ? Number(satzNummer) : undefined,
        gewicht_kg: Number(gewichtKg),
        wiederholungen: Number(wiederholungen),
        notiz: notiz || undefined,
      });
      await fetchAll();
      setLastGewicht(gewichtKg);
      setLastWiederholungen(wiederholungen);
      setSuccess(true);
    } catch (_err) {
      setSubmitError(tx('Fehler beim Speichern. Bitte erneut versuchen.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleWeiterenSatzLoggen = () => {
    if (!selectedUebung) return;

    // Neuen satz_nummer berechnen: aktuellen + 1
    const currentSatz = satzNummer ? Number(satzNummer) : 1;
    setSatzNummer(String(currentSatz + 1));
    setGewichtKg(lastGewicht);
    setWiederholungen(lastWiederholungen);
    setDatum(format(new Date(), "yyyy-MM-dd'T'HH:mm"));
    setNotiz('');
    setSubmitError(null);
    setSuccess(false);
  };

  const handleReset = () => {
    setStep(1);
    setSelectedUebung(null);
    setSatzNummer('');
    setGewichtKg('');
    setWiederholungen('');
    setDatum(format(new Date(), "yyyy-MM-dd'T'HH:mm"));
    setNotiz('');
    setSubmitError(null);
    setSuccess(false);
    setLastGewicht('');
    setLastWiederholungen('');
  };

  const canSubmit = !!gewichtKg && !!wiederholungen && !!datum;

  return (
    <IntentWizardShell
      title={tx('Satz loggen')}
      subtitle={tx('Trainingsfortschritt festhalten')}
      steps={[{ label: tx('Übung') }, { label: tx('Satz') }]}
      currentStep={step}
      onStepChange={setStep}
      loading={loading}
      error={error}
      onRetry={fetchAll}
    >
      {/* Schritt 1 – Übung wählen */}
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
          emptyText={tx('Keine Übungen gefunden')}
        />
      )}

      {/* Schritt 2 – Satz erfassen */}
      {step === 2 && (
        <div className="space-y-6">
          {/* Gewählte Übung anzeigen */}
          {selectedUebung ? (
            <>
              <div className="flex items-center gap-3 p-4 rounded-2xl bg-secondary">
                <IconBarbell size={24} className="text-primary shrink-0" />
                <div className="min-w-0">
                  <p className="font-semibold truncate">{selectedUebung.fields.name}</p>
                  {selectedUebung.fields.muskelgruppe && (
                    <p className="text-sm text-muted-foreground">
                      {selectedUebung.fields.muskelgruppe.label}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto shrink-0"
                  onClick={() => setStep(1)}
                >
                  {tx('Ändern')}
                </Button>
              </div>

              {success ? (
                /* Erfolgs-Screen */
                <div className="space-y-6 text-center py-6">
                  <div className="flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mx-auto">
                    <IconCheck size={32} className="text-primary" />
                  </div>
                  <div className="space-y-1">
                    <p className="font-semibold text-lg">{tx('Satz gespeichert!')}</p>
                    <p className="text-sm text-muted-foreground">
                      {tx('Satz')} {satzNummer} — {lastGewicht} {tx('kg ×')} {lastWiederholungen} {tx('Wdh.')}
                    </p>
                  </div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
                    <Button onClick={handleWeiterenSatzLoggen} className="gap-2">
                      <IconPlus size={16} className="shrink-0" />
                      {tx('Weiteren Satz loggen')}
                    </Button>
                    <Button variant="outline" onClick={handleReset}>
                      {tx('Andere Übung')}
                    </Button>
                    <a href="#/" className="inline-flex items-center justify-center rounded-md text-sm font-medium h-10 px-4 py-2 border border-input bg-background hover:bg-accent hover:text-accent-foreground">
                      {tx('Fertig')}
                    </a>
                  </div>
                </div>
              ) : (
                /* Satz-Formular */
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="satz_nummer">{tx('Satz Nr.')}</Label>
                      <Input
                        id="satz_nummer"
                        type="number"
                        min={1}
                        value={satzNummer}
                        onChange={(e) => setSatzNummer(e.target.value)}
                        placeholder="1"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="datum">{tx('Zeitpunkt')}</Label>
                      <Input
                        id="datum"
                        type="datetime-local"
                        value={datum}
                        onChange={(e) => setDatum(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="gewicht_kg">
                        {tx('Gewicht (kg)')}
                        <span className="text-destructive ml-1">*</span>
                      </Label>
                      <Input
                        id="gewicht_kg"
                        type="number"
                        min={0}
                        step={0.5}
                        value={gewichtKg}
                        onChange={(e) => setGewichtKg(e.target.value)}
                        placeholder="0"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="wiederholungen">
                        {tx('Wiederholungen')}
                        <span className="text-destructive ml-1">*</span>
                      </Label>
                      <Input
                        id="wiederholungen"
                        type="number"
                        min={1}
                        value={wiederholungen}
                        onChange={(e) => setWiederholungen(e.target.value)}
                        placeholder="0"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="notiz">{tx('Notiz')} <span className="text-muted-foreground text-xs">({tx('optional')})</span></Label>
                    <Textarea
                      id="notiz"
                      value={notiz}
                      onChange={(e) => setNotiz(e.target.value)}
                      placeholder={tx('z. B. Technik, Befinden …')}
                      rows={2}
                    />
                  </div>

                  {submitError && (
                    <p className="text-sm text-destructive">{submitError}</p>
                  )}

                  <Button
                    className="w-full"
                    onClick={handleSubmit}
                    disabled={!canSubmit || submitting}
                  >
                    {submitting ? tx('Wird gespeichert …') : tx('Satz speichern')}
                  </Button>
                </div>
              )}
            </>
          ) : (
            /* Kein selectedUebung — Fallback für Deep-Link ?step=2 */
            <div className="text-center py-12 space-y-3">
              <p className="text-sm text-muted-foreground">
                {tx('Dieser Schritt braucht eine Übung aus Schritt 1.')}
              </p>
              <Button variant="outline" onClick={() => setStep(1)}>
                {tx('Neu starten')}
              </Button>
            </div>
          )}
        </div>
      )}
    </IntentWizardShell>
  );
}

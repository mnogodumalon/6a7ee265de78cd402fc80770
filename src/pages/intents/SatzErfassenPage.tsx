/**
 * Satz erfassen — 2-Schritt-Wizard für mobile Einhand-Bedienung.
 * Steps: 1) Übung wählen → 2) Gewicht + Wiederholungen eingeben & speichern.
 * Reads: uebungen, trainingslog. Writes: trainingslog (createTrainingslogEntry).
 * Composes: IntentWizardShell, EntitySelectStep.
 */
import { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { IconBarbell, IconCheck, IconRefresh } from '@tabler/icons-react';
import { tx } from '@/i18n';
import { APP_IDS } from '@/types/app';
import { useDashboardData } from '@/hooks/useDashboardData';
import { LivingAppsService, createRecordUrl, extractRecordId } from '@/services/livingAppsService';
import { IntentWizardShell } from '@/components/blocks/IntentWizardShell';
import { EntitySelectStep } from '@/components/blocks/EntitySelectStep';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type WizardPhase = 'select' | 'details' | 'success';

export default function SatzErfassenPage() {
  const { uebungen, trainingslog, loading, error, fetchAll } = useDashboardData();

  const [step, setStep] = useState(1);
  const [phase, setPhase] = useState<WizardPhase>('select');
  const [selectedUebungId, setSelectedUebungId] = useState<string | null>(null);
  const [gewicht, setGewicht] = useState('');
  const [wiederholungen, setWiederholungen] = useState('');
  const [notiz, setNotiz] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const selectedUebung = useMemo(
    () => uebungen.find(u => u.record_id === selectedUebungId) ?? null,
    [uebungen, selectedUebungId],
  );

  // Auto-berechne Satz-Nummer: Anzahl heutiger Einträge für diese Übung + 1
  const autoSatzNummer = useMemo(() => {
    if (!selectedUebungId) return 1;
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const count = trainingslog.filter(t => {
      const uebungUrl = t.fields.uebung ?? '';
      const recordId = extractRecordId({ key: '', label: uebungUrl } as never) ??
        uebungUrl.split('/').pop() ?? '';
      const datumStr = (t.fields.datum ?? '').slice(0, 10);
      return recordId === selectedUebungId && datumStr === todayStr;
    }).length;
    return count + 1;
  }, [selectedUebungId, trainingslog]);

  const handleUebungSelect = (id: string) => {
    setSelectedUebungId(id);
    setStep(2);
    setPhase('details');
    setGewicht('');
    setWiederholungen('');
    setNotiz('');
    setSaveError(null);
  };

  const handleSave = async () => {
    const gKg = parseFloat(gewicht);
    const wdh = parseInt(wiederholungen, 10);
    if (!selectedUebungId || isNaN(gKg) || isNaN(wdh)) return;

    setSaving(true);
    setSaveError(null);
    try {
      const now = new Date();
      await LivingAppsService.createTrainingslogEntry({
        datum: format(now, "yyyy-MM-dd'T'HH:mm"),
        uebung: createRecordUrl(APP_IDS.UEBUNGEN, selectedUebungId),
        satz_nummer: autoSatzNummer,
        gewicht_kg: gKg,
        wiederholungen: wdh,
        notiz: notiz.trim() || undefined,
      });
      await fetchAll();
      setPhase('success');
    } catch {
      setSaveError(tx('Fehler beim Speichern. Bitte erneut versuchen.'));
    } finally {
      setSaving(false);
    }
  };

  const handleWeiterenSatz = () => {
    setPhase('details');
    setGewicht('');
    setWiederholungen('');
    setNotiz('');
    setSaveError(null);
    setStep(2);
  };

  const handleAndereUebung = () => {
    setSelectedUebungId(null);
    setPhase('select');
    setGewicht('');
    setWiederholungen('');
    setNotiz('');
    setSaveError(null);
    setStep(1);
  };

  const canSave =
    !!selectedUebungId &&
    gewicht.trim() !== '' &&
    !isNaN(parseFloat(gewicht)) &&
    wiederholungen.trim() !== '' &&
    !isNaN(parseInt(wiederholungen, 10));

  return (
    <IntentWizardShell
      title={tx('Satz erfassen')}
      subtitle={tx('Trainingseinheit dokumentieren')}
      steps={[{ label: tx('Übung') }, { label: tx('Satz') }]}
      currentStep={step}
      onStepChange={s => {
        if (s === 1) handleAndereUebung();
        else if (s === 2 && selectedUebungId) { setStep(2); setPhase('details'); }
      }}
      loading={loading}
      error={error}
      onRetry={fetchAll}
    >
      {/* Schritt 1: Übung wählen */}
      {step === 1 && phase === 'select' && (
        <EntitySelectStep
          items={uebungen.map(u => ({
            id: u.record_id,
            title: u.fields.name ?? u.record_id,
            subtitle: u.fields.muskelgruppe?.label,
            icon: <IconBarbell size={20} className="text-primary" />,
          }))}
          onSelect={handleUebungSelect}
          searchPlaceholder={tx('Übung suchen …')}
          emptyText={tx('Keine Übungen gefunden')}
          emptyIcon={<IconBarbell size={48} className="text-muted-foreground" />}
        />
      )}

      {/* Schritt 2: Satz-Details eingeben */}
      {step === 2 && phase === 'details' && (
        selectedUebungId ? (
          <div className="space-y-6 px-1">
            {/* Gewählte Übung anzeigen */}
            <div className="rounded-2xl bg-secondary p-4 flex items-center gap-3">
              <IconBarbell size={24} className="text-primary shrink-0" />
              <div className="min-w-0">
                <p className="font-semibold text-foreground truncate">
                  {selectedUebung?.fields.name ?? selectedUebungId}
                </p>
                {selectedUebung?.fields.muskelgruppe?.label && (
                  <p className="text-sm text-muted-foreground">
                    {selectedUebung.fields.muskelgruppe.label}
                  </p>
                )}
              </div>
              <span className="ml-auto text-xs text-muted-foreground shrink-0">
                {tx('Satz')} {autoSatzNummer}
              </span>
            </div>

            {/* Haupteingaben — groß für Einhand-Bedienung */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="gewicht" className="text-base font-medium">
                  {tx('Gewicht (kg)')}
                </Label>
                <Input
                  id="gewicht"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={0.5}
                  value={gewicht}
                  onChange={e => setGewicht(e.target.value)}
                  placeholder="0"
                  className="text-3xl font-bold h-16 text-center"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wiederholungen" className="text-base font-medium">
                  {tx('Wiederholungen')}
                </Label>
                <Input
                  id="wiederholungen"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={wiederholungen}
                  onChange={e => setWiederholungen(e.target.value)}
                  placeholder="0"
                  className="text-3xl font-bold h-16 text-center"
                />
              </div>
            </div>

            {/* Optionale Notiz */}
            <div className="space-y-2">
              <Label htmlFor="notiz" className="text-base font-medium">
                {tx('Notiz (optional)')}
              </Label>
              <Input
                id="notiz"
                type="text"
                value={notiz}
                onChange={e => setNotiz(e.target.value)}
                placeholder={tx('z.B. Technik gut, leicht schwer …')}
                className="h-12"
              />
            </div>

            {saveError && (
              <p className="text-sm text-destructive">{saveError}</p>
            )}

            <Button
              onClick={handleSave}
              disabled={!canSave || saving}
              className="w-full h-14 text-lg font-semibold"
            >
              {saving ? tx('Wird gespeichert …') : tx('Satz speichern')}
            </Button>
          </div>
        ) : (
          <div className="text-center py-12 space-y-3">
            <p className="text-sm text-muted-foreground">
              {tx('Dieser Schritt braucht die Auswahl aus Schritt 1.')}
            </p>
            <Button variant="outline" onClick={handleAndereUebung}>
              {tx('Neu starten')}
            </Button>
          </div>
        )
      )}

      {/* Erfolgs-Zustand */}
      {phase === 'success' && (
        <div className="flex flex-col items-center gap-6 py-10 px-4 text-center">
          <div className="rounded-full bg-primary/10 p-5">
            <IconCheck size={48} className="text-primary" />
          </div>
          <div className="space-y-1">
            <h2 className="text-xl font-bold text-foreground">{tx('Satz gespeichert!')}</h2>
            <p className="text-muted-foreground">
              {tx('Satz')} {autoSatzNummer - 1} — {selectedUebung?.fields.name ?? ''}
            </p>
          </div>

          <div className="w-full space-y-3 max-w-xs">
            <Button
              onClick={handleWeiterenSatz}
              className="w-full h-13 text-base font-semibold"
            >
              <IconRefresh size={18} className="shrink-0 mr-2" />
              {tx('Weiteren Satz')}
            </Button>
            <Button
              variant="outline"
              onClick={handleAndereUebung}
              className="w-full h-12 text-base"
            >
              <IconBarbell size={18} className="shrink-0 mr-2" />
              {tx('Andere Übung')}
            </Button>
            <a
              href="#/"
              className="block text-center text-sm text-muted-foreground underline underline-offset-2 py-2"
            >
              {tx('Zurück zum Dashboard')}
            </a>
          </div>
        </div>
      )}
    </IntentWizardShell>
  );
}

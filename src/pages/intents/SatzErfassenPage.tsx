/**
 * Satz Erfassen — 2-Schritt-Wizard zum Protokollieren eines Trainingssatzes.
 * Steps: 1) Übung wählen (oder neu anlegen) → 2) Gewicht & Wiederholungen eingeben → Erfolg.
 * Reads: uebungen, trainingslog. Writes: trainingslog (createTrainingslogEntry), uebungen (createUebungenEntry).
 * Composes: IntentWizardShell, EntitySelectStep.
 */

import { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { IconBarbell, IconCheck, IconPlus, IconRefresh } from '@tabler/icons-react';
import { IntentWizardShell } from '@/components/blocks/IntentWizardShell';
import { EntitySelectStep } from '@/components/blocks/EntitySelectStep';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useDashboardData } from '@/hooks/useDashboardData';
import { APP_IDS, LOOKUP_OPTIONS } from '@/types/app';
import { LivingAppsService, createRecordUrl } from '@/services/livingAppsService';
import { tx } from '@/i18n';

const MUSKELGRUPPE_OPTIONS = LOOKUP_OPTIONS['uebungen']?.['muskelgruppe'] ?? [];

export default function SatzErfassenPage() {
  const data = useDashboardData();
  const { uebungen, trainingslog, loading, error, fetchAll } = data;

  const [step, setStep] = useState(1);

  // Schritt 1 — Übung wählen
  const [selectedUebungId, setSelectedUebungId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMuskelgruppe, setNewMuskelgruppe] = useState(MUSKELGRUPPE_OPTIONS[0]?.key ?? '');
  const [creating, setCreating] = useState(false);

  // Schritt 2 — Satz erfassen
  const [gewichtKg, setGewichtKg] = useState('');
  const [wiederholungen, setWiederholungen] = useState('');
  const [notiz, setNotiz] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Erfolg-State
  const [successData, setSuccessData] = useState<{
    uebungName: string;
    satzNummer: number;
    gewichtKg: number;
    wiederholungen: number;
  } | null>(null);

  // Satz-Nummer: count existing sets for this exercise today + 1
  const satzNummer = useMemo(() => {
    if (!selectedUebungId) return 1;
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const uebungUrl = createRecordUrl(APP_IDS.UEBUNGEN, selectedUebungId);
    const todaySets = trainingslog.filter(log => {
      const matchesExercise = log.fields.uebung === uebungUrl;
      const matchesDate = log.fields.datum?.startsWith(todayStr) ?? false;
      return matchesExercise && matchesDate;
    });
    return todaySets.length + 1;
  }, [selectedUebungId, trainingslog]);

  const selectedUebung = useMemo(
    () => uebungen.find(u => u.record_id === selectedUebungId) ?? null,
    [selectedUebungId, uebungen]
  );

  const handleSelectUebung = (id: string) => {
    setSelectedUebungId(id);
    setStep(2);
  };

  const handleCreateUebung = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const created = await LivingAppsService.createUebungenEntry({
        name: newName.trim(),
        muskelgruppe: newMuskelgruppe || undefined,
      });
      await fetchAll();
      setShowCreate(false);
      setNewName('');
      setSelectedUebungId(created.record_id);
      setStep(2);
    } finally {
      setCreating(false);
    }
  };

  const handleSubmitSatz = async () => {
    if (!selectedUebungId || !gewichtKg || !wiederholungen) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const datum = format(new Date(), "yyyy-MM-dd'T'HH:mm");
      await LivingAppsService.createTrainingslogEntry({
        datum,
        uebung: createRecordUrl(APP_IDS.UEBUNGEN, selectedUebungId),
        satz_nummer: satzNummer,
        gewicht_kg: parseFloat(gewichtKg),
        wiederholungen: parseInt(wiederholungen, 10),
        notiz: notiz.trim() || undefined,
      });
      await fetchAll();
      setSuccessData({
        uebungName: selectedUebung?.fields.name ?? selectedUebungId,
        satzNummer,
        gewichtKg: parseFloat(gewichtKg),
        wiederholungen: parseInt(wiederholungen, 10),
      });
    } catch (err) {
      setSubmitError(tx('Fehler beim Speichern. Bitte erneut versuchen.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleWeiterenSatz = async () => {
    // Gleiche Übung, Satz-Nummer wird automatisch neu berechnet
    setGewichtKg('');
    setWiederholungen('');
    setNotiz('');
    setSubmitError(null);
    setSuccessData(null);
    setStep(2);
  };

  const handleNeueUebung = () => {
    setSelectedUebungId(null);
    setGewichtKg('');
    setWiederholungen('');
    setNotiz('');
    setSubmitError(null);
    setSuccessData(null);
    setShowCreate(false);
    setNewName('');
    setStep(1);
  };

  // Erfolg-Zustand
  if (successData) {
    return (
      <IntentWizardShell
        title={tx('Satz erfassen')}
        subtitle={tx('Trainingssatz protokollieren')}
        steps={[{ label: tx('Übung') }, { label: tx('Satz') }]}
        currentStep={2}
        onStepChange={setStep}
        loading={loading}
        error={error}
        onRetry={fetchAll}
      >
        <div className="flex flex-col items-center gap-6 py-10 px-4 text-center">
          <div className="rounded-full bg-primary/10 p-5">
            <IconCheck size={48} className="text-primary" />
          </div>
          <div className="space-y-1">
            <h2 className="text-xl font-semibold text-foreground">
              {tx('Satz gespeichert!')}
            </h2>
            <p className="text-muted-foreground text-sm">
              {successData.uebungName}
            </p>
          </div>
          <div className="flex gap-4 flex-wrap justify-center">
            <div className="rounded-xl border bg-card px-5 py-3 text-center min-w-[90px]">
              <p className="text-xs text-muted-foreground mb-1">{tx('Satz')}</p>
              <p className="text-2xl font-bold text-foreground">{successData.satzNummer}</p>
            </div>
            <div className="rounded-xl border bg-card px-5 py-3 text-center min-w-[90px]">
              <p className="text-xs text-muted-foreground mb-1">{tx('Gewicht')}</p>
              <p className="text-2xl font-bold text-foreground">{successData.gewichtKg} {tx('kg')}</p>
            </div>
            <div className="rounded-xl border bg-card px-5 py-3 text-center min-w-[90px]">
              <p className="text-xs text-muted-foreground mb-1">{tx('Wdh.')}</p>
              <p className="text-2xl font-bold text-foreground">{successData.wiederholungen}</p>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 w-full max-w-xs">
            <Button className="flex-1" onClick={handleWeiterenSatz}>
              <IconRefresh size={16} className="shrink-0 mr-2" />
              {tx('Weiteren Satz')}
            </Button>
            <Button variant="outline" className="flex-1" onClick={handleNeueUebung}>
              {tx('Neue Übung')}
            </Button>
          </div>
          <a href="#/" className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
            {tx('Zurück zum Dashboard')}
          </a>
        </div>
      </IntentWizardShell>
    );
  }

  return (
    <IntentWizardShell
      title={tx('Satz erfassen')}
      subtitle={tx('Trainingssatz protokollieren')}
      steps={[{ label: tx('Übung') }, { label: tx('Satz') }]}
      currentStep={step}
      onStepChange={setStep}
      loading={loading}
      error={error}
      onRetry={fetchAll}
    >
      {/* Schritt 1: Übung wählen */}
      {step === 1 && (
        <EntitySelectStep
          items={uebungen.map(u => ({
            id: u.record_id,
            title: u.fields.name ?? u.record_id,
            subtitle: u.fields.muskelgruppe?.label,
            icon: <IconBarbell size={20} className="text-primary" />,
          }))}
          onSelect={handleSelectUebung}
          createLabel={tx('Neue Übung anlegen')}
          onCreateNew={() => setShowCreate(true)}
          searchPlaceholder={tx('Übung suchen …')}
          emptyText={tx('Noch keine Übungen vorhanden.')}
          emptyIcon={<IconBarbell size={32} className="text-muted-foreground" />}
          createDialog={showCreate && (
            <div className="rounded-2xl border bg-card p-4 space-y-4">
              <h3 className="font-medium text-sm text-foreground">{tx('Neue Übung')}</h3>
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="new-uebung-name" className="text-sm">
                    {tx('Name')} <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="new-uebung-name"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    placeholder={tx('z.B. Bankdrücken')}
                    autoFocus
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-muskelgruppe" className="text-sm">
                    {tx('Muskelgruppe')}
                  </Label>
                  <Select value={newMuskelgruppe} onValueChange={setNewMuskelgruppe}>
                    <SelectTrigger id="new-muskelgruppe">
                      <SelectValue placeholder={tx('Muskelgruppe wählen')} />
                    </SelectTrigger>
                    <SelectContent>
                      {MUSKELGRUPPE_OPTIONS.map(opt => (
                        <SelectItem key={opt.key} value={opt.key}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <Button
                  disabled={!newName.trim() || creating}
                  onClick={handleCreateUebung}
                  className="flex-1"
                >
                  <IconPlus size={16} className="shrink-0 mr-1" />
                  {creating ? tx('Wird angelegt …') : tx('Anlegen & wählen')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => { setShowCreate(false); setNewName(''); }}
                >
                  {tx('Abbrechen')}
                </Button>
              </div>
            </div>
          )}
        />
      )}

      {/* Schritt 2: Satz erfassen */}
      {step === 2 && (
        selectedUebungId ? (
          <div className="space-y-6 max-w-md mx-auto">
            {/* Übung + Satz-Nummer Info */}
            <div className="flex items-center justify-between gap-3 rounded-xl bg-secondary px-4 py-3">
              <div className="flex items-center gap-3 min-w-0">
                <IconBarbell size={20} className="text-primary shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium text-sm text-foreground truncate">
                    {selectedUebung?.fields.name ?? selectedUebungId}
                  </p>
                  {selectedUebung?.fields.muskelgruppe?.label && (
                    <p className="text-xs text-muted-foreground">
                      {selectedUebung.fields.muskelgruppe.label}
                    </p>
                  )}
                </div>
              </div>
              <span className="shrink-0 rounded-full bg-primary/10 text-primary text-xs font-semibold px-3 py-1 whitespace-nowrap">
                {tx('Satz')} {satzNummer}
              </span>
            </div>

            {/* Formular */}
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label htmlFor="gewicht" className="text-sm">
                    {tx('Gewicht (kg)')} <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="gewicht"
                    type="number"
                    min={0}
                    step={0.5}
                    value={gewichtKg}
                    onChange={e => setGewichtKg(e.target.value)}
                    placeholder="0"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="wiederholungen" className="text-sm">
                    {tx('Wiederholungen')} <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="wiederholungen"
                    type="number"
                    min={1}
                    step={1}
                    value={wiederholungen}
                    onChange={e => setWiederholungen(e.target.value)}
                    placeholder="1"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="notiz" className="text-sm text-muted-foreground">
                  {tx('Notiz (optional)')}
                </Label>
                <Input
                  id="notiz"
                  value={notiz}
                  onChange={e => setNotiz(e.target.value)}
                  placeholder={tx('z.B. Technik verbessert')}
                />
              </div>
            </div>

            {submitError && (
              <p className="text-sm text-destructive">{submitError}</p>
            )}

            <div className="flex flex-col gap-3 pt-1">
              <Button
                disabled={!gewichtKg || !wiederholungen || submitting}
                onClick={handleSubmitSatz}
                className="w-full"
              >
                <IconCheck size={16} className="shrink-0 mr-2" />
                {submitting ? tx('Wird gespeichert …') : tx('Satz speichern')}
              </Button>
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => setStep(1)}
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
    </IntentWizardShell>
  );
}

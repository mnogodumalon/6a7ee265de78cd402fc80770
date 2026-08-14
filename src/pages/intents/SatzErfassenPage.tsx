/**
 * Satz erfassen — 2-Schritt-Wizard für die mobile Trainingserfassung.
 * Steps: 1) Übung wählen (aus Uebungen-Liste, mit Inline-Anlegen) →
 *        2) Satz-Details eingeben (datum, satz_nummer, gewicht_kg, wiederholungen, notiz) →
 *        Erfolgsscreen mit Loop-Option.
 * Reads: uebungen, trainingslog. Writes: trainingslog (createTrainingslogEntry),
 *        uebungen (createUebungenEntry beim Inline-Anlegen).
 * Composes: IntentWizardShell, EntitySelectStep.
 */
import { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { IconBarbell, IconCheck, IconPlus } from '@tabler/icons-react';
import { IntentWizardShell } from '@/components/blocks/IntentWizardShell';
import { EntitySelectStep } from '@/components/blocks/EntitySelectStep';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useDashboardData } from '@/hooks/useDashboardData';
import { APP_IDS, LOOKUP_OPTIONS } from '@/types/app';
import { LivingAppsService, createRecordUrl } from '@/services/livingAppsService';
import { tx } from '@/i18n';

const MUSKELGRUPPEN = LOOKUP_OPTIONS['uebungen']?.['muskelgruppe'] ?? [];

export default function SatzErfassenPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialStep = parseInt(searchParams.get('step') ?? '1', 10);

  const { uebungen, trainingslog, loading, error, fetchAll } = useDashboardData();

  // Wizard state
  const [step, setStep] = useState(initialStep >= 1 && initialStep <= 3 ? initialStep : 1);

  // Step 1: Übung
  const [selectedUebungId, setSelectedUebungId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMuskelgruppe, setNewMuskelgruppe] = useState('');
  const [creating, setCreating] = useState(false);

  // Step 2: Satz-Details
  const [datum, setDatum] = useState(format(new Date(), "yyyy-MM-dd'T'HH:mm"));
  const [satzNummer, setSatzNummer] = useState('');
  const [gewichtKg, setGewichtKg] = useState('');
  const [wiederholungen, setWiederholungen] = useState('');
  const [notiz, setNotiz] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Success state
  const [loggedEntry, setLoggedEntry] = useState<{
    uebungName: string;
    satzNummer: number;
    gewichtKg: number;
    wiederholungen: number;
    datum: string;
  } | null>(null);

  // Satz-Nummer Auto-Suggest: count existing Trainingslog records for this Übung today
  const autoSatzNummer = useMemo(() => {
    if (!selectedUebungId) return 1;
    const today = format(new Date(), 'yyyy-MM-dd');
    const uebungUrl = createRecordUrl(APP_IDS.UEBUNGEN, selectedUebungId);
    const count = trainingslog.filter(t => {
      const d = t.fields.datum ?? '';
      return t.fields.uebung === uebungUrl && d.startsWith(today);
    }).length;
    return count + 1;
  }, [selectedUebungId, trainingslog]);

  const selectedUebung = useMemo(
    () => uebungen.find(u => u.record_id === selectedUebungId) ?? null,
    [uebungen, selectedUebungId],
  );

  function goToStep(n: number) {
    setStep(n);
    setSearchParams(prev => { const p = new URLSearchParams(prev); p.set('step', String(n)); return p; });
  }

  // ── Step 1 handlers ──────────────────────────────────────────────────────

  function handleSelectUebung(id: string) {
    setSelectedUebungId(id);
    setSatzNummer(String(autoSatzNummer));
    goToStep(2);
  }

  async function handleCreateUebung() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const created = await LivingAppsService.createUebungenEntry({
        name: newName.trim(),
        ...(newMuskelgruppe && newMuskelgruppe !== 'none' ? { muskelgruppe: newMuskelgruppe } : {}),
      });
      await fetchAll();
      setShowCreate(false);
      setNewName('');
      setNewMuskelgruppe('');
      setSelectedUebungId(created.record_id);
      setSatzNummer(String(1));
      goToStep(2);
    } finally {
      setCreating(false);
    }
  }

  // ── Step 2 handlers ──────────────────────────────────────────────────────

  async function handleSubmit() {
    if (!selectedUebungId || !datum || !gewichtKg || !wiederholungen) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await LivingAppsService.createTrainingslogEntry({
        datum,
        uebung: createRecordUrl(APP_IDS.UEBUNGEN, selectedUebungId),
        satz_nummer: satzNummer ? parseInt(satzNummer, 10) : undefined,
        gewicht_kg: parseFloat(gewichtKg),
        wiederholungen: parseInt(wiederholungen, 10),
        ...(notiz.trim() ? { notiz: notiz.trim() } : {}),
      });
      await fetchAll();
      setLoggedEntry({
        uebungName: selectedUebung?.fields.name ?? selectedUebungId,
        satzNummer: satzNummer ? parseInt(satzNummer, 10) : 1,
        gewichtKg: parseFloat(gewichtKg),
        wiederholungen: parseInt(wiederholungen, 10),
        datum,
      });
      goToStep(3);
    } catch (e) {
      setSubmitError(tx('Fehler beim Speichern. Bitte erneut versuchen.'));
    } finally {
      setSubmitting(false);
    }
  }

  function handleWiederholenMitGleicherUebung() {
    // loop back to step 2 with same Übung
    const nextSatz = (loggedEntry?.satzNummer ?? 0) + 1;
    setDatum(format(new Date(), "yyyy-MM-dd'T'HH:mm"));
    setSatzNummer(String(nextSatz));
    setGewichtKg(gewichtKg); // keep last weight
    setWiederholungen('');
    setNotiz('');
    setSubmitError(null);
    setLoggedEntry(null);
    goToStep(2);
  }

  function handleNeuStart() {
    setSelectedUebungId(null);
    setShowCreate(false);
    setNewName('');
    setNewMuskelgruppe('');
    setDatum(format(new Date(), "yyyy-MM-dd'T'HH:mm"));
    setSatzNummer('');
    setGewichtKg('');
    setWiederholungen('');
    setNotiz('');
    setSubmitError(null);
    setLoggedEntry(null);
    goToStep(1);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const steps = [
    { label: tx('Übung wählen') },
    { label: tx('Satz-Details') },
    { label: tx('Fertig') },
  ];

  return (
    <IntentWizardShell
      title={tx('Satz erfassen')}
      subtitle={tx('Schnell und mobil-freundlich trainieren')}
      steps={steps}
      currentStep={step}
      onStepChange={goToStep}
      loading={loading}
      error={error}
      onRetry={fetchAll}
    >
      {/* ── Step 1: Übung wählen ── */}
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
          emptyText={tx('Keine Übung gefunden')}
          emptyIcon={<IconBarbell size={32} className="text-muted-foreground" />}
          createDialog={showCreate && (
            <div className="rounded-2xl border bg-card p-4 space-y-3">
              <p className="text-sm font-medium text-foreground">{tx('Neue Übung')}</p>
              <Input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder={tx('Name der Übung')}
                className="w-full"
                autoFocus
              />
              <Select value={newMuskelgruppe || 'none'} onValueChange={v => setNewMuskelgruppe(v === 'none' ? '' : v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={tx('Muskelgruppe (optional)')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{tx('Keine Angabe')}</SelectItem>
                  {MUSKELGRUPPEN.map(opt => (
                    <SelectItem key={opt.key} value={opt.key}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => { setShowCreate(false); setNewName(''); setNewMuskelgruppe(''); }}
                  disabled={creating}
                >
                  {tx('Abbrechen')}
                </Button>
                <Button
                  className="flex-1"
                  onClick={handleCreateUebung}
                  disabled={!newName.trim() || creating}
                >
                  <IconPlus size={16} className="shrink-0 mr-1" />
                  {creating ? tx('Anlegen …') : tx('Anlegen')}
                </Button>
              </div>
            </div>
          )}
        />
      )}

      {/* ── Step 2: Satz-Details ── */}
      {step === 2 && (
        selectedUebungId ? (
          <div className="space-y-6">
            {/* Ausgewählte Übung prominent anzeigen */}
            <div className="rounded-2xl bg-primary/10 border border-primary/20 p-4 flex items-center gap-3">
              <IconBarbell size={28} className="text-primary shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground">{tx('Ausgewählte Übung')}</p>
                <p className="text-lg font-bold text-foreground">
                  {selectedUebung?.fields.name ?? selectedUebungId}
                </p>
                {selectedUebung?.fields.muskelgruppe?.label && (
                  <p className="text-sm text-muted-foreground">{selectedUebung.fields.muskelgruppe.label}</p>
                )}
              </div>
            </div>

            {/* Formular */}
            <div className="space-y-4">
              {/* Datum */}
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">{tx('Zeitpunkt')}</label>
                <Input
                  type="datetime-local"
                  value={datum}
                  onChange={e => setDatum(e.target.value)}
                  className="w-full"
                />
              </div>

              {/* Satz-Nummer */}
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">{tx('Satz-Nummer')}</label>
                <Input
                  type="number"
                  inputMode="numeric"
                  value={satzNummer}
                  onChange={e => setSatzNummer(e.target.value)}
                  placeholder={String(autoSatzNummer)}
                  min={1}
                  className="w-full text-xl h-14 text-center font-bold"
                />
                <p className="text-xs text-muted-foreground">
                  {tx('Vorschlag basierend auf heutigen Einträgen:')} {autoSatzNummer}
                </p>
              </div>

              {/* Gewicht und Wiederholungen nebeneinander */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-foreground">{tx('Gewicht (kg)')}</label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={gewichtKg}
                    onChange={e => setGewichtKg(e.target.value)}
                    placeholder="0"
                    min={0}
                    step={0.5}
                    className="w-full text-2xl h-16 text-center font-bold"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-foreground">{tx('Wiederholungen')}</label>
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={wiederholungen}
                    onChange={e => setWiederholungen(e.target.value)}
                    placeholder="0"
                    min={1}
                    className="w-full text-2xl h-16 text-center font-bold"
                  />
                </div>
              </div>

              {/* Notiz */}
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">{tx('Notiz (optional)')}</label>
                <Input
                  value={notiz}
                  onChange={e => setNotiz(e.target.value)}
                  placeholder={tx('z. B. Technik, Gefühl, …')}
                  className="w-full"
                />
              </div>
            </div>

            {submitError && (
              <p className="text-sm text-destructive">{submitError}</p>
            )}

            {/* Aktionen */}
            <div className="flex flex-col gap-2">
              <Button
                className="w-full h-14 text-base font-semibold"
                onClick={handleSubmit}
                disabled={submitting || !datum || !gewichtKg || !wiederholungen}
              >
                {submitting ? tx('Speichern …') : tx('Satz speichern')}
              </Button>
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => goToStep(1)}
                disabled={submitting}
              >
                {tx('Andere Übung wählen')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-center py-12 space-y-3">
            <p className="text-sm text-muted-foreground">{tx('Dieser Schritt braucht die Auswahl aus Schritt 1.')}</p>
            <Button variant="outline" onClick={() => goToStep(1)}>{tx('Neu starten')}</Button>
          </div>
        )
      )}

      {/* ── Step 3: Erfolg ── */}
      {step === 3 && (
        loggedEntry ? (
          <div className="space-y-6 text-center">
            {/* Erfolgs-Icon */}
            <div className="flex justify-center">
              <div className="rounded-full bg-primary/10 p-6">
                <IconCheck size={48} className="text-primary" />
              </div>
            </div>

            <div>
              <p className="text-xl font-bold text-foreground">{tx('Satz gespeichert!')}</p>
              <p className="text-sm text-muted-foreground mt-1">{tx('Gut gemacht!')}</p>
            </div>

            {/* Zusammenfassung */}
            <div className="rounded-2xl border bg-card p-4 text-left space-y-2">
              <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                {tx('Dein Satz')}
              </p>
              <div className="flex items-center gap-2">
                <IconBarbell size={18} className="text-primary shrink-0" />
                <span className="font-bold text-foreground text-lg">{loggedEntry.uebungName}</span>
              </div>
              <div className="grid grid-cols-3 gap-3 mt-3">
                <div className="rounded-xl bg-secondary p-3 text-center">
                  <p className="text-2xl font-bold text-foreground">{loggedEntry.satzNummer}</p>
                  <p className="text-xs text-muted-foreground">{tx('Satz')}</p>
                </div>
                <div className="rounded-xl bg-secondary p-3 text-center">
                  <p className="text-2xl font-bold text-foreground">{loggedEntry.gewichtKg}</p>
                  <p className="text-xs text-muted-foreground">{tx('kg')}</p>
                </div>
                <div className="rounded-xl bg-secondary p-3 text-center">
                  <p className="text-2xl font-bold text-foreground">{loggedEntry.wiederholungen}</p>
                  <p className="text-xs text-muted-foreground">{tx('Wdh.')}</p>
                </div>
              </div>
            </div>

            {/* Aktionen */}
            <div className="flex flex-col gap-2">
              <Button
                className="w-full h-14 text-base font-semibold"
                onClick={handleWiederholenMitGleicherUebung}
              >
                {tx('Weiteren Satz erfassen')}
              </Button>
              <Button
                variant="outline"
                className="w-full h-12"
                onClick={handleNeuStart}
              >
                {tx('Andere Übung')}
              </Button>
              <a href="#/" className="w-full">
                <Button variant="ghost" className="w-full">
                  {tx('Fertig — Zurück zum Dashboard')}
                </Button>
              </a>
            </div>
          </div>
        ) : (
          <div className="text-center py-12 space-y-3">
            <p className="text-sm text-muted-foreground">{tx('Dieser Schritt braucht die Auswahl aus Schritt 1.')}</p>
            <Button variant="outline" onClick={() => goToStep(1)}>{tx('Neu starten')}</Button>
          </div>
        )
      )}
    </IntentWizardShell>
  );
}

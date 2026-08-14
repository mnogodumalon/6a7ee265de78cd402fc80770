/**
 * Satz loggen — 2-Schritt-Wizard für mobil-optimierte Trainingserfassung.
 * Steps: 1) Übung wählen (aus Uebungen, mit Inline-Neu-anlegen) →
 *        2) Satz-Details erfassen (Gewicht, Wiederholungen, Satznummer, Notiz) → Erfolg.
 * Reads: uebungen, trainingslog. Writes: trainingslog (createTrainingslogEntry).
 * Composes: IntentWizardShell, EntitySelectStep.
 */

import { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { IntentWizardShell } from '@/components/blocks/IntentWizardShell';
import { EntitySelectStep } from '@/components/blocks/EntitySelectStep';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  IconDumbbell,
  IconCheck,
  IconPlus,
  IconRepeat,
  IconWeight,
  IconListNumbers,
  IconNotes,
} from '@tabler/icons-react';
import { tx } from '@/i18n';
import { lookupLabel } from '@/i18n';
import { APP_IDS, LOOKUP_OPTIONS } from '@/types/app';
import { LivingAppsService, createRecordUrl, extractRecordId } from '@/services/livingAppsService';
import { useDashboardData } from '@/hooks/useDashboardData';

const MUSKELGRUPPEN = LOOKUP_OPTIONS['uebungen']?.['muskelgruppe'] ?? [];

export default function SatzLoggenPage() {
  const { uebungen, trainingslog, loading, error, fetchAll } = useDashboardData();

  const [step, setStep] = useState(1);

  // Step 1 — Übung
  const [selectedUebungId, setSelectedUebungId] = useState<string | null>(null);
  const [showNewUebung, setShowNewUebung] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMuskelgruppe, setNewMuskelgruppe] = useState('none');
  const [creatingUebung, setCreatingUebung] = useState(false);

  // Step 2 — Satz-Details
  const [satzNummer, setSatzNummer] = useState('');
  const [gewichtKg, setGewichtKg] = useState('');
  const [wiederholungen, setWiederholungen] = useState('');
  const [notiz, setNotiz] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Success state
  const [savedSatz, setSavedSatz] = useState<{
    uebungName: string;
    satzNummer: number;
    gewichtKg: number;
    wiederholungen: number;
  } | null>(null);

  // Derive pre-fills for step 2
  const selectedUebung = useMemo(
    () => uebungen.find(u => u.record_id === selectedUebungId) ?? null,
    [uebungen, selectedUebungId]
  );

  // Logs for this Übung today — used for satz_nummer prefill
  const todayPrefix = format(new Date(), 'yyyy-MM-dd');

  const logsForUebungToday = useMemo(() => {
    if (!selectedUebungId) return [];
    return trainingslog.filter(log => {
      const logUebungId = extractRecordId(log.fields.uebung);
      return logUebungId === selectedUebungId && (log.fields.datum ?? '').startsWith(todayPrefix);
    });
  }, [trainingslog, selectedUebungId, todayPrefix]);

  // Last recorded weight for this Übung (sorted by datum desc)
  const lastGewicht = useMemo(() => {
    if (!selectedUebungId) return null;
    const logs = trainingslog
      .filter(log => extractRecordId(log.fields.uebung) === selectedUebungId && log.fields.gewicht_kg != null)
      .sort((a, b) => (b.fields.datum ?? '').localeCompare(a.fields.datum ?? ''));
    return logs[0]?.fields.gewicht_kg ?? null;
  }, [trainingslog, selectedUebungId]);

  // Called when an Übung is selected — prefill step 2 fields
  function selectUebung(id: string) {
    setSelectedUebungId(id);
    // Prefill satz_nummer with count of today's logs + 1
    const logsToday = trainingslog.filter(log => {
      const logUebungId = extractRecordId(log.fields.uebung);
      return logUebungId === id && (log.fields.datum ?? '').startsWith(todayPrefix);
    });
    setSatzNummer(String(logsToday.length + 1));
    // Prefill gewicht_kg with last recorded weight
    const logs = trainingslog
      .filter(log => extractRecordId(log.fields.uebung) === id && log.fields.gewicht_kg != null)
      .sort((a, b) => (b.fields.datum ?? '').localeCompare(a.fields.datum ?? ''));
    const lastW = logs[0]?.fields.gewicht_kg;
    setGewichtKg(lastW != null ? String(lastW) : '');
    setWiederholungen('');
    setNotiz('');
    setSaveError(null);
    setSavedSatz(null);
    setStep(2);
  }

  async function handleCreateUebung() {
    if (!newName.trim()) return;
    setCreatingUebung(true);
    try {
      const created = await LivingAppsService.createUebungenEntry({
        name: newName.trim(),
        ...(newMuskelgruppe !== 'none' ? { muskelgruppe: newMuskelgruppe } : {}),
      });
      await fetchAll();
      setShowNewUebung(false);
      setNewName('');
      setNewMuskelgruppe('none');
      selectUebung(created.record_id);
    } finally {
      setCreatingUebung(false);
    }
  }

  async function handleSaveSatz() {
    if (!selectedUebungId) return;
    const gKg = parseFloat(gewichtKg);
    const wdh = parseInt(wiederholungen, 10);
    if (isNaN(gKg) || isNaN(wdh)) return;

    setSaving(true);
    setSaveError(null);
    try {
      const datum = format(new Date(), "yyyy-MM-dd'T'HH:mm");
      const satzNum = parseInt(satzNummer, 10);
      await LivingAppsService.createTrainingslogEntry({
        datum,
        uebung: createRecordUrl(APP_IDS.UEBUNGEN, selectedUebungId),
        ...(isNaN(satzNum) ? {} : { satz_nummer: satzNum }),
        gewicht_kg: gKg,
        wiederholungen: wdh,
        ...(notiz.trim() ? { notiz: notiz.trim() } : {}),
      });
      await fetchAll();
      setSavedSatz({
        uebungName: selectedUebung?.fields.name ?? '',
        satzNummer: isNaN(satzNum) ? logsForUebungToday.length + 1 : satzNum,
        gewichtKg: gKg,
        wiederholungen: wdh,
      });
      setStep(3);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : tx('Fehler beim Speichern'));
    } finally {
      setSaving(false);
    }
  }

  function resetToStep2() {
    if (!selectedUebungId) return;
    // Recalculate prefills based on now-refreshed data
    const logsToday = trainingslog.filter(log => {
      const logUebungId = extractRecordId(log.fields.uebung);
      return logUebungId === selectedUebungId && (log.fields.datum ?? '').startsWith(todayPrefix);
    });
    setSatzNummer(String(logsToday.length + 1));
    // Keep same weight as last saved
    if (savedSatz) setGewichtKg(String(savedSatz.gewichtKg));
    setWiederholungen('');
    setNotiz('');
    setSaveError(null);
    setSavedSatz(null);
    setStep(2);
  }

  function resetToStep1() {
    setSelectedUebungId(null);
    setShowNewUebung(false);
    setNewName('');
    setNewMuskelgruppe('none');
    setSatzNummer('');
    setGewichtKg('');
    setWiederholungen('');
    setNotiz('');
    setSaveError(null);
    setSavedSatz(null);
    setStep(1);
  }

  const canSave = gewichtKg.trim() !== '' && !isNaN(parseFloat(gewichtKg)) &&
    wiederholungen.trim() !== '' && !isNaN(parseInt(wiederholungen, 10));

  return (
    <IntentWizardShell
      title={tx('Satz loggen')}
      subtitle={tx('Übung wählen und Trainingssatz erfassen')}
      steps={[
        { label: tx('Übung wählen') },
        { label: tx('Satz erfassen') },
        { label: tx('Gespeichert') },
      ]}
      currentStep={step}
      onStepChange={setStep}
      loading={loading}
      error={error}
      onRetry={fetchAll}
    >
      {/* ─── Schritt 1: Übung wählen ─── */}
      {step === 1 && (
        <EntitySelectStep
          items={uebungen.map(u => ({
            id: u.record_id,
            title: u.fields.name ?? '',
            subtitle: u.fields.muskelgruppe
              ? lookupLabel('uebungen', 'muskelgruppe', u.fields.muskelgruppe.key) ?? u.fields.muskelgruppe.label
              : undefined,
            icon: <IconDumbbell size={20} className="text-primary" />,
          }))}
          onSelect={selectUebung}
          searchPlaceholder={tx('Übung suchen …')}
          emptyIcon={<IconDumbbell size={32} />}
          emptyText={tx('Keine Übungen gefunden')}
          createLabel={tx('Neue Übung anlegen')}
          onCreateNew={() => setShowNewUebung(prev => !prev)}
          createDialog={showNewUebung && (
            <div className="rounded-2xl border bg-card p-4 space-y-3">
              <p className="text-sm font-medium text-foreground">{tx('Neue Übung anlegen')}</p>
              <div className="space-y-2">
                <Label htmlFor="new-uebung-name">{tx('Name')}</Label>
                <Input
                  id="new-uebung-name"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder={tx('z. B. Bankdrücken')}
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-uebung-muskelgruppe">{tx('Muskelgruppe')}</Label>
                <Select value={newMuskelgruppe} onValueChange={setNewMuskelgruppe}>
                  <SelectTrigger id="new-uebung-muskelgruppe">
                    <SelectValue placeholder={tx('Muskelgruppe wählen')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{tx('Keine Angabe')}</SelectItem>
                    {MUSKELGRUPPEN.map(opt => (
                      <SelectItem key={opt.key} value={opt.key}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-2">
                <Button
                  disabled={!newName.trim() || creatingUebung}
                  onClick={handleCreateUebung}
                  className="flex-1"
                >
                  <IconPlus size={15} className="shrink-0 mr-1.5" />
                  {creatingUebung ? tx('Anlegen …') : tx('Anlegen & wählen')}
                </Button>
                <Button variant="outline" onClick={() => setShowNewUebung(false)}>
                  {tx('Abbrechen')}
                </Button>
              </div>
            </div>
          )}
        />
      )}

      {/* ─── Schritt 2: Satz-Details ─── */}
      {step === 2 && (
        selectedUebungId ? (
          <div className="space-y-5">
            {/* Übung-Kontext */}
            <div className="flex items-center gap-3 p-4 rounded-2xl bg-secondary">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <IconDumbbell size={20} className="text-primary" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-sm truncate">{selectedUebung?.fields.name}</p>
                {selectedUebung?.fields.muskelgruppe && (
                  <p className="text-xs text-muted-foreground">
                    {lookupLabel('uebungen', 'muskelgruppe', selectedUebung.fields.muskelgruppe.key) ?? selectedUebung.fields.muskelgruppe.label}
                  </p>
                )}
              </div>
              <button
                onClick={() => setStep(1)}
                className="ml-auto text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
              >
                {tx('Ändern')}
              </button>
            </div>

            {/* Satz-Felder */}
            <div className="grid grid-cols-2 gap-4">
              {/* Gewicht */}
              <div className="space-y-2 col-span-2 sm:col-span-1">
                <Label htmlFor="gewicht" className="flex items-center gap-1.5">
                  <IconWeight size={14} className="shrink-0 text-muted-foreground" />
                  {tx('Gewicht (kg)')} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="gewicht"
                  type="number"
                  inputMode="decimal"
                  step="0.5"
                  min="0"
                  value={gewichtKg}
                  onChange={e => setGewichtKg(e.target.value)}
                  placeholder={lastGewicht != null ? String(lastGewicht) : tx('z. B. 80')}
                />
                {lastGewicht != null && (
                  <p className="text-xs text-muted-foreground">
                    {tx('Letztes Mal')}: <span className="font-medium">{lastGewicht} {tx('kg')}</span>
                  </p>
                )}
              </div>

              {/* Wiederholungen */}
              <div className="space-y-2 col-span-2 sm:col-span-1">
                <Label htmlFor="wdh" className="flex items-center gap-1.5">
                  <IconRepeat size={14} className="shrink-0 text-muted-foreground" />
                  {tx('Wiederholungen')} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="wdh"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  value={wiederholungen}
                  onChange={e => setWiederholungen(e.target.value)}
                  placeholder={tx('z. B. 10')}
                />
              </div>

              {/* Satz-Nummer */}
              <div className="space-y-2 col-span-2 sm:col-span-1">
                <Label htmlFor="satznr" className="flex items-center gap-1.5">
                  <IconListNumbers size={14} className="shrink-0 text-muted-foreground" />
                  {tx('Satz-Nummer')}
                </Label>
                <Input
                  id="satznr"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  value={satzNummer}
                  onChange={e => setSatzNummer(e.target.value)}
                  placeholder={tx('z. B. 1')}
                />
                <p className="text-xs text-muted-foreground">
                  {logsForUebungToday.length > 0
                    ? tx(tx`${logsForUebungToday.length} Satz/Sätze heute bereits geloggt`)
                    : tx('Erster Satz heute')}
                </p>
              </div>

              {/* Notiz */}
              <div className="space-y-2 col-span-2">
                <Label htmlFor="notiz" className="flex items-center gap-1.5">
                  <IconNotes size={14} className="shrink-0 text-muted-foreground" />
                  {tx('Notiz')}
                </Label>
                <Input
                  id="notiz"
                  value={notiz}
                  onChange={e => setNotiz(e.target.value)}
                  placeholder={tx('Optional — z. B. Technik, Gefühl')}
                />
              </div>
            </div>

            {saveError && (
              <p className="text-sm text-destructive">{saveError}</p>
            )}

            <Button
              className="w-full"
              size="lg"
              disabled={!canSave || saving}
              onClick={handleSaveSatz}
            >
              {saving ? tx('Speichern …') : tx('Satz speichern')}
            </Button>
          </div>
        ) : (
          <div className="text-center py-12 space-y-3">
            <p className="text-sm text-muted-foreground">{tx('Bitte zuerst eine Übung wählen.')}</p>
            <Button variant="outline" onClick={() => setStep(1)}>{tx('Neu starten')}</Button>
          </div>
        )
      )}

      {/* ─── Schritt 3: Erfolg ─── */}
      {step === 3 && (
        savedSatz ? (
          <div className="space-y-6">
            {/* Erfolgs-Karte */}
            <div className="flex flex-col items-center text-center gap-3 py-6">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <IconCheck size={32} className="text-primary" stroke={2.5} />
              </div>
              <div>
                <h2 className="text-lg font-bold text-foreground">{tx('Satz gespeichert!')}</h2>
                <p className="text-sm text-muted-foreground mt-1">{savedSatz.uebungName}</p>
              </div>
              {/* Satz-Zusammenfassung */}
              <div className="grid grid-cols-3 gap-3 w-full max-w-xs mt-2">
                <div className="rounded-xl bg-secondary p-3 text-center">
                  <p className="text-xs text-muted-foreground">{tx('Satz')}</p>
                  <p className="text-xl font-bold text-foreground">{savedSatz.satzNummer}</p>
                </div>
                <div className="rounded-xl bg-secondary p-3 text-center">
                  <p className="text-xs text-muted-foreground">{tx('Gewicht')}</p>
                  <p className="text-xl font-bold text-foreground">{savedSatz.gewichtKg}</p>
                  <p className="text-xs text-muted-foreground">{tx('kg')}</p>
                </div>
                <div className="rounded-xl bg-secondary p-3 text-center">
                  <p className="text-xs text-muted-foreground">{tx('Wdh.')}</p>
                  <p className="text-xl font-bold text-foreground">{savedSatz.wiederholungen}</p>
                </div>
              </div>
            </div>

            {/* Aktionen */}
            <div className="flex flex-col gap-3">
              <Button
                size="lg"
                className="w-full"
                onClick={resetToStep2}
              >
                <IconRepeat size={16} className="shrink-0 mr-2" />
                {tx('Weiteren Satz loggen')}
              </Button>
              <Button
                variant="outline"
                size="lg"
                className="w-full"
                onClick={resetToStep1}
              >
                <IconDumbbell size={16} className="shrink-0 mr-2" />
                {tx('Neue Übung wählen')}
              </Button>
              <a
                href="#/"
                className="text-center text-sm text-muted-foreground hover:text-foreground transition-colors py-2"
              >
                {tx('Zurück zum Dashboard')}
              </a>
            </div>
          </div>
        ) : (
          <div className="text-center py-12 space-y-3">
            <p className="text-sm text-muted-foreground">{tx('Bitte Satz zuerst erfassen.')}</p>
            <Button variant="outline" onClick={() => setStep(selectedUebungId ? 2 : 1)}>{tx('Neu starten')}</Button>
          </div>
        )
      )}
    </IntentWizardShell>
  );
}

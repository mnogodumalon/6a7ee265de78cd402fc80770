/**
 * Satz erfassen — 2-Schritt-Wizard für One-Hand Mobile.
 * Steps: 1) Übung wählen (mit Muskelgruppe-Subtitle + "Neue Übung") →
 *        2) Satz-Details (Gewicht + Reps mit +/- Buttons, Auto-Satz-Nummer, optionale Notiz) →
 *        Bestätigung mit "Weiteren Satz" oder "Fertig".
 * Reads: uebungen, trainingslog. Writes: trainingslog (createTrainingslogEntry).
 * Composes: IntentWizardShell, EntitySelectStep.
 */
import { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { IntentWizardShell } from '@/components/blocks/IntentWizardShell';
import { EntitySelectStep } from '@/components/blocks/EntitySelectStep';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDashboardData } from '@/hooks/useDashboardData';
import type { Uebungen } from '@/types/app';
import { APP_IDS, LOOKUP_OPTIONS } from '@/types/app';
import { LivingAppsService, createRecordUrl } from '@/services/livingAppsService';
import { tx } from '@/i18n';
import {
  IconBarbell,
  IconPlus,
  IconMinus,
  IconCheck,
  IconChevronRight,
} from '@tabler/icons-react';

const MUSKELGRUPPE_OPTIONS = LOOKUP_OPTIONS['uebungen']?.['muskelgruppe'] ?? [];

export default function SatzErfassenPage() {
  const { uebungen, trainingslog, loading, error, fetchAll } = useDashboardData();

  // Step management
  const [step, setStep] = useState(1);

  // Step 1 state
  const [selectedUebung, setSelectedUebung] = useState<Uebungen | null>(null);
  const [showCreateUebung, setShowCreateUebung] = useState(false);
  const [newUebungName, setNewUebungName] = useState('');
  const [newUebungMuskelgruppe, setNewUebungMuskelgruppe] = useState('');

  // Step 2 state
  const [gewichtKg, setGewichtKg] = useState(20);
  const [wiederholungen, setWiederholungen] = useState(10);
  const [notiz, setNotiz] = useState('');
  const [notizOpen, setNotizOpen] = useState(false);
  const [manualSatzNummer, setManualSatzNummer] = useState<number | null>(null);

  // Step 3 (confirmation) state
  const [createdSatzNummer, setCreatedSatzNummer] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Auto-berechne Satz-Nummer: heutige Sätze für diese Übung + 1
  const autoSatzNummer = useMemo(() => {
    if (!selectedUebung) return 1;
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const todaySaetze = trainingslog.filter(log => {
      if (!log.fields.datum) return false;
      const datumStr = log.fields.datum.substring(0, 10);
      // Check if same exercise (applookup is a URL containing the record_id)
      const uebungUrl = log.fields.uebung ?? '';
      const isMatchingUebung = uebungUrl.includes(selectedUebung.record_id);
      return datumStr === todayStr && isMatchingUebung;
    });
    return todaySaetze.length + 1;
  }, [selectedUebung, trainingslog]);

  const effectiveSatzNummer = manualSatzNummer ?? autoSatzNummer;

  // Step 1: Übung wählen
  const handleUebungSelect = (id: string) => {
    const found = uebungen.find(u => u.record_id === id) ?? null;
    setSelectedUebung(found);
    setManualSatzNummer(null);
    setStep(2);
  };

  const handleCreateUebung = async () => {
    if (!newUebungName.trim()) return;
    const created = await LivingAppsService.createUebungenEntry({
      name: newUebungName.trim(),
      muskelgruppe: newUebungMuskelgruppe || undefined,
    });
    await fetchAll();
    setShowCreateUebung(false);
    setNewUebungName('');
    setNewUebungMuskelgruppe('');
    const freshUebung = uebungen.find(u => u.record_id === created.record_id) ?? {
      record_id: created.record_id,
      created_at: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
      updated_at: null,
      createdat: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
      updatedat: null,
      fields: { name: newUebungName.trim() },
    };
    setSelectedUebung(freshUebung as Uebungen);
    setManualSatzNummer(null);
    setStep(2);
  };

  // Step 2: Satz speichern
  const handleSave = async () => {
    if (!selectedUebung) return;
    setSaving(true);
    setSaveError(null);
    try {
      await LivingAppsService.createTrainingslogEntry({
        datum: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
        uebung: createRecordUrl(APP_IDS.UEBUNGEN, selectedUebung.record_id),
        satz_nummer: effectiveSatzNummer,
        gewicht_kg: gewichtKg,
        wiederholungen: wiederholungen,
        notiz: notiz.trim() || undefined,
      });
      await fetchAll();
      setCreatedSatzNummer(effectiveSatzNummer);
      setStep(3);
    } catch {
      setSaveError(tx('Fehler beim Speichern. Bitte nochmal versuchen.'));
    } finally {
      setSaving(false);
    }
  };

  // "Weiteren Satz" — zurück zu Step 2 mit gleicher Übung, Satz-Nummer +1
  const handleWeiterenSatz = () => {
    setManualSatzNummer(null);
    setNotiz('');
    setNotizOpen(false);
    setCreatedSatzNummer(null);
    setSaveError(null);
    setStep(2);
  };

  // "Neue Runde" — zurück zu Step 1
  const handleReset = () => {
    setSelectedUebung(null);
    setGewichtKg(20);
    setWiederholungen(10);
    setNotiz('');
    setNotizOpen(false);
    setManualSatzNummer(null);
    setCreatedSatzNummer(null);
    setSaveError(null);
    setStep(1);
  };

  return (
    <IntentWizardShell
      title={tx('Satz erfassen')}
      subtitle={tx('Übung wählen, dann Gewicht und Wiederholungen eingeben')}
      steps={[
        { label: tx('Übung') },
        { label: tx('Details') },
        { label: tx('Fertig') },
      ]}
      currentStep={step}
      onStepChange={setStep}
      loading={loading}
      error={error}
      onRetry={fetchAll}
    >
      {/* ── Step 1: Übung wählen ───────────────────────────────────────── */}
      {step === 1 && (
        <EntitySelectStep
          items={uebungen.map(u => ({
            id: u.record_id,
            title: u.fields.name ?? '',
            subtitle: u.fields.muskelgruppe?.label,
            icon: <IconBarbell size={20} className="text-primary" />,
          }))}
          onSelect={handleUebungSelect}
          searchPlaceholder={tx('Übung suchen …')}
          createLabel={tx('Neue Übung')}
          onCreateNew={() => setShowCreateUebung(true)}
          createDialog={showCreateUebung && (
            <div className="rounded-2xl border bg-card p-4 space-y-3">
              <p className="text-sm font-medium text-foreground">{tx('Neue Übung anlegen')}</p>
              <Input
                value={newUebungName}
                onChange={e => setNewUebungName(e.target.value)}
                placeholder={tx('Übungsname')}
                autoFocus
              />
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                value={newUebungMuskelgruppe}
                onChange={e => setNewUebungMuskelgruppe(e.target.value)}
              >
                <option value="">{tx('Muskelgruppe (optional)')}</option>
                {MUSKELGRUPPE_OPTIONS.map(opt => (
                  <option key={opt.key} value={opt.key}>{opt.label}</option>
                ))}
              </select>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => { setShowCreateUebung(false); setNewUebungName(''); setNewUebungMuskelgruppe(''); }}
                >
                  {tx('Abbrechen')}
                </Button>
                <Button
                  className="flex-1"
                  disabled={!newUebungName.trim()}
                  onClick={handleCreateUebung}
                >
                  {tx('Anlegen & wählen')}
                </Button>
              </div>
            </div>
          )}
          emptyText={tx('Keine Übungen gefunden')}
          emptyIcon={<IconBarbell size={40} className="text-muted-foreground" />}
        />
      )}

      {/* ── Step 2: Satz-Details ───────────────────────────────────────── */}
      {step === 2 && (
        selectedUebung ? (
          <div className="space-y-6 pb-8">
            {/* Übungsname + Satz-Nummer */}
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">{tx('Übung')}</p>
                <p className="text-lg font-semibold text-foreground">{selectedUebung.fields.name}</p>
                {selectedUebung.fields.muskelgruppe && (
                  <p className="text-sm text-muted-foreground">{selectedUebung.fields.muskelgruppe.label}</p>
                )}
              </div>
              {/* Satz-Nummer Badge — tappable to edit */}
              <button
                className="flex flex-col items-center justify-center rounded-2xl border-2 border-primary/30 bg-primary/5 px-4 py-2 min-w-[72px] touch-manipulation"
                onClick={() => {
                  const input = prompt(tx('Satz-Nummer:'), String(effectiveSatzNummer));
                  const parsed = input ? parseInt(input, 10) : null;
                  if (parsed && !isNaN(parsed) && parsed > 0) setManualSatzNummer(parsed);
                }}
                title={tx('Satz-Nummer tippen zum Ändern')}
              >
                <span className="text-2xl font-bold text-primary leading-none">{effectiveSatzNummer}</span>
                <span className="text-[10px] text-muted-foreground mt-0.5 uppercase tracking-wide">{tx('Satz')}</span>
              </button>
            </div>

            {/* Gewicht */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">{tx('Gewicht (kg)')}</label>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-14 w-14 rounded-2xl text-xl shrink-0 touch-manipulation"
                  onClick={() => setGewichtKg(v => Math.max(0, Math.round((v - 0.5) * 10) / 10))}
                >
                  <IconMinus size={22} />
                </Button>
                <div className="flex-1 flex items-center justify-center rounded-2xl border bg-card h-14">
                  <span className="text-3xl font-bold tabular-nums">{gewichtKg}</span>
                  <span className="text-sm text-muted-foreground ml-1.5 self-end mb-1.5">{tx('kg')}</span>
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-14 w-14 rounded-2xl text-xl shrink-0 touch-manipulation"
                  onClick={() => setGewichtKg(v => Math.round((v + 0.5) * 10) / 10)}
                >
                  <IconPlus size={22} />
                </Button>
              </div>
              {/* Quick-preset buttons */}
              <div className="flex gap-2 flex-wrap">
                {[5, 10, 20, 40, 60, 80, 100].map(val => (
                  <button
                    key={val}
                    className={`rounded-xl border px-3 py-1.5 text-sm font-medium transition-colors touch-manipulation ${gewichtKg === val ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-foreground hover:bg-secondary'}`}
                    onClick={() => setGewichtKg(val)}
                  >
                    {val}
                  </button>
                ))}
              </div>
            </div>

            {/* Wiederholungen */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">{tx('Wiederholungen')}</label>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-14 w-14 rounded-2xl text-xl shrink-0 touch-manipulation"
                  onClick={() => setWiederholungen(v => Math.max(1, v - 1))}
                >
                  <IconMinus size={22} />
                </Button>
                <div className="flex-1 flex items-center justify-center rounded-2xl border bg-card h-14">
                  <span className="text-3xl font-bold tabular-nums">{wiederholungen}</span>
                  <span className="text-sm text-muted-foreground ml-1.5 self-end mb-1.5">{tx('Reps')}</span>
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-14 w-14 rounded-2xl text-xl shrink-0 touch-manipulation"
                  onClick={() => setWiederholungen(v => v + 1)}
                >
                  <IconPlus size={22} />
                </Button>
              </div>
              {/* Quick-preset buttons */}
              <div className="flex gap-2 flex-wrap">
                {[5, 6, 8, 10, 12, 15, 20].map(val => (
                  <button
                    key={val}
                    className={`rounded-xl border px-3 py-1.5 text-sm font-medium transition-colors touch-manipulation ${wiederholungen === val ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-foreground hover:bg-secondary'}`}
                    onClick={() => setWiederholungen(val)}
                  >
                    {val}
                  </button>
                ))}
              </div>
            </div>

            {/* Notiz (einklappbar) */}
            <div>
              <button
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors touch-manipulation"
                onClick={() => setNotizOpen(o => !o)}
              >
                <IconChevronRight
                  size={16}
                  className={`transition-transform shrink-0 ${notizOpen ? 'rotate-90' : ''}`}
                />
                {tx('Notiz hinzufügen (optional)')}
              </button>
              {notizOpen && (
                <div className="mt-2">
                  <Input
                    value={notiz}
                    onChange={e => setNotiz(e.target.value)}
                    placeholder={tx('z. B. Technik verbessern, Pause 90s …')}
                    className="w-full"
                  />
                </div>
              )}
            </div>

            {/* Error */}
            {saveError && (
              <p className="text-sm text-destructive">{saveError}</p>
            )}

            {/* Actions */}
            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setStep(1)}
              >
                {tx('Übung ändern')}
              </Button>
              <Button
                className="flex-1 h-12 text-base font-semibold"
                disabled={saving}
                onClick={handleSave}
              >
                {saving ? tx('Speichern …') : tx('Satz speichern')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-center py-12 space-y-3">
            <p className="text-sm text-muted-foreground">{tx('Dieser Schritt braucht die Auswahl aus Schritt 1.')}</p>
            <Button variant="outline" onClick={() => setStep(1)}>{tx('Neu starten')}</Button>
          </div>
        )
      )}

      {/* ── Step 3: Bestätigung ───────────────────────────────────────── */}
      {step === 3 && (
        selectedUebung ? (
          <div className="flex flex-col items-center text-center py-8 space-y-6">
            {/* Success icon */}
            <div className="flex items-center justify-center w-20 h-20 rounded-full bg-primary/10">
              <IconCheck size={40} className="text-primary" stroke={2} />
            </div>

            {/* Summary */}
            <div className="space-y-1">
              <p className="text-xl font-bold text-foreground">
                {tx('Satz gespeichert!')}
              </p>
              <p className="text-muted-foreground">
                {selectedUebung.fields.name} — {tx('Satz')} {createdSatzNummer}
              </p>
              <p className="text-lg font-semibold text-primary mt-1">
                {gewichtKg} {tx('kg ×')} {wiederholungen} {tx('Reps')}
              </p>
              {notiz.trim() && (
                <p className="text-sm text-muted-foreground italic mt-1">{notiz}</p>
              )}
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-3 w-full max-w-xs">
              <Button
                className="w-full h-12 text-base font-semibold"
                onClick={handleWeiterenSatz}
              >
                {tx('Weiteren Satz')}
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={handleReset}
              >
                {tx('Neue Übung wählen')}
              </Button>
              <a
                href="#/"
                className="text-sm text-muted-foreground hover:text-foreground transition-colors mt-1"
              >
                {tx('Zurück zum Dashboard')}
              </a>
            </div>
          </div>
        ) : (
          <div className="text-center py-12 space-y-3">
            <p className="text-sm text-muted-foreground">{tx('Dieser Schritt braucht die Auswahl aus Schritt 1.')}</p>
            <Button variant="outline" onClick={() => setStep(1)}>{tx('Neu starten')}</Button>
          </div>
        )
      )}
    </IntentWizardShell>
  );
}

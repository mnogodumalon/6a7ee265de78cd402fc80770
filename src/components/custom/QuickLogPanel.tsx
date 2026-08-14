/**
 * Mobile-first 2-tap quick-log panel for logging a training set.
 * @prop exercises - Available exercises to choose from (id, name, optional muskelgruppe)
 * @prop onLog - Called with the completed set payload ready to POST
 * @prop nextSetNumber - Returns the auto-incremented set number for a given exerciseId
 * @prop saving - When true, the submit button shows a spinner and is disabled
 */

import { useState } from 'react';
import { tx, dateFnsLocale } from '@/i18n';
import {
  IconArrowLeft,
  IconPlus,
  IconMinus,
  IconBarbell,
  IconCheck,
} from '@tabler/icons-react';

export interface QuickLogPanelProps {
  /** Available exercises to choose from */
  exercises: Array<{ id: string; name: string; muskelgruppe?: string }>;
  /** Called when the user submits a set — payload is ready to POST */
  onLog: (payload: { exerciseId: string; satz_nummer: number; gewicht_kg: number; wiederholungen: number }) => void;
  /** Current set number for the selected exercise (auto-incremented: last set + 1) */
  nextSetNumber: (exerciseId: string) => number;
  /** True while saving */
  saving?: boolean;
}

export function QuickLogPanel({ exercises, onLog, nextSetNumber, saving = false }: QuickLogPanelProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [gewicht, setGewicht] = useState(20);
  const [wiederholungen, setWiederholungen] = useState(10);

  const selectedExercise = exercises.find(e => e.id === selectedId) ?? null;

  function handleSelectExercise(id: string) {
    setSelectedId(id);
    setGewicht(20);
    setWiederholungen(10);
    setStep(2);
  }

  function handleBack() {
    setStep(1);
    setSelectedId(null);
  }

  function handleSubmit() {
    if (!selectedId || saving) return;
    onLog({
      exerciseId: selectedId,
      satz_nummer: nextSetNumber(selectedId),
      gewicht_kg: gewicht,
      wiederholungen,
    });
  }

  function adjustGewicht(delta: number) {
    setGewicht(prev => Math.max(0, Math.round((prev + delta) * 10) / 10));
  }

  function adjustWiederholungen(delta: number) {
    setWiederholungen(prev => Math.max(1, prev + delta));
  }

  if (step === 1) {
    return (
      <div className="flex flex-col gap-4 p-4 bg-card rounded-2xl border border-border">
        <div className="flex items-center gap-2">
          <IconBarbell size={20} className="text-primary shrink-0" />
          <h2 className="text-base font-semibold text-foreground">{tx('Übung wählen')}</h2>
        </div>

        {exercises.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <IconBarbell size={48} className="text-muted-foreground" stroke={1.5} />
            <p className="text-sm text-muted-foreground">{tx('Keine Übungen verfügbar')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 max-h-80 overflow-y-auto pr-1">
            {exercises.map(ex => (
              <button
                key={ex.id}
                type="button"
                onClick={() => handleSelectExercise(ex.id)}
                className="flex flex-col gap-0.5 items-start text-left px-3 py-3 rounded-xl border border-border bg-background hover:bg-primary/5 active:bg-primary/10 transition-colors min-h-[56px]"
                aria-label={tx('Übung auswählen') + ': ' + ex.name}
              >
                <span className="text-sm font-medium text-foreground leading-snug line-clamp-2">
                  {ex.name}
                </span>
                {ex.muskelgruppe && (
                  <span className="text-xs text-muted-foreground truncate w-full">
                    {ex.muskelgruppe}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Step 2
  const satzNummer = selectedId ? nextSetNumber(selectedId) : 1;

  return (
    <div className="flex flex-col gap-5 p-4 bg-card rounded-2xl border border-border">
      {/* Header with back */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center justify-center w-9 h-9 rounded-xl border border-border bg-background hover:bg-muted active:bg-muted/80 transition-colors shrink-0"
          aria-label={tx('Zurück zur Übungsauswahl')}
        >
          <IconArrowLeft size={18} />
        </button>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground truncate">
            {selectedExercise?.name ?? ''}
          </h2>
          {selectedExercise?.muskelgruppe && (
            <p className="text-xs text-muted-foreground truncate">
              {selectedExercise.muskelgruppe}
            </p>
          )}
        </div>
      </div>

      {/* Rows */}
      <div className="flex flex-col gap-4">
        {/* Gewicht */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-foreground shrink-0">
            {tx('Gewicht (kg)')}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => adjustGewicht(-0.5)}
              disabled={gewicht <= 0}
              className="flex items-center justify-center w-11 h-11 rounded-xl border border-border bg-background hover:bg-muted active:bg-muted/80 disabled:opacity-40 disabled:pointer-events-none transition-colors shrink-0"
              aria-label={tx('Gewicht verringern')}
            >
              <IconMinus size={18} />
            </button>
            <span className="w-14 text-center text-base font-semibold tabular-nums text-foreground">
              {gewicht % 1 === 0 ? gewicht.toFixed(0) : gewicht.toFixed(1)}
            </span>
            <button
              type="button"
              onClick={() => adjustGewicht(0.5)}
              className="flex items-center justify-center w-11 h-11 rounded-xl border border-border bg-background hover:bg-muted active:bg-muted/80 transition-colors shrink-0"
              aria-label={tx('Gewicht erhöhen')}
            >
              <IconPlus size={18} />
            </button>
          </div>
        </div>

        {/* Wiederholungen */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-foreground shrink-0">
            {tx('Wiederholungen')}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => adjustWiederholungen(-1)}
              disabled={wiederholungen <= 1}
              className="flex items-center justify-center w-11 h-11 rounded-xl border border-border bg-background hover:bg-muted active:bg-muted/80 disabled:opacity-40 disabled:pointer-events-none transition-colors shrink-0"
              aria-label={tx('Wiederholungen verringern')}
            >
              <IconMinus size={18} />
            </button>
            <span className="w-14 text-center text-base font-semibold tabular-nums text-foreground">
              {wiederholungen}
            </span>
            <button
              type="button"
              onClick={() => adjustWiederholungen(1)}
              className="flex items-center justify-center w-11 h-11 rounded-xl border border-border bg-background hover:bg-muted active:bg-muted/80 transition-colors shrink-0"
              aria-label={tx('Wiederholungen erhöhen')}
            >
              <IconPlus size={18} />
            </button>
          </div>
        </div>

        {/* Satznummer (read-only) */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-foreground shrink-0">
            {tx('Satznummer')}
          </span>
          <span className="text-base font-semibold tabular-nums text-muted-foreground pr-1">
            {satzNummer}
          </span>
        </div>
      </div>

      {/* Submit */}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={saving}
        className="flex items-center justify-center gap-2 w-full h-12 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 active:bg-primary/80 disabled:opacity-60 disabled:pointer-events-none transition-colors"
        aria-label={tx('Satz speichern')}
      >
        {saving ? (
          <span
            className="w-5 h-5 border-2 border-primary-foreground/40 border-t-primary-foreground rounded-full animate-spin"
            role="status"
            aria-label={tx('Wird gespeichert')}
          />
        ) : (
          <IconCheck size={18} className="shrink-0" />
        )}
        {tx('Satz speichern')}
      </button>
    </div>
  );
}

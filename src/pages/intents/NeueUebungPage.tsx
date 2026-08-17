/**
 * Neue Übung anlegen — 1-Schritt-Wizard.
 * Steps: 1) Übung definieren (Name, Muskelgruppe, Notizen) → Bestätigung.
 * Reads: (keine). Writes: uebungen (createUebungenEntry).
 * Composes: IntentWizardShell.
 */

import { useState } from 'react';
import { IntentWizardShell } from '@/components/blocks/IntentWizardShell';
import { useDashboardData } from '@/hooks/useDashboardData';
import { LOOKUP_OPTIONS } from '@/types/app';
import { LivingAppsService } from '@/services/livingAppsService';
import { tx } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { IconBarbell, IconChevronDown, IconChevronUp, IconCheck } from '@tabler/icons-react';

export default function NeueUebungPage() {
  const { loading, error, fetchAll } = useDashboardData();

  const [step, setStep] = useState(1);

  // Formularfelder
  const [name, setName] = useState('');
  const [muskelgruppe, setMuskelgruppe] = useState('none');
  const [notizen, setNotizen] = useState('');
  const [notizenOpen, setNotizenOpen] = useState(false);

  // Submit-Status
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState<string | null>(null);

  const MUSKELGRUPPEN = LOOKUP_OPTIONS['uebungen']?.['muskelgruppe'] ?? [];

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await LivingAppsService.createUebungenEntry({
        name: name.trim(),
        muskelgruppe: muskelgruppe !== 'none' ? muskelgruppe : undefined,
        notizen: notizen.trim() || undefined,
      });
      await fetchAll();
      setCreatedName(name.trim());
      setStep(2);
    } catch {
      setSubmitError(tx('Fehler beim Anlegen. Bitte erneut versuchen.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = () => {
    setName('');
    setMuskelgruppe('none');
    setNotizen('');
    setNotizenOpen(false);
    setCreatedName(null);
    setSubmitError(null);
    setStep(1);
  };

  return (
    <IntentWizardShell
      title={tx('Neue Übung anlegen')}
      subtitle={tx('Definiere eine Übung für dein Training')}
      steps={[{ label: tx('Übung definieren') }, { label: tx('Fertig') }]}
      currentStep={step}
      onStepChange={setStep}
      loading={loading}
      error={error}
      onRetry={fetchAll}
    >
      {/* ─── Schritt 1: Übung definieren ─── */}
      {step === 1 && (
        <div className="space-y-6 max-w-lg mx-auto">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="uebung-name" className="text-base font-semibold">
              {tx('Name der Übung')}
              <span className="text-destructive ml-1">*</span>
            </Label>
            <Input
              id="uebung-name"
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={tx('z. B. Bankdrücken, Kniebeugen …')}
              className="text-lg h-12"
              onKeyDown={e => {
                if (e.key === 'Enter' && name.trim()) handleSubmit();
              }}
            />
          </div>

          {/* Muskelgruppe */}
          <div className="space-y-2">
            <Label className="text-base font-semibold">
              {tx('Muskelgruppe')}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {tx('(empfohlen)')}
              </span>
            </Label>
            <Select value={muskelgruppe} onValueChange={setMuskelgruppe}>
              <SelectTrigger className="h-11">
                <SelectValue placeholder={tx('Muskelgruppe wählen …')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{tx('Keine Angabe')}</SelectItem>
                {MUSKELGRUPPEN.map(opt => (
                  <SelectItem key={opt.key} value={opt.key}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Notizen — einklappbar */}
          <div className="space-y-2">
            <button
              type="button"
              className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setNotizenOpen(v => !v)}
            >
              {notizenOpen ? (
                <IconChevronUp size={16} className="shrink-0" />
              ) : (
                <IconChevronDown size={16} className="shrink-0" />
              )}
              {tx('Notizen hinzufügen')}
            </button>
            {notizenOpen && (
              <Textarea
                value={notizen}
                onChange={e => setNotizen(e.target.value)}
                placeholder={tx('Tipps, Varianten, Ausführungshinweise …')}
                rows={4}
              />
            )}
          </div>

          {submitError && (
            <p className="text-sm text-destructive">{submitError}</p>
          )}

          <Button
            className="w-full h-12 text-base"
            disabled={!name.trim() || submitting}
            onClick={handleSubmit}
          >
            {submitting ? tx('Wird angelegt …') : tx('Übung anlegen')}
          </Button>
        </div>
      )}

      {/* ─── Schritt 2: Bestätigung ─── */}
      {step === 2 && (
        <div className="flex flex-col items-center text-center gap-6 max-w-md mx-auto py-8">
          <div className="rounded-full bg-primary/10 p-5">
            {createdName ? (
              <IconCheck size={48} className="text-primary" stroke={1.5} />
            ) : (
              <IconBarbell size={48} className="text-muted-foreground" stroke={1.5} />
            )}
          </div>

          {createdName ? (
            <>
              <div className="space-y-2">
                <h2 className="text-xl font-bold">
                  {tx('Übung angelegt!')}
                </h2>
                <p className="text-muted-foreground">
                  <span className="font-semibold text-foreground">{createdName}</span>
                  {tx(' wurde erfolgreich hinzugefügt.')}
                </p>
              </div>

              <div className="flex flex-col gap-3 w-full">
                <Button
                  className="w-full"
                  asChild
                >
                  <a href="#/intents/satz-erfassen">{tx('Übung trainieren')}</a>
                </Button>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={handleReset}
                >
                  {tx('Weitere Übung anlegen')}
                </Button>
                <Button
                  variant="ghost"
                  className="w-full"
                  asChild
                >
                  <a href="#/">{tx('Fertig')}</a>
                </Button>
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {tx('Dieser Schritt braucht die Eingabe aus Schritt 1.')}
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

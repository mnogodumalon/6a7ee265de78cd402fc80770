/**
 * Übung anlegen — 1-Schritt-Wizard.
 * Steps: 1) Übungsformular ausfüllen & speichern.
 * Reads: — (kein Vorauswahl-Step).
 * Writes: uebungen (createUebungenEntry).
 * Composes: IntentWizardShell.
 */

import { useState } from 'react';
import { IntentWizardShell } from '@/components/blocks/IntentWizardShell';
import { useDashboardData } from '@/hooks/useDashboardData';
import { LivingAppsService } from '@/services/livingAppsService';
import { LOOKUP_OPTIONS } from '@/types/app';
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
import { IconBarbell, IconCheck, IconPlus } from '@tabler/icons-react';

export default function UebungAnlegenPage() {
  const { loading, error, fetchAll } = useDashboardData();

  const [name, setName] = useState('');
  const [muskelgruppeKey, setMuskelgruppeKey] = useState('none');
  const [notizen, setNotizen] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState<string | null>(null);

  const muskelgruppeOptions = LOOKUP_OPTIONS['uebungen']?.['muskelgruppe'] ?? [];

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await LivingAppsService.createUebungenEntry({
        name: name.trim(),
        muskelgruppe: muskelgruppeKey !== 'none' ? muskelgruppeKey : undefined,
        notizen: notizen.trim() || undefined,
      });
      await fetchAll();
      setCreatedName(name.trim());
    } catch {
      setSubmitError(tx('Fehler beim Anlegen. Bitte nochmal versuchen.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = () => {
    setName('');
    setMuskelgruppeKey('none');
    setNotizen('');
    setSubmitError(null);
    setCreatedName(null);
  };

  return (
    <IntentWizardShell
      title={tx('Übung anlegen')}
      subtitle={tx('Neue Übung schnell erfassen')}
      steps={[{ label: tx('Übung anlegen') }]}
      currentStep={1}
      onStepChange={() => undefined}
      loading={loading}
      error={error}
      onRetry={fetchAll}
    >
      {createdName ? (
        <div className="flex flex-col items-center justify-center py-16 space-y-6 text-center">
          <div className="rounded-full bg-primary/10 p-5">
            <IconCheck size={48} className="text-primary" stroke={1.5} />
          </div>
          <div className="space-y-1">
            <h2 className="text-xl font-semibold">
              {tx('Übung angelegt')}
            </h2>
            <p className="text-muted-foreground text-sm">
              {/* i18n-exempt */}
              {createdName}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 w-full max-w-xs">
            <Button
              className="flex-1"
              onClick={() => { window.location.hash = '/intents/satz-erfassen'; }}
            >
              {tx('Jetzt trainieren')}
            </Button>
            <Button variant="outline" className="flex-1" onClick={handleReset}>
              <IconPlus size={16} className="shrink-0 mr-1" />
              {tx('Weitere Übung anlegen')}
            </Button>
          </div>
          <a
            href="#/"
            className="text-sm text-muted-foreground underline underline-offset-4"
          >
            {tx('Zurück zum Dashboard')}
          </a>
        </div>
      ) : (
        <div className="max-w-lg mx-auto space-y-6 py-4">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="uebung-name">
                {tx('Name')}
                <span className="text-destructive ml-1">*</span>
              </Label>
              <div className="flex items-center gap-2">
                <IconBarbell size={18} className="shrink-0 text-muted-foreground" />
                <Input
                  id="uebung-name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={tx('z. B. Bankdrücken')}
                  autoFocus
                  onKeyDown={e => { if (e.key === 'Enter' && name.trim()) handleSubmit(); }}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="uebung-muskelgruppe">
                {tx('Muskelgruppe')}
              </Label>
              <Select value={muskelgruppeKey} onValueChange={setMuskelgruppeKey}>
                <SelectTrigger id="uebung-muskelgruppe" className="w-full">
                  <SelectValue placeholder={tx('Muskelgruppe wählen')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{tx('Keine Angabe')}</SelectItem>
                  {muskelgruppeOptions.map(opt => (
                    <SelectItem key={opt.key} value={opt.key}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="uebung-notizen">
                {tx('Notizen')}
              </Label>
              <Textarea
                id="uebung-notizen"
                value={notizen}
                onChange={e => setNotizen(e.target.value)}
                placeholder={tx('Hinweise zur Ausführung…')}
                rows={3}
              />
            </div>
          </div>

          {submitError && (
            <p className="text-sm text-destructive">{submitError}</p>
          )}

          <div className="flex flex-col sm:flex-row gap-3">
            <Button
              className="flex-1"
              disabled={!name.trim() || submitting}
              onClick={handleSubmit}
            >
              {submitting ? tx('Wird angelegt…') : tx('Übung anlegen')}
            </Button>
            <a href="#/" className="sm:hidden">
              <Button variant="outline" className="w-full">
                {tx('Abbrechen')}
              </Button>
            </a>
          </div>
        </div>
      )}
    </IntentWizardShell>
  );
}

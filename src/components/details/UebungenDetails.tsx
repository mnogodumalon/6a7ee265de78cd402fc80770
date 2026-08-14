import type { Uebungen, Trainingslog } from '@/types/app';
import { APP_IDS } from '@/types/app';
import { extractRecordId } from '@/services/livingAppsService';
import {
  RecordSection, RecordField, RecordRelation, RecordAttachments,
} from '@/components/widgets/RecordView';
import { t, appLabel, fieldLabel } from '@/i18n';
import { SatelliteSection } from '@/components/SatelliteSection';

export interface UebungenDetailsProps {
  /** Der Record — enriched oder roh; alle Felder werden hier gerendert. */
  record: Uebungen;
  /** 1:N „Trainingslog": VOLLE Liste — der Block filtert auf diesen Record. */
  trainingslogList: Trainingslog[];
  /** Zeilen-Klick → overlay.push auf das Trainingslog-Detail (nie der Edit-Dialog). */
  onOpenTrainingslog: (record: Trainingslog) => void;
  /** Kontextuelles „+": öffnet den Trainingslog-Dialog mit diesem Record vorgesetzt. */
  onAddTrainingslog: () => void;
}

export function UebungenDetails({
  record,
  trainingslogList,
  onOpenTrainingslog,
  onAddTrainingslog,
}: UebungenDetailsProps) {
  return (
    <>
      <RecordSection title={t('details')} cols={2}>
        <RecordField label={fieldLabel('uebungen', 'name')} value={record.fields.name} format="text" />
        <RecordField label={fieldLabel('uebungen', 'muskelgruppe')} value={record.fields.muskelgruppe} format="pill" />
        <RecordField label={fieldLabel('uebungen', 'notizen')} value={record.fields.notizen} format="longtext" className="md:col-span-2" />
      </RecordSection>

      <SatelliteSection
        title={appLabel('trainingslog')}
        items={trainingslogList.filter(r => extractRecordId(r.fields.uebung) === record.record_id)}
        map={r => ({ name: r.fields.notiz ?? appLabel('trainingslog'), meta: r.fields.datum })}
        onOpen={onOpenTrainingslog}
        onAdd={onAddTrainingslog}
        getKey={r => r.record_id}
      />

      <RecordAttachments appId={APP_IDS.UEBUNGEN} recordId={record.record_id} />
    </>
  );
}

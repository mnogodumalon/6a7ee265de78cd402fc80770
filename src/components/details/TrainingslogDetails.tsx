import type { Trainingslog, Uebungen } from '@/types/app';
import { APP_IDS } from '@/types/app';
import { extractRecordId } from '@/services/livingAppsService';
import {
  RecordSection, RecordField, RecordRelation, RecordAttachments,
} from '@/components/widgets/RecordView';
import { t, appLabel, fieldLabel } from '@/i18n';

export interface TrainingslogDetailsProps {
  /** Der Record — enriched oder roh; alle Felder werden hier gerendert. */
  record: Trainingslog;
  /** N:1-Ziel „Uebungen": volle Liste (Hook-Array) — der Block löst Name + Schlüsselfelder selbst auf. */
  uebungenList: Uebungen[];
  /** Klick auf die Uebungen-Relation → overlay.push auf dessen Detail. */
  onOpenUebungen?: (record: Uebungen) => void;
}

export function TrainingslogDetails({
  record,
  uebungenList,
  onOpenUebungen,
}: TrainingslogDetailsProps) {
  const uebungTarget = uebungenList.find(r => r.record_id === extractRecordId(record.fields.uebung));
  return (
    <>
      <RecordSection title={t('details')} cols={2}>
        <RecordField label={fieldLabel('trainingslog', 'datum')} value={record.fields.datum} format="datetime" />
        <RecordField label={fieldLabel('trainingslog', 'satz_nummer')} value={record.fields.satz_nummer} format="text" />
        <RecordField label={fieldLabel('trainingslog', 'gewicht_kg')} value={record.fields.gewicht_kg} format="text" />
        <RecordField label={fieldLabel('trainingslog', 'wiederholungen')} value={record.fields.wiederholungen} format="text" />
        <RecordField label={fieldLabel('trainingslog', 'notiz')} value={record.fields.notiz} format="text" />
      </RecordSection>

      {/* N:1 — verknüpfte Records: IMMER klickbar, nie eine Text-Sackgasse. */}
      <RecordSection title={t('relations')} cols={1}>
        <RecordRelation
          label={fieldLabel('trainingslog', 'uebung')}
          name={uebungTarget?.fields.name ?? '—'}
          meta={undefined}
          onClick={uebungTarget && onOpenUebungen ? () => onOpenUebungen!(uebungTarget!) : undefined}
        />
      </RecordSection>

      <RecordAttachments appId={APP_IDS.TRAININGSLOG} recordId={record.record_id} />
    </>
  );
}

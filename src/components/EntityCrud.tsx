/**
 * EntityCrud — pre-generated CRUD + overlay plumbing for the dashboard.
 * Compose it; NEVER re-roll dialog state, submit handlers, an overlay stack
 * or a RecordOverlayHost in the page — this file owns all of it.
 *
 * API at a glance:
 *   const data = useDashboardData();
 *   const crud = useEntityCrud(data, {
 *     // optional — the ONE semantic slot on the overlay: the record's next
 *     // workflow step. Return undefined for types without one.
 *     footer: (top) => top.type === 'uebungen'
 *       ? { label: …, onClick: () => … }
 *       : undefined,
 *   });
 *   …
 *   crud.uebungen.openCreate({ …defaults })   // create dialog, prefilled — defaults are
 *                                       // shape-tolerant: bare lookup keys / record ids are fine
 *   crud.uebungen.openEdit(record)            // edit dialog (recordId + defaults wired)
 *   crud.uebungen.openDetail(record)          // record overlay — pass the RAW record,
 *                                       // enrichment is resolved inside
 *   crud.overlay                         // RecordOverlayStack<OverlayItem> for drills:
 *                                       // push / pop / replace / close
 *   crud.enriched.trainingslog              // memoized Enriched* arrays — reuse these,
 *                                       // never call enrich*() yourself in the page
 *   {crud.surfaces}                      // render ONCE at the end of the page JSX:
 *                                       // all entity dialogs + the overlay host
 *
 * Built in (do NOT re-implement): optimistic update + Rückgängig counter-write
 * on edit, fetchAll-on-error, edit-from-overlay, and per-entity overlay bodies
 * (RecordHeader + <{Entity}Details> with every relation reachable and the
 * contextual "+" prefilled). Drag writes (onEventDrop/onCardMove) stay YOURS:
 * optimistic setter first, PATCH in background, undoToast with counter-write.
 *
 * Overlay content per entity (the host renders these — you never compose
 * Details blocks yourself):
 *   uebungen: name, muskelgruppe, notizen  ·  ← trainingslog (list + contextual +)
 *   trainingslog: datum, uebung, satz_nummer, gewicht_kg, wiederholungen, notiz  ·  → uebungen
 */
import { useState, useMemo, type ReactNode } from 'react';
import type { Uebungen, Trainingslog } from '@/types/app';
import { APP_IDS } from '@/types/app';
import { LivingAppsService, createRecordUrl } from '@/services/livingAppsService';
import { enrichTrainingslog } from '@/lib/enrich';
import type { EnrichedTrainingslog } from '@/types/enriched';
import { useDashboardData } from '@/hooks/useDashboardData';
import {
  useRecordOverlayStack, RecordOverlayHost, RecordHeader,
  type RecordOverlayStack,
} from '@/components/widgets/RecordView';
import { UebungenDialog, type UebungenDialogDefaults } from '@/components/dialogs/UebungenDialog';
import { UebungenDetails } from '@/components/details/UebungenDetails';
import { TrainingslogDialog, type TrainingslogDialogDefaults } from '@/components/dialogs/TrainingslogDialog';
import { TrainingslogDetails } from '@/components/details/TrainingslogDetails';
import { AI_PHOTO_SCAN, AI_PHOTO_LOCATION } from '@/config/ai-features';
import { t, appLabel } from '@/i18n';
import { undoToast } from '@/lib/polish';
import { formatDate } from '@/lib/formatters';

// The overlay union — one branch per entity, `record` typed the way the data
// flows: Enriched* where enrichment exists, the raw record type otherwise.
// The host resolves enrichment itself; pages pass raw records everywhere.
export type OverlayItem =
  | { type: 'uebungen'; record: Uebungen }
  | { type: 'trainingslog'; record: EnrichedTrainingslog };

/** The useDashboardData() return — pass it in, never re-fetch inside. */
export type EntityCrudData = ReturnType<typeof useDashboardData>;

export interface EntityCrudOptions {
  /** Per-type overlay footer — the record's next workflow step. */
  footer?: (top: OverlayItem) => ReactNode | { label: ReactNode; onClick: () => void } | undefined;
  placement?: 'side' | 'center';
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

export interface EntityCrudApi<TRecord, TDefaults> {
  /** Open the create dialog, optionally prefilled (shape-tolerant defaults). */
  openCreate: (defaults?: TDefaults) => void;
  /** Open the edit dialog for a record (recordId + defaults are wired). */
  openEdit: (record: TRecord) => void;
  /** Open the record overlay (raw record is fine — enrichment resolved inside). */
  openDetail: (record: TRecord) => void;
}

export interface EntityCrud {
  /** The overlay stack for drills: push / pop / replace / close. */
  overlay: RecordOverlayStack<OverlayItem>;
  /** Render ONCE at the end of the page JSX — all dialogs + the overlay host. */
  surfaces: ReactNode;
  uebungen: EntityCrudApi<Uebungen, UebungenDialogDefaults>;
  trainingslog: EntityCrudApi<Trainingslog, TrainingslogDialogDefaults>;
  /** Memoized Enriched* arrays — reuse these, never re-enrich in the page. */
  enriched: { trainingslog: EnrichedTrainingslog[] };
}

export function useEntityCrud(data: EntityCrudData, options?: EntityCrudOptions): EntityCrud {
  const overlay = useRecordOverlayStack<OverlayItem>();
  const [uebungenDialog, setUebungenDialog] = useState<{ defaults?: UebungenDialogDefaults; editing?: Uebungen } | null>(null);
  const [trainingslogDialog, setTrainingslogDialog] = useState<{ defaults?: TrainingslogDialogDefaults; editing?: Trainingslog } | null>(null);
  const enrichedTrainingslog = useMemo(() => enrichTrainingslog(data.trainingslog, { uebungenMap: data.uebungenMap }), [data.trainingslog, data.uebungenMap]);

  function detailUebungen(record: Uebungen, push = false) {
    const item: OverlayItem = { type: 'uebungen', record };
    if (push) overlay.push(item); else overlay.replace(item);
  }

  async function submitUebungen(fields: Uebungen['fields']) {
    const editing = uebungenDialog?.editing;
    if (editing) {
      const prev = editing;
      data.setUebungen(list => list.map(r => (r.record_id === editing.record_id ? { ...r, fields } : r)));
      try {
        await LivingAppsService.updateUebungenEntry(editing.record_id, fields);
      } catch (err) {
        data.fetchAll();
        throw err;
      }
      undoToast(`${appLabel('uebungen')} — ${t('crud_updated')}`, async () => {
        data.setUebungen(list => list.map(r => (r.record_id === prev.record_id ? prev : r)));
        try { await LivingAppsService.updateUebungenEntry(prev.record_id, prev.fields); } catch { data.fetchAll(); }
      });
    } else {
      await LivingAppsService.createUebungenEntry(fields);
      undoToast(`${appLabel('uebungen')} — ${t('crud_created')}`);
      data.fetchAll();
    }
  }

  function detailTrainingslog(record: Trainingslog, push = false) {
    const rec = enrichedTrainingslog.find(r => r.record_id === record.record_id);
    if (!rec) return;
    const item: OverlayItem = { type: 'trainingslog', record: rec };
    if (push) overlay.push(item); else overlay.replace(item);
  }

  async function submitTrainingslog(fields: Trainingslog['fields']) {
    const editing = trainingslogDialog?.editing;
    if (editing) {
      const prev = editing;
      data.setTrainingslog(list => list.map(r => (r.record_id === editing.record_id ? { ...r, fields } : r)));
      try {
        await LivingAppsService.updateTrainingslogEntry(editing.record_id, fields);
      } catch (err) {
        data.fetchAll();
        throw err;
      }
      undoToast(`${appLabel('trainingslog')} — ${t('crud_updated')}`, async () => {
        data.setTrainingslog(list => list.map(r => (r.record_id === prev.record_id ? prev : r)));
        try { await LivingAppsService.updateTrainingslogEntry(prev.record_id, prev.fields); } catch { data.fetchAll(); }
      });
    } else {
      await LivingAppsService.createTrainingslogEntry(fields);
      undoToast(`${appLabel('trainingslog')} — ${t('crud_created')}`);
      data.fetchAll();
    }
  }

  const surfaces = (
    <>
      <UebungenDialog
        open={uebungenDialog !== null}
        onClose={() => setUebungenDialog(null)}
        onSubmit={submitUebungen}
        defaultValues={uebungenDialog?.defaults}
        recordId={uebungenDialog?.editing?.record_id}
        enablePhotoScan={AI_PHOTO_SCAN['Uebungen']}
        enablePhotoLocation={AI_PHOTO_LOCATION['Uebungen']}
      />
      <TrainingslogDialog
        open={trainingslogDialog !== null}
        onClose={() => setTrainingslogDialog(null)}
        onSubmit={submitTrainingslog}
        defaultValues={trainingslogDialog?.defaults}
        recordId={trainingslogDialog?.editing?.record_id}
        uebungenList={data.uebungen}
        enablePhotoScan={AI_PHOTO_SCAN['Trainingslog']}
        enablePhotoLocation={AI_PHOTO_LOCATION['Trainingslog']}
      />
      <RecordOverlayHost
        overlay={overlay}
        placement={options?.placement}
        size={options?.size}
        footer={options?.footer}
        render={(top) => {
          if (top.type === 'uebungen') {
            return (
              <>
                <RecordHeader title={top.record.fields.name ?? appLabel('uebungen')} subtitle={undefined} />
                <UebungenDetails
                  record={top.record}
                  trainingslogList={data.trainingslog}
                  onOpenTrainingslog={(r) => detailTrainingslog(r, true)}
                  onAddTrainingslog={() => setTrainingslogDialog({ defaults: { uebung: createRecordUrl(APP_IDS.UEBUNGEN, top.record.record_id) } })}
                />
              </>
            );
          }
          if (top.type === 'trainingslog') {
            return (
              <>
                <RecordHeader title={top.record.fields.notiz ?? appLabel('trainingslog')} subtitle={top.record.fields.datum ? formatDate(top.record.fields.datum) : undefined} />
                <TrainingslogDetails
                  record={top.record}
                  uebungenList={data.uebungen}
                  onOpenUebungen={(r) => detailUebungen(r, true)}
                />
              </>
            );
          }
          return null;
        }}
        onEdit={(top) => {
          overlay.close();
          if (top.type === 'uebungen') setUebungenDialog({ editing: top.record, defaults: top.record.fields });
          if (top.type === 'trainingslog') setTrainingslogDialog({ editing: top.record, defaults: top.record.fields });
        }}
      />
    </>
  );

  return {
    overlay,
    surfaces,
    uebungen: {
      openCreate: (defaults?: UebungenDialogDefaults) => setUebungenDialog({ defaults }),
      openEdit: (record: Uebungen) => setUebungenDialog({ editing: record, defaults: record.fields }),
      openDetail: (record: Uebungen) => detailUebungen(record, false),
    },
    trainingslog: {
      openCreate: (defaults?: TrainingslogDialogDefaults) => setTrainingslogDialog({ defaults }),
      openEdit: (record: Trainingslog) => setTrainingslogDialog({ editing: record, defaults: record.fields }),
      openDetail: (record: Trainingslog) => detailTrainingslog(record, false),
    },
    enriched: { trainingslog: enrichedTrainingslog },
  };
}

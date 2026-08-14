import type { EnrichedTrainingslog } from '@/types/enriched';
import type { Trainingslog, Uebungen } from '@/types/app';
import { extractRecordId } from '@/services/livingAppsService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveDisplay(url: unknown, map: Map<string, any>, ...fields: string[]): string {
  if (!url) return '';
  const id = extractRecordId(url);
  if (!id) return '';
  const r = map.get(id);
  if (!r) return '';
  return fields.map(f => String(r.fields[f] ?? '')).join(' ').trim();
}

interface TrainingslogMaps {
  uebungenMap: Map<string, Uebungen>;
}

export function enrichTrainingslog(
  trainingslog: Trainingslog[],
  maps: TrainingslogMaps
): EnrichedTrainingslog[] {
  return trainingslog.map(r => ({
    ...r,
    uebungName: resolveDisplay(r.fields.uebung, maps.uebungenMap, 'name'),
  }));
}

import { lookupLabel } from '@/i18n';

// AUTOMATICALLY GENERATED TYPES - DO NOT EDIT

export type LookupValue = { key: string; label: string };
export type GeoLocation = { lat: number; long: number; info?: string };

export type AttachmentType = 'file' | 'note' | 'url' | 'json';
export interface Attachment {
  id: string;
  type: AttachmentType;
  label: string | null;
  value: string | null;
  active: boolean;
  createdat?: string | null;
  updatedat?: string | null;
}

export interface AttachmentInput {
  type: AttachmentType;
  label?: string;
  value: string;
  active?: boolean;
}

export interface Uebungen {
  record_id: string;
  /** The API field. */
  created_at: string;
  updated_at: string | null;
  /** Alias of created_at, filled by the read helpers. The API sends
   *  snake_case only — reading `createdat` off a raw record yields
   *  undefined, which type-checks and then crashes at runtime. */
  createdat: string;
  updatedat: string | null;
  fields: {
    name?: string;
    muskelgruppe?: LookupValue;
    notizen?: string;
  };
}

export interface Trainingslog {
  record_id: string;
  /** The API field. */
  created_at: string;
  updated_at: string | null;
  /** Alias of created_at, filled by the read helpers. The API sends
   *  snake_case only — reading `createdat` off a raw record yields
   *  undefined, which type-checks and then crashes at runtime. */
  createdat: string;
  updatedat: string | null;
  fields: {
    datum?: string; // Format: YYYY-MM-DD oder ISO String
    uebung?: string; // applookup -> URL zu 'Uebungen' Record
    satz_nummer?: number;
    gewicht_kg?: number;
    wiederholungen?: number;
    notiz?: string;
  };
}

export const APP_IDS = {
  UEBUNGEN: '6a7ee25960d65014941c40fe',
  TRAININGSLOG: '6a7ee25cb89e32a8f654d32f',
} as const;


export const LOOKUP_OPTIONS: Record<string, Record<string, {key: string, label: string}[]>> = {
  'uebungen': {
    muskelgruppe: [{ key: "brust", get label() { return lookupLabel('uebungen', 'muskelgruppe', "brust") ?? "Brust"; } }, { key: "ruecken", get label() { return lookupLabel('uebungen', 'muskelgruppe', "ruecken") ?? "Rücken"; } }, { key: "schultern", get label() { return lookupLabel('uebungen', 'muskelgruppe', "schultern") ?? "Schultern"; } }, { key: "arme", get label() { return lookupLabel('uebungen', 'muskelgruppe', "arme") ?? "Arme"; } }, { key: "beine", get label() { return lookupLabel('uebungen', 'muskelgruppe', "beine") ?? "Beine"; } }, { key: "bauch", get label() { return lookupLabel('uebungen', 'muskelgruppe', "bauch") ?? "Bauch"; } }, { key: "ganzkoerper", get label() { return lookupLabel('uebungen', 'muskelgruppe', "ganzkoerper") ?? "Ganzkörper"; } }],
  },
};

// Optimistic LookupValue writes: never re-type a label — resolve the schema
// option instead (its label is a locale-aware getter; falls back to the key).
// WRONG: status: { key: 'offen', label: 'Offen' }   (frozen in one language)
// RIGHT: status: lookupOption('<appKey>', 'status', 'offen')
export function lookupOption(app: string, field: string, key: string): LookupValue {
  return LOOKUP_OPTIONS[app]?.[field]?.find(o => o.key === key) ?? { key, label: key };
}

export const FIELD_TYPES: Record<string, Record<string, string>> = {
  'uebungen': {
    'name': 'string/text',
    'muskelgruppe': 'lookup/select',
    'notizen': 'string/textarea',
  },
  'trainingslog': {
    'datum': 'date/datetimeminute',
    'uebung': 'applookup/select',
    'satz_nummer': 'number',
    'gewicht_kg': 'number',
    'wiederholungen': 'number',
    'notiz': 'string/text',
  },
};

export const HUB_TOPOLOGY: Record<string, { field: string; entity: string }[]> = {
};

type StripLookup<T> = {
  [K in keyof T]: T[K] extends LookupValue | undefined ? string | LookupValue | undefined
    : T[K] extends LookupValue[] | undefined ? string[] | LookupValue[] | undefined
    : T[K];
};

// Helper Types for creating new records (lookup fields as plain strings for API)
export type CreateUebungen = StripLookup<Uebungen['fields']>;
export type CreateTrainingslog = StripLookup<Trainingslog['fields']>;
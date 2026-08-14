import type { FormEnhancements } from './types';

export const formEnhancements: FormEnhancements = {
  fieldOrder: ['datum', 'uebung', 'satz_nummer', 'gewicht_kg', 'wiederholungen', 'notiz'],
  defaults: {
    'datum': { kind: 'today', withTime: true },
  },
  computed: {},
};

export const computedDeps: Record<string, string[]> = {};
export const computedApplookupRefs: Record<string, {lookupKey: string}[]> = {};

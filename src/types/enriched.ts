import type { Trainingslog } from './app';

export type EnrichedTrainingslog = Trainingslog & {
  uebungName: string;
};

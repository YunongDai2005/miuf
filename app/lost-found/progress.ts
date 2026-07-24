import type { LostCase } from "./types";

export type StepBlocker = {
  step: 0 | 1;
  message: string;
};

export function isItemReady(lostCase: LostCase): boolean {
  return lostCase.item.description.trim().length >= 5;
}

export function hasSearchDestination(lostCase: LostCase): boolean {
  return (
    lostCase.itinerary.length > 0 ||
    Boolean(lostCase.item.includeCentralOffice)
  );
}

export function blockerForStep(
  targetStep: number,
  lostCase: LostCase
): StepBlocker | null {
  if (targetStep > 0 && !isItemReady(lostCase)) {
    return {
      step: 0,
      message:
        "Add a short description of the item before rebuilding your day.",
    };
  }

  if (targetStep > 1 && !hasSearchDestination(lostCase)) {
    return {
      step: 1,
      message:
        "Add at least one place or transport line. If you are unsure, go back and include Berlin’s city-wide lost-property search.",
    };
  }

  return null;
}

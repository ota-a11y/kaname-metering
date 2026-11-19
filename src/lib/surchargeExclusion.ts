export type SurchargeExclusionMode = 'exclude_all' | 'exclude_billing' | null;

export function includesSurchargeDenominator(mode: SurchargeExclusionMode) {
  return mode !== 'exclude_all';
}

export function includesSurchargeBilling(mode: SurchargeExclusionMode) {
  return mode === null;
}

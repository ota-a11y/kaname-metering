export function surchargeAdjustmentShortfallExclusive(
  originalAmountExclusive: number,
  adjustedAmountExclusive: number,
): number {
  return Math.max(0, originalAmountExclusive - adjustedAmountExclusive);
}

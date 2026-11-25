export function annualFixedChargeActive(billingMonth: string, annualBillingMonth: number | null | undefined): boolean {
  if (annualBillingMonth == null) return false;
  return Number(billingMonth.slice(5, 7)) === annualBillingMonth;
}

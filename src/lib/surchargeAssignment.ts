export function surchargeAssignmentIncluded(
  assignment: { unit_id: string; tenant_id?: string | null },
  unitIds: ReadonlySet<string>,
  firstUnitByTenant: ReadonlyMap<string, string>,
) {
  return assignment.tenant_id
    ? unitIds.has(firstUnitByTenant.get(assignment.tenant_id) ?? '')
    : unitIds.has(assignment.unit_id);
}

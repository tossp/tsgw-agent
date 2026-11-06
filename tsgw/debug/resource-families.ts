import type { DebugSessionGroup, DebugSessionRow } from "@/components/debug-panel-state";

export interface ResourceFamily {
  id: string;
  project: string | null;
  rows: DebugSessionRow[];
}

/** Use the host's family boundaries, not project boundaries or matching display names. */
export function resourceFamilies(groups: readonly DebugSessionGroup[], residentIds: ReadonlySet<string>): ResourceFamily[] {
  return groups.flatMap(group => {
    const families: ResourceFamily[] = [];
    for (const row of group.rows) {
      if (row.depth === 0 || families.length === 0) families.push({ id: row.id, project: group.name, rows: [] });
      families[families.length - 1].rows.push(row);
    }
    return families.flatMap(family => {
      const resident = family.rows.filter(row => row.summary !== null && residentIds.has(row.id));
      if (resident.length === 0) return [];
      return [{ ...family, rows: family.rows.filter((row, index) => index === 0 || resident.includes(row)) }];
    });
  });
}

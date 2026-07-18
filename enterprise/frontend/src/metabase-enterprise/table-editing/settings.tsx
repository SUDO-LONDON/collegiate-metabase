import type { Database } from "metabase-types/api";

export const DATABASE_TABLE_EDITING_SETTING = "database-enable-table-editing";

export function isDatabaseTableEditingEnabled(
  database: Pick<Database, "settings"> | undefined,
) {
  return Boolean(database?.settings?.[DATABASE_TABLE_EDITING_SETTING]);
}

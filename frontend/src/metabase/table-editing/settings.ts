import type { Database, TableId } from "metabase-types/api";

export const DATABASE_TABLE_EDITING_SETTING = "database-enable-table-editing";
export const DATABASE_EDITABLE_TABLE_IDS_SETTING =
  "database-editable-table-ids";

function parseTableId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsedValue = Number.parseInt(value, 10);
    return parsedValue > 0 ? parsedValue : null;
  }

  return null;
}

export function getEditableTableIds(
  database: Pick<Database, "settings"> | undefined,
) {
  const values =
    database?.settings?.[DATABASE_EDITABLE_TABLE_IDS_SETTING] ?? [];

  if (!Array.isArray(values)) {
    return [];
  }

  return Array.from(
    new Set(values.map(parseTableId).filter((id): id is number => id != null)),
  );
}

export function isDatabaseTableEditingEnabled(
  database: Pick<Database, "settings"> | undefined,
) {
  return Boolean(database?.settings?.[DATABASE_TABLE_EDITING_SETTING]);
}

export function isTableEditable(
  database: Pick<Database, "settings"> | undefined,
  tableId: TableId,
) {
  if (typeof tableId !== "number") {
    return false;
  }

  return (
    isDatabaseTableEditingEnabled(database) &&
    getEditableTableIds(database).includes(tableId)
  );
}

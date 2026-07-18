import type { RowValue } from "metabase-types/api/dataset";

export type EditableTableAction = "create" | "update" | "delete";

export type EditableTableRow = Record<string, RowValue>;

export type EditableTableColumnType =
  | "text"
  | "integer"
  | "decimal"
  | "boolean"
  | "date"
  | "datetime";

export type EditableTableColumnInput = {
  name: string;
  type: EditableTableColumnType;
  nullable: boolean;
};

export type EditableTableColumnDeleteInput = {
  name: string;
};

export type EditableTableColumnResponse = {
  success: true;
  column: EditableTableColumnInput;
  metadata_sync: {
    synced: boolean;
    error?: string;
  };
};

export type EditableTableColumnDeleteResponse = {
  success: true;
  column: EditableTableColumnDeleteInput;
  metadata_sync: {
    synced: boolean;
    error?: string;
  };
};

export type EditableTableFormParameterInputType =
  | "text"
  | "textarea"
  | "date"
  | "datetime"
  | "dropdown"
  | "boolean"
  | "integer"
  | "float";

export type EditableTableFormParameter = {
  id: string;
  display_name: string;
  field_id: number;
  input_type: EditableTableFormParameterInputType;
  optional: boolean;
  nullable?: boolean;
  readonly: boolean;
  database_default?: unknown;
  semantic_type?: string;
  value?: RowValue;
};

export type EditableTableFormResponse = {
  title: string;
  parameters: EditableTableFormParameter[];
};

export type EditableTableMutationResponse = {
  success: true;
  outputs?: Array<{
    op?: string;
    row?: EditableTableRow;
    "table-id"?: number;
  }>;
};

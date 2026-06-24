import type { TableId } from "metabase-types/api";

import type {
  EditableTableAction,
  EditableTableFormResponse,
  EditableTableMutationResponse,
  EditableTableRow,
} from "../table-editing/types";

import { Api } from "./api";

export const tableEditingApi = Api.injectEndpoints({
  endpoints: (builder) => ({
    describeTableEditForm: builder.mutation<
      EditableTableFormResponse,
      {
        tableId: TableId;
        action: EditableTableAction;
        input?: EditableTableRow;
      }
    >({
      query: ({ tableId, ...body }) => ({
        method: "POST",
        url: `/api/table-editing/${tableId}/describe-form`,
        body,
      }),
    }),
    createTableRow: builder.mutation<
      EditableTableMutationResponse,
      {
        tableId: TableId;
        row: EditableTableRow;
      }
    >({
      query: ({ tableId, ...body }) => ({
        method: "POST",
        url: `/api/table-editing/${tableId}/create`,
        body,
      }),
    }),
    updateTableRow: builder.mutation<
      EditableTableMutationResponse,
      {
        tableId: TableId;
        row: EditableTableRow;
      }
    >({
      query: ({ tableId, ...body }) => ({
        method: "POST",
        url: `/api/table-editing/${tableId}/update`,
        body,
      }),
    }),
    deleteTableRow: builder.mutation<
      EditableTableMutationResponse,
      {
        tableId: TableId;
        row: EditableTableRow;
      }
    >({
      query: ({ tableId, ...body }) => ({
        method: "POST",
        url: `/api/table-editing/${tableId}/delete`,
        body,
      }),
    }),
  }),
});

export const {
  useCreateTableRowMutation,
  useDeleteTableRowMutation,
  useDescribeTableEditFormMutation,
  useUpdateTableRowMutation,
} = tableEditingApi;

import type { TableId } from "metabase-types/api";

import type {
  EditableTableAction,
  EditableTableColumnDeleteInput,
  EditableTableColumnDeleteResponse,
  EditableTableColumnInput,
  EditableTableColumnResponse,
  EditableTableFormResponse,
  EditableTableMutationResponse,
  EditableTableRow,
} from "../table-editing/types";

import { Api } from "./api";
import { idTag, invalidateTags, listTag, tag } from "./tags";

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
    addTableColumn: builder.mutation<
      EditableTableColumnResponse,
      {
        tableId: TableId;
        column: EditableTableColumnInput;
      }
    >({
      query: ({ tableId, ...body }) => ({
        method: "POST",
        url: `/api/table-editing/${tableId}/columns`,
        body,
      }),
      invalidatesTags: (_, error, { tableId }) =>
        invalidateTags(error, [
          idTag("table", tableId),
          listTag("field"),
          listTag("field-values"),
          tag("card"),
          tag("dataset"),
          listTag("erd"),
        ]),
    }),
    deleteTableColumn: builder.mutation<
      EditableTableColumnDeleteResponse,
      {
        tableId: TableId;
        column: EditableTableColumnDeleteInput;
      }
    >({
      query: ({ tableId, ...body }) => ({
        method: "POST",
        url: `/api/table-editing/${tableId}/columns/delete`,
        body,
      }),
      invalidatesTags: (_, error, { tableId }) =>
        invalidateTags(error, [
          idTag("table", tableId),
          listTag("field"),
          listTag("field-values"),
          tag("card"),
          tag("dataset"),
          listTag("erd"),
        ]),
    }),
  }),
});

export const {
  useAddTableColumnMutation,
  useCreateTableRowMutation,
  useDeleteTableColumnMutation,
  useDeleteTableRowMutation,
  useDescribeTableEditFormMutation,
  useUpdateTableRowMutation,
} = tableEditingApi;

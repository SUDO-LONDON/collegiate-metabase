import type { CSSProperties, FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { t } from "ttag";

import { skipToken } from "metabase/api/api";
import { useGetDatabaseQuery } from "metabase/api/database";
import {
  useGetTableDataQuery,
  useGetTableQuery,
  useGetTableQueryMetadataQuery,
} from "metabase/api/table";
import {
  useAddTableColumnMutation,
  useCreateTableRowMutation,
  useDeleteTableColumnMutation,
  useDeleteTableRowMutation,
  useUpdateTableRowMutation,
} from "metabase/api/table-editing";
import { getErrorMessage } from "metabase/api/utils/errors";
import { BrowserCrumbs } from "metabase/common/components/BrowserCrumbs";
import { GenericError } from "metabase/common/components/ErrorPages";
import { LoadingAndErrorWrapper } from "metabase/common/components/LoadingAndErrorWrapper";
import { useToast } from "metabase/common/hooks";
import { useCloseNavbarOnMount } from "metabase/common/hooks/use-close-navbar-on-mount";
import { useSelector } from "metabase/redux";
import { getUserIsAdmin } from "metabase/selectors/user";
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Flex,
  Group,
  Icon,
  Modal,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "metabase/ui";
import * as Urls from "metabase/urls";
import type { Database, Table } from "metabase-types/api";
import type {
  DatasetColumn,
  RowValue,
  RowValues,
} from "metabase-types/api/dataset";

import { TableEditingFormModal } from "./TableEditingFormModal";
import { isDatabaseTableEditingEnabled, isTableEditable } from "./settings";
import type {
  EditableTableColumnInput,
  EditableTableColumnType,
  EditableTableRow,
} from "./types";

type TableEditPageProps = {
  params: {
    dbId: string;
    tableId: string;
  };
};

export function TableEditPage({ params }: TableEditPageProps) {
  useCloseNavbarOnMount();

  const databaseId = Number.parseInt(params.dbId, 10);
  const tableId = Number.parseInt(params.tableId, 10);
  const hasValidDatabaseId = Number.isInteger(databaseId) && databaseId > 0;
  const hasValidTableId = Number.isInteger(tableId) && tableId > 0;
  const isAdmin = useSelector(getUserIsAdmin);
  const [sendToast] = useToast();

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [columnModalOpen, setColumnModalOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<EditableTableRow | null>(null);
  const [deletingRow, setDeletingRow] = useState<EditableTableRow | null>(null);
  const [deletingColumn, setDeletingColumn] = useState<DatasetColumn | null>(
    null,
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [addColumnError, setAddColumnError] = useState<string | null>(null);
  const [deleteColumnError, setDeleteColumnError] = useState<string | null>(
    null,
  );

  const databaseResult = useGetDatabaseQuery(
    hasValidDatabaseId ? { id: databaseId } : skipToken,
  );
  const tableResult = useGetTableQuery(
    hasValidTableId ? { id: tableId } : skipToken,
  );
  const tableMetadataResult = useGetTableQueryMetadataQuery(
    hasValidTableId ? { id: tableId } : skipToken,
  );
  const tableDataResult = useGetTableDataQuery(
    { tableId },
    { skip: !hasValidTableId },
  );

  const [addTableColumn, addTableColumnResult] = useAddTableColumnMutation();
  const [deleteTableColumn, deleteTableColumnResult] =
    useDeleteTableColumnMutation();
  const [createTableRow, createTableRowResult] = useCreateTableRowMutation();
  const [updateTableRow, updateTableRowResult] = useUpdateTableRowMutation();
  const [deleteTableRow, deleteTableRowResult] = useDeleteTableRowMutation();

  const dataset = tableDataResult.data;
  const columns = useMemo(() => dataset?.data.cols ?? [], [dataset?.data.cols]);
  const primaryKeyFieldNames = useMemo(
    () =>
      new Set(
        (tableMetadataResult.data?.fields ?? [])
          .filter((field) => field.semantic_type === "type/PK")
          .map((field) => field.name),
      ),
    [tableMetadataResult.data?.fields],
  );
  const rowObjects = useMemo(
    () => dataset?.data.rows.map((row) => toRowObject(columns, row)) ?? [],
    [columns, dataset?.data.rows],
  );
  const primaryKeyColumns = useMemo(
    () => columns.filter((column) => primaryKeyFieldNames.has(column.name)),
    [columns, primaryKeyFieldNames],
  );

  const loading =
    databaseResult.isLoading ||
    tableResult.isLoading ||
    tableMetadataResult.isLoading ||
    tableDataResult.isLoading;
  const error =
    databaseResult.error ||
    tableResult.error ||
    tableMetadataResult.error ||
    tableDataResult.error;

  const database = databaseResult.data;
  const table = tableResult.data;
  const canManageTable =
    database != null &&
    table != null &&
    isDatabaseTableEditingEnabled(database) &&
    isTableEditable(database, table.id) &&
    Boolean(table.is_writable);
  const canManageRows = canManageTable && primaryKeyColumns.length > 0;

  const handleRefresh = async () => {
    await Promise.all([
      tableResult.refetch(),
      tableMetadataResult.refetch(),
      tableDataResult.refetch(),
    ]);
  };

  const handleAddColumn = async (column: EditableTableColumnInput) => {
    try {
      setAddColumnError(null);
      const result = await addTableColumn({ tableId, column }).unwrap();
      await Promise.all([
        tableResult.refetch(),
        tableMetadataResult.refetch(),
        tableDataResult.refetch(),
      ]);
      setColumnModalOpen(false);
      sendToast({
        message: result.metadata_sync.synced
          ? t`Column added`
          : t`Column added, but table metadata could not be synced`,
        toastColor: result.metadata_sync.synced ? "success" : "warning",
      });
    } catch (error) {
      setAddColumnError(getErrorMessage(error, t`Unable to add this column.`));
    }
  };

  const handleDeleteColumn = async () => {
    if (!deletingColumn) {
      return;
    }

    try {
      setDeleteColumnError(null);
      const result = await deleteTableColumn({
        tableId,
        column: { name: deletingColumn.name },
      }).unwrap();
      await Promise.all([
        tableResult.refetch(),
        tableMetadataResult.refetch(),
        tableDataResult.refetch(),
      ]);
      setDeletingColumn(null);
      sendToast({
        message: result.metadata_sync.synced
          ? t`Column deleted`
          : t`Column deleted, but table metadata could not be synced`,
        toastColor: result.metadata_sync.synced ? "success" : "warning",
      });
    } catch (error) {
      setDeleteColumnError(
        getErrorMessage(error, t`Unable to delete this column.`),
      );
    }
  };

  const handleCreate = async (row: EditableTableRow) => {
    await createTableRow({ tableId, row }).unwrap();
    await tableDataResult.refetch();
    sendToast({
      message: t`Row created`,
      toastColor: "success",
    });
  };

  const handleUpdate = async (row: EditableTableRow) => {
    await updateTableRow({ tableId, row }).unwrap();
    await tableDataResult.refetch();
    sendToast({
      message: t`Row updated`,
      toastColor: "success",
    });
  };

  const handleDelete = async () => {
    if (!deletingRow) {
      return;
    }

    try {
      setDeleteError(null);
      await deleteTableRow({
        tableId,
        row: pickPrimaryKeyValues(deletingRow, primaryKeyColumns),
      }).unwrap();
      await tableDataResult.refetch();
      setDeletingRow(null);
      sendToast({
        message: t`Row deleted`,
        toastColor: "success",
      });
    } catch (error) {
      setDeleteError(getErrorMessage(error, t`Unable to delete this row.`));
    }
  };

  if (!hasValidDatabaseId || !hasValidTableId) {
    return (
      <TableEditPageError
        title={t`Invalid table`}
        message={t`The table URL is invalid.`}
      />
    );
  }

  if (!isAdmin) {
    return (
      <TableEditPageError
        title={t`You are not allowed to edit this table`}
        message={t`Only admin users can edit rows from this page.`}
      />
    );
  }

  return (
    <LoadingAndErrorWrapper loading={loading} error={error} noWrapper>
      {database && table && (
        <>
          <Stack gap="lg" px="xl" py="lg">
            <Flex align="center" justify="space-between" gap="md" wrap="wrap">
              <BrowserCrumbs crumbs={getCrumbs(database, table)} />
              <Group gap="sm">
                <Button
                  variant="default"
                  leftSection={<Icon name="refresh" />}
                  onClick={handleRefresh}
                  loading={
                    tableResult.isFetching ||
                    tableMetadataResult.isFetching ||
                    tableDataResult.isFetching
                  }
                >
                  {t`Refresh`}
                </Button>
                <Button
                  variant="outline"
                  leftSection={<Icon name="add" />}
                  onClick={() => {
                    setAddColumnError(null);
                    setColumnModalOpen(true);
                  }}
                  disabled={!canManageTable}
                >
                  {t`Add column`}
                </Button>
                <Button
                  leftSection={<Icon name="add" />}
                  onClick={() => setCreateModalOpen(true)}
                  disabled={!canManageRows}
                >
                  {t`Add row`}
                </Button>
              </Group>
            </Flex>

            {!isDatabaseTableEditingEnabled(database) ? (
              <TableEditPageError
                title={t`Table editing is not enabled`}
                message={t`Enable the table editor for this database in Admin settings first.`}
              />
            ) : !isTableEditable(database, table.id) ? (
              <TableEditPageError
                title={t`This table is not allowlisted`}
                message={t`Add this table to the editable table list in the database settings first.`}
              />
            ) : !table.is_writable ? (
              <TableEditPageError
                title={t`This table is read-only`}
                message={t`The current database connection cannot write to this table.`}
              />
            ) : (
              <>
                {!canManageRows ? (
                  <Alert
                    color="warning"
                    variant="light"
                    icon={<Icon name="info" />}
                  >
                    {t`Rows cannot be created, updated, or deleted until this table has a primary key.`}
                  </Alert>
                ) : null}

                <Group gap="sm">
                  <Badge variant="light">
                    {table.display_name || table.name}
                  </Badge>
                  {dataset ? (
                    <Text size="sm" c="text-secondary">
                      {t`${dataset.row_count} row(s) loaded`}
                    </Text>
                  ) : null}
                </Group>

                {dataset?.data.rows_truncated ? (
                  <Alert
                    color="info"
                    variant="light"
                    icon={<Icon name="info" />}
                  >
                    {t`Only the first ${dataset.data.rows.length} rows are shown here.`}
                  </Alert>
                ) : null}

                <Card withBorder shadow="none" p={0}>
                  {columns.length === 0 ? (
                    <Flex align="center" justify="center" py="4rem" px="lg">
                      <Text fw="700">{t`No columns`}</Text>
                    </Flex>
                  ) : (
                    <Box style={{ overflowX: "auto" }}>
                      <table
                        style={{
                          width: "100%",
                          borderCollapse: "collapse",
                        }}
                      >
                        <thead>
                          <tr>
                            {columns.map((column) => (
                              <ColumnHeaderCell
                                key={column.name}
                                column={column}
                                isPrimaryKey={primaryKeyFieldNames.has(
                                  column.name,
                                )}
                                canManageTable={canManageTable}
                                onDelete={(column) => {
                                  setDeleteColumnError(null);
                                  setDeletingColumn(column);
                                }}
                              />
                            ))}
                            <th style={tableHeaderCellStyle}>{t`Actions`}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rowObjects.length === 0 ? (
                            <tr>
                              <td
                                colSpan={columns.length + 1}
                                style={emptyTableCellStyle}
                              >
                                <Stack gap="sm" align="center">
                                  <Text fw="700">{t`No rows`}</Text>
                                  <Text size="sm" c="text-secondary">
                                    {canManageRows
                                      ? t`Create the first row for this table from here.`
                                      : t`This table has no rows to show.`}
                                  </Text>
                                </Stack>
                              </td>
                            </tr>
                          ) : (
                            rowObjects.map((row, index) => (
                              <tr
                                key={getRowKey(row, primaryKeyColumns, index)}
                              >
                                {columns.map((column) => (
                                  <td
                                    key={`${getRowKey(
                                      row,
                                      primaryKeyColumns,
                                      index,
                                    )}-${column.name}`}
                                    style={tableBodyCellStyle}
                                  >
                                    {formatCellValue(row[column.name])}
                                  </td>
                                ))}
                                <td style={tableActionsCellStyle}>
                                  <Group
                                    justify="flex-end"
                                    gap="xs"
                                    wrap="nowrap"
                                  >
                                    <Tooltip
                                      label={t`Edit row`}
                                      disabled={!canManageRows}
                                    >
                                      <span>
                                        <ActionIcon
                                          variant="subtle"
                                          color="text-secondary"
                                          onClick={() => setEditingRow(row)}
                                          disabled={!canManageRows}
                                          aria-label={t`Edit row`}
                                        >
                                          <Icon name="pencil" />
                                        </ActionIcon>
                                      </span>
                                    </Tooltip>
                                    <Tooltip
                                      label={t`Delete row`}
                                      disabled={!canManageRows}
                                    >
                                      <span>
                                        <ActionIcon
                                          variant="subtle"
                                          color="error"
                                          onClick={() => setDeletingRow(row)}
                                          disabled={!canManageRows}
                                          aria-label={t`Delete row`}
                                        >
                                          <Icon name="trash" />
                                        </ActionIcon>
                                      </span>
                                    </Tooltip>
                                  </Group>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </Box>
                  )}
                </Card>
              </>
            )}
          </Stack>

          {canManageTable && (
            <AddColumnModal
              opened={columnModalOpen}
              error={addColumnError}
              isLoading={addTableColumnResult.isLoading}
              onClose={() => {
                setAddColumnError(null);
                setColumnModalOpen(false);
              }}
              onSubmit={handleAddColumn}
            />
          )}

          {canManageTable && (
            <DeleteColumnModal
              opened={deletingColumn != null}
              column={deletingColumn}
              error={deleteColumnError}
              isLoading={deleteTableColumnResult.isLoading}
              onClose={() => {
                setDeleteColumnError(null);
                setDeletingColumn(null);
              }}
              onConfirm={handleDeleteColumn}
            />
          )}

          {canManageRows && (
            <>
              <TableEditingFormModal
                action="create"
                tableId={tableId}
                opened={createModalOpen}
                onClose={() => setCreateModalOpen(false)}
                onSubmit={handleCreate}
                isSubmitting={createTableRowResult.isLoading}
              />

              <TableEditingFormModal
                action="update"
                tableId={tableId}
                opened={editingRow != null}
                initialRow={editingRow}
                onClose={() => setEditingRow(null)}
                onSubmit={handleUpdate}
                isSubmitting={updateTableRowResult.isLoading}
              />

              <DeleteRowModal
                opened={deletingRow != null}
                row={deletingRow}
                primaryKeyColumns={primaryKeyColumns}
                error={deleteError}
                isLoading={deleteTableRowResult.isLoading}
                onClose={() => {
                  setDeleteError(null);
                  setDeletingRow(null);
                }}
                onConfirm={handleDelete}
              />
            </>
          )}
        </>
      )}
    </LoadingAndErrorWrapper>
  );
}

function ColumnHeaderCell({
  column,
  isPrimaryKey,
  canManageTable,
  onDelete,
}: {
  column: DatasetColumn;
  isPrimaryKey: boolean;
  canManageTable: boolean;
  onDelete: (column: DatasetColumn) => void;
}) {
  const columnName = column.display_name || column.name;

  return (
    <th style={tableHeaderCellStyle}>
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Text component="span" size="sm" fw={700}>
          {columnName}
        </Text>
        {canManageTable ? (
          <Tooltip
            label={
              isPrimaryKey
                ? t`Primary key columns cannot be deleted`
                : t`Delete column`
            }
          >
            <span>
              <ActionIcon
                variant="subtle"
                size="sm"
                color="error"
                disabled={isPrimaryKey}
                onClick={() => onDelete(column)}
                aria-label={t`Delete column ${columnName}`}
              >
                <Icon name="trash" />
              </ActionIcon>
            </span>
          </Tooltip>
        ) : null}
      </Group>
    </th>
  );
}

function AddColumnModal({
  opened,
  error,
  isLoading,
  onClose,
  onSubmit,
}: {
  opened: boolean;
  error: string | null;
  isLoading: boolean;
  onClose: () => void;
  onSubmit: (column: EditableTableColumnInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<EditableTableColumnType>("text");
  const [nullable, setNullable] = useState(true);

  useEffect(() => {
    if (opened) {
      setName("");
      setType("text");
      setNullable(true);
    }
  }, [opened]);

  const trimmedName = name.trim();
  const columnTypeOptions: Array<{
    value: EditableTableColumnType;
    label: string;
  }> = [
    { value: "text", label: t`Text` },
    { value: "integer", label: t`Integer` },
    { value: "decimal", label: t`Decimal` },
    { value: "boolean", label: t`Boolean` },
    { value: "date", label: t`Date` },
    { value: "datetime", label: t`Date and time` },
  ];

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit({
      name: trimmedName,
      type,
      nullable,
    });
  };

  return (
    <Modal opened={opened} onClose={onClose} title={t`Add column`} centered>
      <form onSubmit={handleSubmit}>
        <Stack gap="md">
          <TextInput
            label={t`Column name`}
            value={name}
            autoFocus
            required
            onChange={(event) => setName(event.currentTarget.value)}
          />

          <Select
            label={t`Column type`}
            data={columnTypeOptions}
            value={type}
            onChange={(value) => {
              if (value) {
                setType(value as EditableTableColumnType);
              }
            }}
          />

          <Checkbox
            label={t`Allow empty values`}
            checked={nullable}
            onChange={(event) => setNullable(event.currentTarget.checked)}
          />

          {error ? (
            <Alert color="error" variant="light">
              {error}
            </Alert>
          ) : null}

          <Flex justify="flex-end" gap="sm">
            <Button variant="subtle" onClick={onClose}>
              {t`Cancel`}
            </Button>
            <Button type="submit" loading={isLoading} disabled={!trimmedName}>
              {t`Add column`}
            </Button>
          </Flex>
        </Stack>
      </form>
    </Modal>
  );
}

function DeleteColumnModal({
  opened,
  column,
  error,
  isLoading,
  onClose,
  onConfirm,
}: {
  opened: boolean;
  column: DatasetColumn | null;
  error: string | null;
  isLoading: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const columnName = column?.display_name || column?.name || "";

  return (
    <Modal opened={opened} onClose={onClose} title={t`Delete column`} centered>
      <Stack gap="md">
        <Text size="sm" c="text-secondary">
          {t`This will permanently delete the selected column and all values stored in it.`}
        </Text>

        {column ? (
          <Paper p="md" bg="background-secondary" withBorder>
            <Text size="sm">
              <Text component="span" fw="700">
                {t`Column`}
              </Text>
              {": "}
              {columnName}
            </Text>
          </Paper>
        ) : null}

        {error ? (
          <Alert color="error" variant="light">
            {error}
          </Alert>
        ) : null}

        <Flex justify="flex-end" gap="sm">
          <Button variant="subtle" onClick={onClose}>
            {t`Cancel`}
          </Button>
          <Button color="error" loading={isLoading} onClick={onConfirm}>
            {t`Delete column`}
          </Button>
        </Flex>
      </Stack>
    </Modal>
  );
}

function DeleteRowModal({
  opened,
  row,
  primaryKeyColumns,
  error,
  isLoading,
  onClose,
  onConfirm,
}: {
  opened: boolean;
  row: EditableTableRow | null;
  primaryKeyColumns: DatasetColumn[];
  error: string | null;
  isLoading: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Modal opened={opened} onClose={onClose} title={t`Delete row`} centered>
      <Stack gap="md">
        <Text size="sm" c="text-secondary">
          {t`This will permanently remove the selected row.`}
        </Text>

        {row && primaryKeyColumns.length > 0 ? (
          <Paper p="md" bg="background-secondary" withBorder>
            <Stack gap="xs">
              {primaryKeyColumns.map((column) => (
                <Text key={column.name} size="sm">
                  <Text component="span" fw="700">
                    {column.display_name || column.name}
                  </Text>
                  {": "}
                  {formatCellValue(row[column.name])}
                </Text>
              ))}
            </Stack>
          </Paper>
        ) : null}

        {error ? (
          <Alert color="error" variant="light">
            {error}
          </Alert>
        ) : null}

        <Flex justify="flex-end" gap="sm">
          <Button variant="subtle" onClick={onClose}>
            {t`Cancel`}
          </Button>
          <Button color="error" loading={isLoading} onClick={onConfirm}>
            {t`Delete row`}
          </Button>
        </Flex>
      </Stack>
    </Modal>
  );
}

function TableEditPageError({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <Box px="xl" py="lg">
      <GenericError title={title} message={message} details={undefined} />
    </Box>
  );
}

function getCrumbs(
  database: Pick<Database, "id" | "name">,
  table: Pick<Table, "id" | "name" | "display_name" | "schema">,
) {
  const crumbs: Array<{ title: string; to?: string }> = [
    { title: t`Databases`, to: "/browse/databases" },
    { title: database.name, to: Urls.browseDatabase(database) },
  ];

  if (table.schema) {
    crumbs.push({
      title: table.schema,
      to: `/browse/databases/${database.id}/schema/${encodeURIComponent(
        table.schema,
      )}`,
    });
  }

  crumbs.push({
    title: table.display_name || table.name,
    to: Urls.table({
      id: Number(table.id),
      name: table.display_name || table.name,
    }),
  });
  crumbs.push({ title: t`Edit` });

  return crumbs;
}

function toRowObject(
  columns: DatasetColumn[],
  row: RowValues,
): EditableTableRow {
  return Object.fromEntries(
    columns.map((column, index) => [column.name, row[index] ?? null]),
  );
}

function pickPrimaryKeyValues(
  row: EditableTableRow,
  primaryKeyColumns: DatasetColumn[],
) {
  return Object.fromEntries(
    primaryKeyColumns.map((column) => [column.name, row[column.name]]),
  );
}

function getRowKey(
  row: EditableTableRow,
  primaryKeyColumns: DatasetColumn[],
  index: number,
) {
  if (primaryKeyColumns.length === 0) {
    return `row-${index}`;
  }

  return primaryKeyColumns
    .map((column) => `${column.name}:${String(row[column.name])}`)
    .join("|");
}

function formatCellValue(value: RowValue) {
  if (value == null) {
    return (
      <Text size="sm" c="text-secondary">
        {t`NULL`}
      </Text>
    );
  }

  if (typeof value === "boolean") {
    return value ? t`True` : t`False`;
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

const tableHeaderCellStyle: CSSProperties = {
  textAlign: "left",
  padding: "0.875rem 1rem",
  borderBottom: "1px solid var(--mb-color-border)",
  fontSize: "0.875rem",
  fontWeight: 700,
  whiteSpace: "nowrap",
};

const tableBodyCellStyle: CSSProperties = {
  padding: "0.875rem 1rem",
  borderBottom: "1px solid var(--mb-color-border)",
  fontSize: "0.875rem",
  maxWidth: 280,
  verticalAlign: "top",
  wordBreak: "break-word",
};

const emptyTableCellStyle: CSSProperties = {
  ...tableBodyCellStyle,
  padding: "4rem 1rem",
  textAlign: "center",
};

const tableActionsCellStyle: CSSProperties = {
  ...tableBodyCellStyle,
  width: 96,
  whiteSpace: "nowrap",
};

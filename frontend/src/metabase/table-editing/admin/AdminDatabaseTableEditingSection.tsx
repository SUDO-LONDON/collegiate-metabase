import { useEffect, useMemo, useState } from "react";
import { t } from "ttag";

import {
  Description,
  Error,
  Label,
} from "metabase/admin/databases/components/DatabaseFeatureComponents";
import {
  DatabaseInfoSection,
  DatabaseInfoSectionDivider,
} from "metabase/admin/databases/components/DatabaseInfoSection";
import { useGetDatabaseMetadataQuery } from "metabase/api";
import { Toggle } from "metabase/common/components/Toggle";
import { hasDbRoutingEnabled } from "metabase/common/utils/database";
import { ALLOWED_ENGINES_FOR_TABLE_EDITING } from "metabase/databases/constants";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Flex,
  Icon,
  Loader,
  Stack,
  Text,
  TextInput,
} from "metabase/ui";
import { getResponseErrorMessage } from "metabase/utils/errors";
import type {
  Database,
  DatabaseData,
  DatabaseId,
  DatabaseLocalSettingAvailability,
  Table,
} from "metabase-types/api";

import {
  DATABASE_EDITABLE_TABLE_IDS_SETTING,
  DATABASE_TABLE_EDITING_SETTING,
  getEditableTableIds,
  isDatabaseTableEditingEnabled,
} from "../settings";

enum DisabledReasonKey {
  MissingDriverFeature = "driver-feature-missing",
  NoWriteableTable = "permissions/no-writable-table",
  SyncInProgress = "database-metadata/sync-in-progress",
  DatabaseEmpty = "database-metadata/not-populated",
}

const VISIBLE_REASONS: string[] = [
  DisabledReasonKey.NoWriteableTable,
  DisabledReasonKey.SyncInProgress,
  DisabledReasonKey.DatabaseEmpty,
];

export function AdminDatabaseTableEditingSection({
  database,
  settingsAvailable,
  updateDatabase,
}: {
  database: Database;
  settingsAvailable?: Record<string, DatabaseLocalSettingAvailability>;
  updateDatabase: (
    database: { id: DatabaseId } & Partial<DatabaseData>,
  ) => Promise<void>;
}) {
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [allowlistError, setAllowlistError] = useState<string | null>(null);
  const [isSavingAllowlist, setIsSavingAllowlist] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [selectedTableIds, setSelectedTableIds] = useState<string[]>(
    getEditableTableIds(database).map(String),
  );

  useEffect(() => {
    setSelectedTableIds(getEditableTableIds(database).map(String));
  }, [database]);

  const { data: databaseMetadata, isLoading: isLoadingTables } =
    useGetDatabaseMetadataQuery(
      { id: database.id },
      {
        skip: !ALLOWED_ENGINES_FOR_TABLE_EDITING.includes(
          database.engine ?? "",
        ),
      },
    );

  const allowedToEnableTableEditing =
    database.engine &&
    ALLOWED_ENGINES_FOR_TABLE_EDITING.includes(database.engine);

  const databaseHasRouting = hasDbRoutingEnabled(database);
  const dataEditingSetting =
    settingsAvailable?.[DATABASE_TABLE_EDITING_SETTING];
  const isSettingDisabled =
    !dataEditingSetting || dataEditingSetting.enabled === false;
  const firstDisabledReason =
    dataEditingSetting?.enabled === false
      ? dataEditingSetting.reasons?.[0]
      : undefined;
  const shouldShowSection =
    !firstDisabledReason || VISIBLE_REASONS.includes(firstDisabledReason.key);

  const tables = useMemo(
    () => sortTables(databaseMetadata?.tables ?? database.tables ?? []),
    [database.tables, databaseMetadata?.tables],
  );

  const filteredTables = useMemo(() => {
    const search = searchValue.trim().toLowerCase();
    if (search === "") {
      return tables;
    }

    return tables.filter((table) => {
      const displayName = table.display_name?.toLowerCase() ?? "";
      const tableName = table.name?.toLowerCase() ?? "";
      const schema = table.schema?.toLowerCase() ?? "";

      return (
        displayName.includes(search) ||
        tableName.includes(search) ||
        schema.includes(search)
      );
    });
  }, [searchValue, tables]);

  const currentSelection = useMemo(
    () => getEditableTableIds(database).map(String).sort(),
    [database],
  );
  const sortedSelection = [...selectedTableIds].sort();
  const hasSelectionChanges =
    currentSelection.length !== sortedSelection.length ||
    currentSelection.some((id, index) => id !== sortedSelection[index]);
  const staleSelections = useMemo(() => {
    const knownIds = new Set(tables.map((table) => String(table.id)));
    return selectedTableIds.filter((id) => !knownIds.has(id));
  }, [selectedTableIds, tables]);

  if (
    !dataEditingSetting ||
    !shouldShowSection ||
    !allowedToEnableTableEditing
  ) {
    return null;
  }

  const isEnabled = isDatabaseTableEditingEnabled(database);

  const handleToggle = async (enabled: boolean) => {
    try {
      setToggleError(null);
      await updateDatabase({
        id: database.id,
        settings: { [DATABASE_TABLE_EDITING_SETTING]: enabled },
      });
    } catch (error) {
      setToggleError(getResponseErrorMessage(error) ?? t`An error occurred`);
    }
  };

  const handleSaveAllowlist = async () => {
    try {
      setAllowlistError(null);
      setIsSavingAllowlist(true);

      const editableTableIds = selectedTableIds
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isInteger(value) && value > 0)
        .sort((left, right) => left - right);

      await updateDatabase({
        id: database.id,
        settings: {
          [DATABASE_EDITABLE_TABLE_IDS_SETTING]: editableTableIds,
        },
      });
    } catch (error) {
      setAllowlistError(getResponseErrorMessage(error) ?? t`An error occurred`);
    } finally {
      setIsSavingAllowlist(false);
    }
  };

  return (
    <DatabaseInfoSection
      name={t`Editable table data`}
      description={t`Allow Admins to edit rows from Browse Data for specific writable tables in this database.`}
      data-testid="database-table-editing-section"
    >
      <Flex align="center" justify="space-between" mb="xs">
        <Label htmlFor="table-editing-toggle">{t`Enable table editor`}</Label>
        <Toggle
          id="table-editing-toggle"
          value={isEnabled}
          onChange={handleToggle}
          disabled={isSettingDisabled || (!isEnabled && databaseHasRouting)}
        />
      </Flex>

      <Box maw="26rem">
        {toggleError ? <Error>{toggleError}</Error> : null}
        <Description>
          {firstDisabledReason?.message ??
            t`Your database connection needs INSERT, UPDATE, and DELETE permissions.`}
        </Description>
      </Box>

      {databaseHasRouting && (
        <Alert variant="light" color="info" icon={<Icon name="info" />} mt="md">
          {t`Table editing can't be enabled when database routing is enabled.`}
        </Alert>
      )}

      <DatabaseInfoSectionDivider condensed />

      <Stack gap="md" data-testid="table-editing-allowlist-section">
        <Flex align="center" justify="space-between" gap="md">
          <Box>
            <Label>{t`Editable tables`}</Label>
            <Description>
              {t`Only allowlisted tables will show the Edit button in Browse Data.`}
            </Description>
          </Box>
          <Button
            onClick={handleSaveAllowlist}
            loading={isSavingAllowlist}
            disabled={isSettingDisabled || !hasSelectionChanges}
          >
            {t`Save table list`}
          </Button>
        </Flex>

        <TextInput
          value={searchValue}
          onChange={(event) => setSearchValue(event.currentTarget.value)}
          placeholder={t`Filter tables`}
        />

        {allowlistError ? <Error>{allowlistError}</Error> : null}

        {staleSelections.length > 0 && (
          <Alert variant="light" color="info" icon={<Icon name="info" />}>
            {t`${staleSelections.length} saved table selection(s) are not in the current metadata sync yet.`}
          </Alert>
        )}

        <Text size="sm" c="text-secondary">
          {t`${selectedTableIds.length} table(s) selected`}
        </Text>

        <Box
          p="md"
          bg="bg-white"
          bd="1px solid var(--mb-color-border)"
          style={{ borderRadius: 8, maxHeight: 320, overflowY: "auto" }}
        >
          {isLoadingTables ? (
            <Flex justify="center" py="lg">
              <Loader size="sm" />
            </Flex>
          ) : filteredTables.length === 0 ? (
            <Text size="sm" c="text-secondary">
              {tables.length === 0
                ? t`No tables are available for this database yet.`
                : t`No tables match the current filter.`}
            </Text>
          ) : (
            <Checkbox.Group
              value={selectedTableIds}
              onChange={setSelectedTableIds}
            >
              <Stack gap="sm">
                {filteredTables.map((table) => (
                  <Checkbox
                    key={table.id}
                    value={String(table.id)}
                    label={table.display_name || table.name}
                    description={getTableDescription(table)}
                  />
                ))}
              </Stack>
            </Checkbox.Group>
          )}
        </Box>
      </Stack>
    </DatabaseInfoSection>
  );
}

function getTableDescription(table: Table) {
  const schema = table.schema ? `${table.schema} · ` : "";
  const tableName =
    table.display_name && table.display_name !== table.name
      ? table.name
      : `ID ${table.id}`;

  return `${schema}${tableName}`;
}

function sortTables(tables: Table[]) {
  return [...tables].sort((left, right) => {
    const leftSchema = left.schema ?? "";
    const rightSchema = right.schema ?? "";

    if (leftSchema !== rightSchema) {
      return leftSchema.localeCompare(rightSchema);
    }

    return (left.display_name || left.name).localeCompare(
      right.display_name || right.name,
    );
  });
}

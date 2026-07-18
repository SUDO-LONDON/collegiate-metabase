import { useEffect, useMemo, useState } from "react";
import { t } from "ttag";

import {
  SettingsPageWrapper,
  SettingsSection,
} from "metabase/admin/components/SettingsSection";
import { AdminSettingInput } from "metabase/admin/settings/components/widgets/AdminSettingInput";
import { useUpdateSettingMutation } from "metabase/api/settings";
import {
  type StarRezExportResult,
  type StarRezMetadataSyncResult,
  type StarRezRunExportRequest,
  type StarRezScheduledRefreshStatus,
  type StarRezStatus,
  useActivateStarRezWeekMutation,
  useDeleteStarRezExportMutation,
  useGetStarRezStatusQuery,
  useListStarRezExportsQuery,
  useListStarRezWeeksQuery,
  useRefreshStarRezWeeksMutation,
  useRunStarRezExportMutation,
  useTestStarRezConnectionMutation,
  useTestStarRezDbMutation,
} from "metabase/api/starrez";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Flex,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from "metabase/ui";

const EMPTY_REPORT_IDS: string[] = [];

function getSnapshotLabel(blobFiles: Record<string, string>) {
  const keys = Object.keys(blobFiles);
  const reportKeys = keys.filter((key) =>
    blobFiles[key]?.includes("starrez_report_"),
  );

  if (keys.length === 0) {
    return t`Empty snapshot`;
  }

  if (reportKeys.length === keys.length) {
    return reportKeys.length === 1
      ? `${t`Report`} ${reportKeys[0]}`
      : `${t`Reports`} ${reportKeys.join(", ")}`;
  }

  return keys.join(", ");
}

function getInputValue(name: string) {
  const element = document.getElementById(name);

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    return element.value;
  }

  return undefined;
}

function getManualExportSettings(): StarRezRunExportRequest {
  const exportTables = getInputValue("starrez-export-tables");
  const exportReports = getInputValue("starrez-export-reports");

  return {
    ...(exportTables != null ? { export_tables: exportTables } : {}),
    ...(exportReports != null ? { export_reports: exportReports } : {}),
  };
}

function getFullRefreshSettings(): StarRezRunExportRequest {
  return {
    ...getManualExportSettings(),
    include_historical_reports: true,
    activate_table_snapshot: true,
  };
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values));
}

function formatDateTime(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatCount(value: number | undefined): string {
  return (value ?? 0).toLocaleString();
}

function getReportTotals(result: StarRezExportResult) {
  const reports = result.merge?.reports ?? [];

  return {
    count: reports.length,
    inserted: reports.reduce((sum, report) => sum + (report.inserted ?? 0), 0),
    updated: reports.reduce((sum, report) => sum + (report.updated ?? 0), 0),
    addedColumns: reports.reduce(
      (sum, report) => sum + (report.added_columns?.length ?? 0),
      0,
    ),
    failures: reports.filter((report) => report.error).length,
  };
}

function getMetadataSync(
  result: StarRezExportResult,
): StarRezMetadataSyncResult | undefined {
  return result.activation?.metadata_sync ?? result.merge?.metadata_sync;
}

function hasExportIssues(result: StarRezExportResult): boolean {
  const metadataSync = getMetadataSync(result);

  return Boolean(
    result.error ||
    result.activation?.error ||
    metadataSync?.error ||
    result.results?.some((exportItem) => !exportItem.success) ||
    result.merge?.reports.some((report) => report.error),
  );
}

type ScheduledRefreshBadge = {
  color?: "info" | "success" | "warning" | "error";
  label: string;
};

function getScheduledRefreshBadge(
  lastRun?: StarRezScheduledRefreshStatus | null,
): ScheduledRefreshBadge {
  switch (lastRun?.status) {
    case "running":
      return { color: "info", label: t`Running` };
    case "completed":
      return { color: "success", label: t`Completed` };
    case "completed_with_issues":
      return { color: "warning", label: t`Completed with issues` };
    case "failed":
      return { color: "error", label: t`Failed` };
    default:
      return { color: undefined, label: t`No run recorded` };
  }
}

function MetadataSyncStatus({ sync }: { sync?: StarRezMetadataSyncResult }) {
  if (!sync) {
    return null;
  }

  if (sync.synced) {
    return (
      <Text size="sm" c="success">
        {sync.database_id
          ? t`Metabase metadata synced for database ${sync.database_id}.`
          : t`Metabase metadata synced.`}
      </Text>
    );
  }

  return (
    <Text size="sm" c={sync.error ? "error" : "text-secondary"}>
      {sync.error ?? t`Metabase metadata was not synced.`}
    </Text>
  );
}

function ScheduledRefreshStatusSection({
  status,
  onRefresh,
}: {
  status?: StarRezStatus;
  onRefresh: () => Promise<unknown> | unknown;
}) {
  const lastRun = status?.scheduled_refresh?.last_run;
  const badge = getScheduledRefreshBadge(lastRun);
  const errors = lastRun?.errors ?? [];

  return (
    <SettingsSection title={t`Scheduled Refresh`}>
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" gap="md" wrap="wrap">
          <Stack gap={4}>
            <Group gap="sm">
              <Badge variant="light">{t`Daily at 1:00 AM`}</Badge>
              <Badge color={badge.color}>{badge.label}</Badge>
            </Group>

            {lastRun?.status === "running" && lastRun.started_at ? (
              <Text c="text-secondary">
                {t`Started ${formatDateTime(lastRun.started_at)}.`}
              </Text>
            ) : lastRun?.completed_at ? (
              <Text c="text-secondary">
                {t`Last completed ${formatDateTime(lastRun.completed_at)}.`}
              </Text>
            ) : (
              <Text c="text-secondary">
                {t`No scheduled refresh has been recorded yet.`}
              </Text>
            )}
          </Stack>

          <Button variant="subtle" size="sm" onClick={() => onRefresh()}>
            {t`Refresh status`}
          </Button>
        </Group>

        {lastRun ? (
          <Paper withBorder p="md">
            <Stack gap="xs">
              <Text size="sm" c="text-secondary">
                {t`Exports: ${formatCount(lastRun.exports_total)} total, ${formatCount(
                  lastRun.exports_failed,
                )} failed.`}
              </Text>
              <Text size="sm" c="text-secondary">
                {t`Reports: ${formatCount(lastRun.reports_total)} refreshed, ${formatCount(
                  lastRun.reports_inserted,
                )} inserted, ${formatCount(lastRun.reports_updated)} updated, ${formatCount(
                  lastRun.added_columns,
                )} new columns.`}
              </Text>
              <Text size="sm" c="text-secondary">
                {t`Snapshots recorded: ${formatCount(lastRun.snapshots_total)}.`}
              </Text>
              <MetadataSyncStatus sync={lastRun.metadata_sync} />
            </Stack>
          </Paper>
        ) : null}

        {errors.length > 0 ? (
          <Alert color="error" variant="light">
            <Stack gap={4}>
              {errors.map((error, index) => (
                <Text key={`${index}-${error}`} size="sm">
                  {error}
                </Text>
              ))}
            </Stack>
          </Alert>
        ) : null}
      </Stack>
    </SettingsSection>
  );
}

function ExportResultSummary({ result }: { result: StarRezExportResult }) {
  const activationResults = result.activation?.results ?? [];
  const reportTotals = getReportTotals(result);
  const hasIssues = hasExportIssues(result);

  return (
    <Paper
      withBorder
      p="md"
      style={{
        borderColor: hasIssues
          ? "var(--mb-color-warning)"
          : "var(--mb-color-success)",
      }}
    >
      <Stack gap="xs">
        <Group gap="sm">
          <Badge color={hasIssues ? "warning" : "success"}>
            {hasIssues ? t`Completed with issues` : t`Completed`}
          </Badge>
          {result.completed_at && (
            <Text
              fw={700}
            >{t`Finished ${formatDateTime(result.completed_at)}`}</Text>
          )}
        </Group>

        {activationResults.length > 0 && (
          <Text size="sm" c="text-secondary">
            {t`Live tables updated: ${activationResults
              .map(
                (table) => `${table.table} (${formatCount(table.rows)} rows)`,
              )
              .join(", ")}`}
          </Text>
        )}

        {result.table_snapshot_id && !result.activation && (
          <Text size="sm" c="text-secondary">
            {t`Table snapshot ${result.table_snapshot_id} was recorded; live tables were not activated.`}
          </Text>
        )}

        {result.activation?.error && (
          <Text size="sm" c="error">
            {t`Live table activation failed: ${result.activation.error}`}
          </Text>
        )}

        {reportTotals.count > 0 && (
          <Text size="sm" c="text-secondary">
            {t`Reports refreshed: ${reportTotals.count}; inserted ${formatCount(
              reportTotals.inserted,
            )}; updated ${formatCount(reportTotals.updated)}; new columns ${formatCount(
              reportTotals.addedColumns,
            )}.`}
          </Text>
        )}

        {reportTotals.failures > 0 && (
          <Text size="sm" c="error">
            {t`Report refresh failures: ${reportTotals.failures}`}
          </Text>
        )}

        {result.snapshots && result.snapshots.length > 0 && (
          <Text size="sm" c="text-secondary">
            {t`Snapshots recorded: ${result.snapshots.join(", ")}`}
          </Text>
        )}

        <MetadataSyncStatus sync={getMetadataSync(result)} />
      </Stack>
    </Paper>
  );
}

function ConfigSection() {
  const [testConnection, { isLoading: testing, data: testResult }] =
    useTestStarRezConnectionMutation();

  return (
    <SettingsSection title={t`StarRez API Connection`}>
      <Stack gap="md">
        <AdminSettingInput
          name="starrez-api-url"
          title={t`StarRez REST Base URL`}
          description={t`Full URL including the REST path, e.g. https://yourinstance.starrezhousing.com/StarRezRest`}
          placeholder="https://yourinstance.starrezhousing.com/StarRezRest"
          inputType="text"
        />

        <AdminSettingInput
          name="starrez-api-username"
          title={t`Username`}
          description={t`StarRez REST API username (e.g. SUDOLONDON)`}
          placeholder="SUDOLONDON"
          inputType="text"
        />

        <AdminSettingInput
          name="starrez-api-token"
          title={t`REST Token`}
          description={t`Used as the password for HTTP Basic Auth (stored encrypted)`}
          placeholder={t`Paste your StarRez REST token`}
          inputType="password"
        />

        <AdminSettingInput
          name="starrez-blob-sas-url"
          title={t`Azure Blob Storage SAS URL`}
          description={t`Container-level SAS URL with read, write, delete, and list permissions`}
          placeholder="https://myaccount.blob.core.windows.net/mycontainer?sv=...&sig=..."
          inputType="password"
        />

        <AdminSettingInput
          name="starrez-export-tables"
          title={t`Tables to Export`}
          description={t`Comma-separated StarRez table names (e.g. RoomBooking,Entry,Person)`}
          placeholder="RoomBooking,Entry,Person"
          inputType="text"
        />

        <AdminSettingInput
          name="starrez-export-reports"
          title={t`Reports to Export`}
          description={t`Comma-separated StarRez report IDs or names. Leave blank to skip reports.`}
          placeholder="57161,RoomAvailability"
          inputType="text"
        />

        <AdminSettingInput
          name="starrez-sort-field"
          title={t`Sort Field`}
          description={t`Field name used to sort exported records (applied client-side; ignored if the field is missing)`}
          placeholder="DateModified"
          inputType="text"
        />

        <AdminSettingInput
          name="starrez-keep-versions"
          title={t`Distinct Versions to Keep`}
          description={t`Number of unique CSV snapshots to retain per table or report. Duplicate snapshots are removed; 0 = keep all unique snapshots.`}
          placeholder="5"
          inputType="number"
        />

        <Flex gap="md" align="center" wrap="wrap">
          <Button
            variant="outline"
            onClick={() => testConnection()}
            loading={testing}
          >
            {t`Test Connection`}
          </Button>

          {testResult && (
            <Alert
              color={testResult.ok ? "success" : "error"}
              py="xs"
              px="md"
              style={{ flex: 1 }}
            >
              {testResult.ok
                ? (testResult.message ?? t`Connected successfully`)
                : (testResult.error ?? t`Connection failed`)}
            </Alert>
          )}
        </Flex>
      </Stack>
    </SettingsSection>
  );
}

function ReportAutoRefreshSection({
  status,
  onStatusChanged,
}: {
  status?: StarRezStatus;
  onStatusChanged: () => Promise<unknown> | unknown;
}) {
  const [updateSetting] = useUpdateSettingMutation();
  const savedDisabledReportIds =
    status?.report_refresh.disabled_report_ids ?? EMPTY_REPORT_IDS;
  const reports = status?.report_refresh.reports ?? [];
  const [disabledReportIds, setDisabledReportIds] = useState<string[]>(
    savedDisabledReportIds,
  );
  const [savingReportId, setSavingReportId] = useState<string | null>(null);

  useEffect(() => {
    setDisabledReportIds(savedDisabledReportIds);
  }, [savedDisabledReportIds]);

  const disabledReportIdSet = useMemo(
    () => new Set(disabledReportIds),
    [disabledReportIds],
  );
  const selectedReportCount = reports.filter(
    (report) => !disabledReportIdSet.has(report.id),
  ).length;

  const saveDisabledReportIds = async (
    nextDisabledReportIds: string[],
    reportId: string,
  ) => {
    const normalizedReportIds = uniqueValues(nextDisabledReportIds);
    setDisabledReportIds(normalizedReportIds);
    setSavingReportId(reportId);

    try {
      await updateSetting({
        key: "starrez-auto-refresh-disabled-reports",
        value: normalizedReportIds,
      }).unwrap();
      await onStatusChanged();
    } catch {
      setDisabledReportIds(savedDisabledReportIds);
    } finally {
      setSavingReportId(null);
    }
  };

  const handleReportToggle = async (reportId: string, checked: boolean) => {
    const nextDisabledReportIds = checked
      ? disabledReportIds.filter(
          (disabledReportId) => disabledReportId !== reportId,
        )
      : [...disabledReportIds, reportId];

    await saveDisabledReportIds(nextDisabledReportIds, reportId);
  };

  const handleSelectAll = async () => {
    await saveDisabledReportIds([], "all");
  };

  return (
    <SettingsSection title={t`Reports Automatically Refreshed`}>
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Text c="text-secondary">
            {reports.length > 0
              ? t`${selectedReportCount} of ${reports.length} reports selected for automatic refresh.`
              : t`Add report IDs above to make them available for automatic refresh.`}
          </Text>
          <Button
            variant="subtle"
            size="sm"
            disabled={disabledReportIds.length === 0}
            loading={savingReportId === "all"}
            onClick={handleSelectAll}
          >
            {t`Select all`}
          </Button>
        </Group>

        {reports.length === 0 ? (
          <Text c="text-secondary">
            {t`No reports have been configured or exported yet.`}
          </Text>
        ) : (
          <Stack gap="sm">
            {reports.map((report) => {
              const selected = !disabledReportIdSet.has(report.id);

              return (
                <Paper key={report.id} withBorder p="md">
                  <Flex
                    justify="space-between"
                    align="center"
                    gap="md"
                    wrap="wrap"
                  >
                    <Stack gap={4}>
                      <Group gap="sm">
                        <Title order={5}>{report.id}</Title>
                        {report.configured && (
                          <Badge variant="light">{t`Configured`}</Badge>
                        )}
                        {report.previously_exported && (
                          <Badge variant="light">{t`Previously exported`}</Badge>
                        )}
                        <Badge
                          color={selected ? "success" : undefined}
                          variant={selected ? "filled" : "light"}
                        >
                          {selected ? t`Selected` : t`Skipped`}
                        </Badge>
                      </Group>
                      <Text size="sm" c="text-secondary">
                        {selected
                          ? t`Included in scheduled refresh and Refresh all StarRez data.`
                          : t`Excluded until selected again.`}
                      </Text>
                    </Stack>
                    <Checkbox
                      checked={selected}
                      disabled={savingReportId != null}
                      onChange={(event) =>
                        handleReportToggle(
                          report.id,
                          event.currentTarget.checked,
                        )
                      }
                      aria-label={t`Refresh report ${report.id} automatically`}
                    />
                  </Flex>
                </Paper>
              );
            })}
          </Stack>
        )}
      </Stack>
    </SettingsSection>
  );
}

function ExportSection() {
  const [runExport, { isLoading: exporting, data: exportResult }] =
    useRunStarRezExportMutation();

  return (
    <SettingsSection title={t`Export StarRez Data`}>
      <Stack gap="md">
        <Text c="text-secondary">
          {t`Pull StarRez data, record CSV snapshots, update PostgreSQL report tables, and sync Metabase metadata.`}
        </Text>

        <Flex gap="md" align="center" wrap="wrap">
          <Button
            variant="filled"
            onClick={() => runExport(getFullRefreshSettings())}
            loading={exporting}
          >
            {t`Refresh all StarRez data`}
          </Button>
          <Button
            variant="outline"
            onClick={() => runExport(getManualExportSettings())}
            loading={exporting}
          >
            {t`Export snapshots only`}
          </Button>
          {exporting && (
            <Text c="text-secondary">{t`Refreshing StarRez data…`}</Text>
          )}
        </Flex>

        {exportResult?.error && (
          <Alert color="error">{exportResult.error}</Alert>
        )}

        {exportResult && !exportResult.error && (
          <ExportResultSummary result={exportResult} />
        )}

        {exportResult?.results && (
          <Stack gap="sm">
            <Title order={4}>{t`Export Results`}</Title>
            {exportResult.results.map((r) => (
              <Paper key={`${r.kind}-${r.name}`} withBorder p="md">
                <Flex justify="space-between" align="center">
                  <Stack gap={4}>
                    <Group gap="sm">
                      <Badge variant="light">
                        {r.kind === "report" ? t`Report` : t`Table`}
                      </Badge>
                      <Title order={5}>{r.name}</Title>
                      <Badge color={r.success ? "success" : "error"}>
                        {r.success ? t`Success` : t`Failed`}
                      </Badge>
                    </Group>
                    <Text size="sm" c="text-secondary" ff="monospace">
                      {r.blob_name}
                    </Text>
                    {r.error && (
                      <Text size="sm" c="error">
                        {r.error}
                      </Text>
                    )}
                  </Stack>
                  {typeof r.records_count === "number" && (
                    <Text size="sm" c="text-secondary">
                      {r.records_count.toLocaleString()} {t`records`}
                    </Text>
                  )}
                </Flex>
              </Paper>
            ))}
          </Stack>
        )}

        {exportResult?.merge && (
          <Stack gap="sm">
            <Title order={4}>{t`Report Database Updates`}</Title>
            {exportResult.merge.destination_table && (
              <Text size="sm" c="text-secondary">
                {t`Destination table: ${exportResult.merge.destination_table}`}
              </Text>
            )}
            {exportResult.merge.metadata_sync?.error && (
              <Alert color="error">
                {exportResult.merge.metadata_sync.error}
              </Alert>
            )}
            {exportResult.merge.reports.map((report) => {
              const statusLabel = report.error
                ? t`Failed`
                : report.created_table
                  ? t`Created`
                  : report.replaced_table
                    ? t`Replaced`
                    : t`Merged`;

              return (
                <Paper key={report.report_id} withBorder p="md">
                  <Stack gap={4}>
                    <Group gap="sm">
                      <Badge variant="light">{t`Report`}</Badge>
                      <Title order={5}>{report.report_id}</Title>
                      <Badge color={report.error ? "error" : "success"}>
                        {statusLabel}
                      </Badge>
                    </Group>
                    <Text size="sm" c="text-secondary" ff="monospace">
                      {report.destination_table}
                    </Text>
                    {report.error ? (
                      <Text size="sm" c="error">
                        {report.error}
                      </Text>
                    ) : (
                      <Stack gap={2}>
                        <Text size="sm" c="text-secondary">
                          {t`Updated: ${report.updated?.toLocaleString() ?? "0"}`}{" "}
                          •{" "}
                          {t`Inserted: ${report.inserted?.toLocaleString() ?? "0"}`}{" "}
                          •{" "}
                          {t`New columns: ${report.added_columns?.length ?? 0}`}
                        </Text>
                        {report.merge_key_issue && (
                          <Text size="sm" c="text-secondary">
                            {t`Loaded by replacement: ${report.merge_key_issue}`}
                          </Text>
                        )}
                      </Stack>
                    )}
                  </Stack>
                </Paper>
              );
            })}
          </Stack>
        )}
      </Stack>
    </SettingsSection>
  );
}

function PastExportsSection() {
  const { data, isLoading, refetch } = useListStarRezExportsQuery();
  const [deleteExport, { isLoading: deleting }] =
    useDeleteStarRezExportMutation();

  const exports = data?.exports ?? [];

  return (
    <SettingsSection title={t`Past Exports in Blob Storage`}>
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Text c="text-secondary">
            {t`Files stored in Azure Blob Storage. Old versions are pruned automatically on each export.`}
          </Text>
          <Button variant="subtle" size="sm" onClick={() => refetch()}>
            {t`Refresh list`}
          </Button>
        </Group>

        {isLoading ? (
          <Flex justify="center" py="xl">
            <Loader />
          </Flex>
        ) : data?.error ? (
          <Alert color="error">{data.error}</Alert>
        ) : exports.length === 0 ? (
          <Text c="text-secondary">
            {t`No exports found. Run an export above to get started.`}
          </Text>
        ) : (
          <Stack gap="sm">
            {exports.map((file) => (
              <Paper key={file.name} withBorder p="md">
                <Flex justify="space-between" align="center">
                  <Stack gap={4}>
                    <Text size="sm" ff="monospace">
                      {file.name}
                    </Text>
                    <Group gap="md">
                      {file.last_modified && (
                        <Text size="xs" c="text-secondary">
                          {file.last_modified}
                        </Text>
                      )}
                      {file.size && (
                        <Text size="xs" c="text-secondary">
                          {formatBytes(Number(file.size))}
                        </Text>
                      )}
                    </Group>
                  </Stack>
                  <Button
                    variant="subtle"
                    color="error"
                    size="xs"
                    loading={deleting}
                    onClick={() => deleteExport(file.name)}
                  >
                    {t`Delete`}
                  </Button>
                </Flex>
              </Paper>
            ))}
          </Stack>
        )}
      </Stack>
    </SettingsSection>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function PostgresConfigSection() {
  const [testDb, { isLoading: testing, data: testResult }] =
    useTestStarRezDbMutation();

  return (
    <SettingsSection title={t`Postgres Database (StarRez data)`}>
      <Stack gap="md">
        <Text c="text-secondary">
          {t`Where StarRez snapshots are loaded for dashboarding. Should point at your Azure Postgres "starrez" database.`}
        </Text>

        <AdminSettingInput
          name="starrez-pg-host"
          title={t`Host`}
          description={t`e.g. yourserver.postgres.database.azure.com`}
          placeholder="yourserver.postgres.database.azure.com"
          inputType="text"
        />

        <AdminSettingInput
          name="starrez-pg-database"
          title={t`Database`}
          description={t`Name of the Postgres database`}
          placeholder="starrez"
          inputType="text"
        />

        <AdminSettingInput
          name="starrez-pg-user"
          title={t`Username`}
          placeholder="mbadmin"
          inputType="text"
        />

        <AdminSettingInput
          name="starrez-pg-password"
          title={t`Password`}
          description={t`Stored encrypted`}
          placeholder={t`Postgres password`}
          inputType="password"
        />

        <AdminSettingInput
          name="starrez-metabase-database-id"
          title={t`Metabase Database ID`}
          description={t`Optional. The Metabase database ID for this Postgres connection. Used to refresh the table browser after activation.`}
          placeholder="2"
          inputType="number"
        />

        <Flex gap="md" align="center">
          <Button variant="outline" onClick={() => testDb()} loading={testing}>
            {t`Test Postgres Connection`}
          </Button>
          {testResult && (
            <Alert
              color={testResult.ok ? "success" : "error"}
              py="xs"
              px="md"
              style={{ flex: 1 }}
            >
              {testResult.ok
                ? (testResult.message ?? t`Connected successfully`)
                : (testResult.error ?? t`Connection failed`)}
            </Alert>
          )}
        </Flex>
      </Stack>
    </SettingsSection>
  );
}

function SnapshotsSection() {
  const { data, isLoading } = useListStarRezWeeksQuery();
  const [refreshSnapshots, { isLoading: refreshing, data: refreshResult }] =
    useRefreshStarRezWeeksMutation();
  const [activate, { isLoading: activating, data: activateResult }] =
    useActivateStarRezWeekMutation();

  const snapshots = data?.weeks ?? [];

  return (
    <SettingsSection title={t`Snapshots`}>
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Text c="text-secondary">
            {t`Saved export snapshots. Activating a snapshot reloads its StarRez tables into PostgreSQL.`}
          </Text>
          <Button
            variant="subtle"
            size="sm"
            loading={refreshing}
            onClick={() => refreshSnapshots()}
          >
            {t`Sync metadata`}
          </Button>
        </Group>

        {refreshResult?.metadata_sync?.synced && (
          <Alert color="success">
            {t`Snapshot list refreshed and Metabase metadata synced.`}
          </Alert>
        )}
        {refreshResult?.metadata_sync &&
          !refreshResult.metadata_sync.synced &&
          !refreshResult.metadata_sync.error && (
            <Alert color="warning">
              {t`Snapshot list refreshed, but Metabase metadata was not synced.`}
            </Alert>
          )}
        {refreshResult?.error && (
          <Alert color="error">{refreshResult.error}</Alert>
        )}
        {refreshResult?.metadata_sync?.error && (
          <Alert color="error">{refreshResult.metadata_sync.error}</Alert>
        )}
        {activateResult?.error && (
          <Alert color="error">{activateResult.error}</Alert>
        )}
        {activateResult?.results && (
          <Alert color="success">
            {t`Activated. Tables loaded: ${activateResult.results
              .map((r) => `${r.table} (${r.rows.toLocaleString()} rows)`)
              .join(", ")}`}
          </Alert>
        )}
        {activateResult?.metadata_sync && (
          <MetadataSyncStatus sync={activateResult.metadata_sync} />
        )}

        {isLoading ? (
          <Flex justify="center" py="xl">
            <Loader />
          </Flex>
        ) : data?.error ? (
          <Alert color="error">{data.error}</Alert>
        ) : snapshots.length === 0 ? (
          <Text c="text-secondary">
            {t`No snapshots yet. Run an export to create one.`}
          </Text>
        ) : (
          <Stack gap="sm">
            {snapshots.map((w) => (
              <Paper
                key={w.id}
                withBorder
                p="md"
                style={
                  w.is_active
                    ? { borderColor: "var(--mb-color-success)" }
                    : undefined
                }
              >
                <Flex justify="space-between" align="center">
                  <Stack gap={4}>
                    <Group gap="sm">
                      <Title order={5}>{getSnapshotLabel(w.blob_files)}</Title>
                      {w.is_active && (
                        <Badge color="success">{t`Active`}</Badge>
                      )}
                    </Group>
                    <Text size="xs" c="text-secondary">
                      {t`Exported: ${w.fetched_at}`} •{" "}
                      {Object.keys(w.blob_files).length} {t`files`}
                    </Text>
                  </Stack>
                  <Button
                    variant={w.is_active ? "subtle" : "filled"}
                    size="sm"
                    loading={activating}
                    disabled={w.is_active}
                    onClick={() => activate(w.id)}
                  >
                    {w.is_active ? t`Active` : t`Activate`}
                  </Button>
                </Flex>
              </Paper>
            ))}
          </Stack>
        )}
      </Stack>
    </SettingsSection>
  );
}

export function StarRezSettingsPage() {
  const { data: status, refetch: refetchStatus } = useGetStarRezStatusQuery();

  const allConfigured =
    status?.configured.api_url &&
    status?.configured.api_username &&
    status?.configured.api_token &&
    status?.configured.blob_sas_url &&
    status?.configured.pg_host &&
    status?.configured.pg_user &&
    status?.configured.pg_password;

  return (
    <SettingsPageWrapper
      title={t`StarRez Data Refresh`}
      description={t`Connect StarRez, refresh data into PostgreSQL, and sync Metabase metadata for reporting.`}
    >
      {status && !allConfigured && (
        <Alert color="warning" mb="lg">
          {t`Complete all configuration fields below before running an export.`}
        </Alert>
      )}

      <ConfigSection />
      <ReportAutoRefreshSection
        status={status}
        onStatusChanged={refetchStatus}
      />
      <ScheduledRefreshStatusSection
        status={status}
        onRefresh={refetchStatus}
      />
      <PostgresConfigSection />
      <ExportSection />
      <SnapshotsSection />
      <PastExportsSection />
    </SettingsPageWrapper>
  );
}

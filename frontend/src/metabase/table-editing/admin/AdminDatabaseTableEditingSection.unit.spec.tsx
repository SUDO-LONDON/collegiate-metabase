import userEvent from "@testing-library/user-event";
import fetchMock from "fetch-mock";

import { renderWithProviders, screen, waitFor } from "__support__/ui";
import type { DatabaseLocalSettingAvailability } from "metabase-types/api";
import { createMockDatabase, createMockTable } from "metabase-types/api/mocks";

import { DATABASE_TABLE_EDITING_SETTING } from "../settings";

import { AdminDatabaseTableEditingSection } from "./AdminDatabaseTableEditingSection";

const setup = async (options?: {
  driverSetting?: DatabaseLocalSettingAvailability;
  engine?: string;
  updateDatabase?: jest.Mock;
  waitForTables?: boolean;
}) => {
  const table1 = createMockTable({
    id: 10,
    name: "weekly_lookup",
    display_name: "Weekly Lookup",
    schema: "config",
  });
  const table2 = createMockTable({
    id: 11,
    name: "room_type_lookup",
    display_name: "Room Type Lookup",
    schema: "config",
  });
  const {
    driverSetting = { enabled: true },
    engine = "postgres",
    updateDatabase = jest.fn(() => Promise.resolve()),
    waitForTables = true,
  } = options ?? {};

  const mockDatabase = createMockDatabase({
    id: 1,
    engine,
    tables: [table1, table2],
    settings: {
      "database-enable-table-editing": true,
      "database-editable-table-ids": [10],
    },
  });

  fetchMock.get(`path:/api/database/${mockDatabase.id}/metadata`, mockDatabase);

  renderWithProviders(
    <AdminDatabaseTableEditingSection
      database={mockDatabase}
      settingsAvailable={{
        [DATABASE_TABLE_EDITING_SETTING]: driverSetting,
      }}
      updateDatabase={updateDatabase}
    />,
  );

  if (waitForTables) {
    await screen.findByText("Weekly Lookup");
  }

  return { updateDatabase };
};

describe("AdminDatabaseTableEditingSection", () => {
  it("saves the editable table allowlist", async () => {
    const { updateDatabase } = await setup();
    const user = userEvent.setup();

    await user.click(screen.getByLabelText("Room Type Lookup"));
    await user.click(screen.getByRole("button", { name: "Save table list" }));

    await waitFor(() => {
      expect(updateDatabase).toHaveBeenCalledWith({
        id: 1,
        settings: {
          "database-editable-table-ids": [10, 11],
        },
      });
    });
  });

  it("hides the section for unsupported engines", async () => {
    await setup({ engine: "h2", waitForTables: false });

    expect(
      screen.queryByTestId("database-table-editing-section"),
    ).not.toBeInTheDocument();
  });
});

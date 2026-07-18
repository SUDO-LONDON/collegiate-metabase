import type { DatabaseSettings } from "metabase-types/api";
import { createMockDatabase } from "metabase-types/api/mocks";

import {
  getEditableTableIds,
  isDatabaseTableEditingEnabled,
  isTableEditable,
} from "./settings";

describe("table-editing settings helpers", () => {
  it("sanitizes editable table ids", () => {
    const database = createMockDatabase({
      settings: {
        "database-editable-table-ids": [1, "2", " 3 ", "oops", -1, 2],
      } as DatabaseSettings,
    });

    expect(getEditableTableIds(database)).toEqual([1, 2, 3]);
  });

  it("checks table editability from database settings", () => {
    const database = createMockDatabase({
      settings: {
        "database-enable-table-editing": true,
        "database-editable-table-ids": [10, 20],
      },
    });

    expect(isDatabaseTableEditingEnabled(database)).toBe(true);
    expect(isTableEditable(database, 20)).toBe(true);
    expect(isTableEditable(database, 30)).toBe(false);
  });
});

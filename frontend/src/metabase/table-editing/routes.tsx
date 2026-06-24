import { Route } from "react-router";

import { TableEditPage } from "./TableEditPage";

export function getRoutes() {
  return (
    <Route
      path="databases/:dbId/tables/:tableId/edit"
      component={TableEditPage}
    />
  );
}

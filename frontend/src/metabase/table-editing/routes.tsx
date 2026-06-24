import { type ComponentType, useEffect, useState } from "react";
import { Route } from "react-router";

import { Flex, Loader } from "metabase/ui";

type TableEditPageProps = {
  params: {
    dbId: string;
    tableId: string;
  };
};

export function getRoutes() {
  return (
    <Route
      path="databases/:dbId/tables/:tableId/edit"
      component={TableEditPageRoute}
    />
  );
}

function TableEditPageRoute(props: TableEditPageProps) {
  const [TableEditPage, setTableEditPage] =
    useState<ComponentType<TableEditPageProps> | null>(null);

  useEffect(() => {
    let isMounted = true;

    void import("./TableEditPage").then(({ TableEditPage: LoadedPage }) => {
      if (isMounted) {
        setTableEditPage(() => LoadedPage);
      }
    });

    return () => {
      isMounted = false;
    };
  }, []);

  if (!TableEditPage) {
    return (
      <Flex align="center" justify="center" py="xl">
        <Loader size="sm" />
      </Flex>
    );
  }

  return <TableEditPage {...props} />;
}

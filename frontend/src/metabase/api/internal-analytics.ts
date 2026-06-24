import api from "metabase/api/legacy-client";

type InternalAnalyticsEvent = {
  op: "inc" | "dec" | "set" | "observe" | "clear";
  metric: string;
  labels?: Record<string, string> | null;
  amount?: number;
};

export function postInternalAnalytics(
  events: InternalAnalyticsEvent[],
): Promise<void> {
  return api.POST("/api/analytics/internal")({ events });
}

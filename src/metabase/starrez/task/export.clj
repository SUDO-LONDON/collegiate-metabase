(ns metabase.starrez.task.export
  "Scheduled StarRez export job."
  (:require
   [clojurewerkz.quartzite.jobs :as jobs]
   [clojurewerkz.quartzite.schedule.cron :as cron]
   [clojurewerkz.quartzite.triggers :as triggers]
   [metabase.starrez.export :as starrez.export]
   [metabase.task.core :as task]
   [metabase.util.log :as log]))

(set! *warn-on-reflection* true)

;; Keep the original Quartz identities so existing deployed weekly triggers are rescheduled, not duplicated.
(def ^:private scheduled-export-job-key
  (jobs/key "metabase.task.starrez.weekly-export.job"))

(def ^:private scheduled-export-trigger-key
  (triggers/key "metabase.task.starrez.weekly-export.trigger"))

(def ^:private daily-export-cron
  "0 0 1 * * ? *")

(task/defjob ^{:doc "Daily StarRez export and cumulative report merge."
               org.quartz.DisallowConcurrentExecution true}
  StarRezWeeklyExport
  [_]
  (log/info "Starting scheduled StarRez daily export")
  (let [result        (starrez.export/run-export {:include-historical-reports? true})
        export-errors (seq (filter (comp not :success) (:results result)))
        merge-errors  (seq (filter :error (get-in result [:merge :reports])))]
    (if (or (:error result) export-errors merge-errors)
      (log/errorf "Scheduled StarRez daily export completed with errors: %s" (pr-str result))
      (log/infof "Scheduled StarRez daily export finished: %s" (pr-str result)))))

(defn- scheduled-export-job []
  (jobs/build
   (jobs/of-type StarRezWeeklyExport)
   (jobs/with-identity scheduled-export-job-key)))

(defn- scheduled-export-trigger []
  (triggers/build
   (triggers/with-identity scheduled-export-trigger-key)
   (triggers/with-schedule
    (cron/schedule
     (cron/cron-schedule daily-export-cron)
     (cron/with-misfire-handling-instruction-do-nothing)))))

(defmethod task/init! ::StarRezWeeklyExport [_]
  (task/schedule-task! (scheduled-export-job) (scheduled-export-trigger)))

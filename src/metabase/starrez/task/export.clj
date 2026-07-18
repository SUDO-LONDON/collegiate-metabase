(ns metabase.starrez.task.export
  "Scheduled StarRez export job."
  (:require
   [clojure.string :as str]
   [clojurewerkz.quartzite.jobs :as jobs]
   [clojurewerkz.quartzite.schedule.cron :as cron]
   [clojurewerkz.quartzite.triggers :as triggers]
   [metabase.starrez.export :as starrez.export]
   [metabase.starrez.settings :as starrez.settings]
   [metabase.task.core :as task]
   [metabase.util.log :as log])
  (:import
   (java.time OffsetDateTime)))

(set! *warn-on-reflection* true)

;; Keep the original Quartz identities so existing deployed weekly triggers are rescheduled, not duplicated.
(def ^:private scheduled-export-job-key
  (jobs/key "metabase.task.starrez.weekly-export.job"))

(def ^:private scheduled-export-trigger-key
  (triggers/key "metabase.task.starrez.weekly-export.trigger"))

(def scheduled-export-cron
  "Cron expression for the scheduled StarRez refresh. Runs every day at 1am."
  "0 0 1 * * ? *")

(defn- now-str []
  (str (OffsetDateTime/now)))

(defn- item-kind-label
  [kind]
  (-> (or kind :export)
      name
      str/capitalize))

(defn- failed-export-error
  [{:keys [kind name error]}]
  (format "%s %s: %s" (item-kind-label kind) name (or error "export failed")))

(defn- failed-report-error
  [{:keys [report_id error]}]
  (when error
    (format "Report %s: %s" report_id error)))

(defn- metadata-sync
  [result]
  (or (get-in result [:activation :metadata_sync])
      (get-in result [:merge :metadata_sync])))

(defn- scheduled-refresh-errors
  [result]
  (let [metadata-sync (metadata-sync result)]
    (vec
     (remove nil?
             (concat
              [(:error result)]
              (keep failed-export-error (filter (comp not :success) (:results result)))
              (keep failed-report-error (get-in result [:merge :reports]))
              [(when-let [error (get-in result [:activation :error])]
                 (str "Live table activation: " error))
               (when-let [error (:error metadata-sync)]
                 (str "Metabase metadata sync: " error))])))))

(defn- scheduled-refresh-result-status
  [started-at result]
  (let [errors        (scheduled-refresh-errors result)
        reports       (get-in result [:merge :reports])
        metadata-sync (metadata-sync result)]
    (cond-> {:status           (cond
                                 (:error result) "failed"
                                 (seq errors)    "completed_with_issues"
                                 :else           "completed")
             :schedule         scheduled-export-cron
             :started_at       started-at
             :completed_at     (or (:completed_at result) (now-str))
             :exports_total    (count (:results result))
             :exports_failed   (count (filter (comp not :success) (:results result)))
             :reports_total    (count reports)
             :reports_failed   (count (filter :error reports))
             :reports_inserted (reduce + (map #(or (:inserted %) 0) reports))
             :reports_updated  (reduce + (map #(or (:updated %) 0) reports))
             :added_columns    (reduce + (map #(count (:added_columns %)) reports))
             :snapshots_total  (count (:snapshots result))
             :errors           errors}
      metadata-sync
      (assoc :metadata_sync (select-keys metadata-sync [:database_id :synced :error])))))

(defn- scheduled-refresh-failure-status
  [started-at e]
  {:status       "failed"
   :schedule     scheduled-export-cron
   :started_at   started-at
   :completed_at (now-str)
   :errors       [(or (ex-message e) (str e))]})

(defn- record-scheduled-refresh-status!
  [status]
  (try
    (starrez.settings/starrez-scheduled-refresh-status! status)
    (catch Throwable e
      (log/warn e "Unable to record scheduled StarRez refresh status"))))

(task/defjob ^{:doc "Daily StarRez export and cumulative report merge."
               org.quartz.DisallowConcurrentExecution true}
  StarRezWeeklyExport
  [_]
  (let [started-at (now-str)]
    (log/info "Starting scheduled StarRez daily export")
    (record-scheduled-refresh-status! {:status     "running"
                                       :schedule   scheduled-export-cron
                                       :started_at started-at})
    (try
      (let [result (starrez.export/run-export {:include-historical-reports? true})
            status (scheduled-refresh-result-status started-at result)]
        (record-scheduled-refresh-status! status)
        (if (seq (:errors status))
          (log/errorf "Scheduled StarRez daily export completed with errors: %s" (pr-str result))
          (log/infof "Scheduled StarRez daily export finished: %s" (pr-str result))))
      (catch Throwable e
        (record-scheduled-refresh-status! (scheduled-refresh-failure-status started-at e))
        (log/error e "Scheduled StarRez daily export failed")
        (throw e)))))

(defn- scheduled-export-job []
  (jobs/build
   (jobs/of-type StarRezWeeklyExport)
   (jobs/with-identity scheduled-export-job-key)))

(defn- scheduled-export-trigger []
  (triggers/build
   (triggers/with-identity scheduled-export-trigger-key)
   (triggers/with-schedule
    (cron/schedule
     (cron/cron-schedule scheduled-export-cron)
     (cron/with-misfire-handling-instruction-do-nothing)))))

(defmethod task/init! ::StarRezWeeklyExport [_]
  (task/schedule-task! (scheduled-export-job) (scheduled-export-trigger)))

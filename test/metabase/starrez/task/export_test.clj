(ns metabase.starrez.task.export-test
  (:require
   [clojure.test :refer :all]
   [metabase.starrez.task.export :as starrez.task.export])
  (:import
   (org.quartz CronTrigger)))

(set! *warn-on-reflection* true)

(deftest scheduled-export-runs-daily-at-1am-test
  (let [^CronTrigger trigger (#'starrez.task.export/scheduled-export-trigger)]
    (is (= "0 0 1 * * ? *" (.getCronExpression trigger)))
    (is (= CronTrigger/MISFIRE_INSTRUCTION_DO_NOTHING (.getMisfireInstruction trigger)))))

(deftest scheduled-refresh-result-status-test
  (testing "summarizes scheduled refresh outcomes for the admin UI"
    (is (= {:status           "completed_with_issues"
            :schedule         "0 0 1 * * ? *"
            :started_at       "2026-07-18T01:00:00Z"
            :completed_at     "2026-07-18T01:02:00Z"
            :exports_total    2
            :exports_failed   1
            :reports_total    2
            :reports_failed   1
            :reports_inserted 5
            :reports_updated  7
            :added_columns    2
            :snapshots_total  1
            :errors           ["Report 123: No CSV body"
                               "Report 456: Merge failed"
                               "Metabase metadata sync: Sync failed"]
            :metadata_sync    {:synced false
                               :error  "Sync failed"}}
           (#'starrez.task.export/scheduled-refresh-result-status
            "2026-07-18T01:00:00Z"
            {:results      [{:kind :report :name "123" :success false :error "No CSV body"}
                            {:kind :table :name "Entry" :success true}]
             :snapshots    [12]
             :completed_at "2026-07-18T01:02:00Z"
             :merge        {:metadata_sync {:synced false :error "Sync failed"}
                            :reports       [{:report_id "123"
                                             :inserted  5
                                             :updated   7
                                             :added_columns ["notes" "status"]}
                                            {:report_id "456"
                                             :error     "Merge failed"}]}})))))

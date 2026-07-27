(ns metabase.starrez.export-test
  (:require
   [clojure.test :refer :all]
   [metabase.starrez.db :as starrez.db]
   [metabase.starrez.export :as starrez.export]
   [metabase.starrez.settings :as starrez.settings]))

(defn- without-completed-at [result]
  (dissoc result :completed_at :performance_cache))

(use-fixtures
  :each
  (fn [f]
    (with-redefs [starrez.db/refresh-weekly-net-bookings-fact-cache!
                  (constantly {:status "completed" :row_count 10})]
      (f))))

(deftest record-export-snapshots-keeps-reports-separate
  (let [recorded (atom [])]
    (with-redefs [starrez.db/record-export-week!
                  (fn [blob-files]
                    (swap! recorded conj blob-files)
                    (count @recorded))]
      (is (= [1 2 3]
             (#'starrez.export/record-export-snapshots!
              [{:kind :table
                :name "Entry"
                :blob_name "starrez_Entry_2026-05-28_12-07-33.csv"
                :success true}
               {:kind :report
                :name "59906"
                :blob_name "starrez_report_59906_2026-05-28_12-07-38.csv"
                :success true}
               {:kind :report
                :name "62751"
                :blob_name "starrez_report_62751_2026-05-28_12-08-38.csv"
                :success true}])))
      (is (= [{"Entry" "starrez_Entry_2026-05-28_12-07-33.csv"}
              {"59906" "starrez_report_59906_2026-05-28_12-07-38.csv"}
              {"62751" "starrez_report_62751_2026-05-28_12-08-38.csv"}]
             @recorded)))))

(deftest run-export-uses-configured-reports-by-default
  (let [requested-report-ids (atom [])
        merged              (atom nil)]
    (with-redefs [starrez.settings/starrez-export-tables
                  (constantly "")
                  starrez.settings/starrez-export-reports
                  (constantly "62751")
                  starrez.db/report-ids-for-export
                  (fn [_configured-report-ids]
                    (throw (ex-info "manual exports should not pull historical reports" {})))
                  starrez.export/export-report
                  (fn [report-id]
                    (swap! requested-report-ids conj report-id)
                    {:kind      :report
                     :name      report-id
                     :blob_name (str "starrez_report_" report-id "_2026-05-28_12-07-38.csv")
                     :csv_body  "Booking ID,Room\n123,A\n"
                     :success   true})
                  starrez.db/record-export-week!
                  (constantly 42)
                  starrez.db/merge-report-exports!
                  (fn [report-ids results]
                    (reset! merged {:report-ids report-ids :results results})
                    {:destination_table "starrez_data.table_62751"})]
      (is (= {:results
              [{:kind      :report
                :name      "62751"
                :blob_name "starrez_report_62751_2026-05-28_12-07-38.csv"
                :success   true}]
              :snapshots [42]
              :merge     {:destination_table "starrez_data.table_62751"}}
             (without-completed-at (starrez.export/run-export))))
      (is (= ["62751"] @requested-report-ids))
      (is (= ["62751"] (:report-ids @merged)))
      (is (every? :csv_body (:results @merged))))))

(deftest run-export-uses-manual-report-overrides
  (let [requested-report-ids (atom [])
        merged              (atom nil)]
    (with-redefs [starrez.settings/starrez-export-tables
                  (constantly "")
                  starrez.settings/starrez-export-reports
                  (constantly "last-saved-report")
                  starrez.db/report-ids-for-export
                  (fn [_configured-report-ids]
                    (throw (ex-info "manual exports should not pull historical reports" {})))
                  starrez.export/export-report
                  (fn [report-id]
                    (swap! requested-report-ids conj report-id)
                    {:kind      :report
                     :name      report-id
                     :blob_name (str "starrez_report_" report-id "_2026-05-28_12-07-38.csv")
                     :csv_body  "Booking ID,Room\n123,A\n"
                     :success   true})
                  starrez.db/record-export-week!
                  (constantly 42)
                  starrez.db/merge-report-exports!
                  (fn [report-ids results]
                    (reset! merged {:report-ids report-ids :results results})
                    {:destination_table "starrez_data.table_62751"})]
      (is (= {:results
              [{:kind      :report
                :name      "62751"
                :blob_name "starrez_report_62751_2026-05-28_12-07-38.csv"
                :success   true}]
              :snapshots [42]
              :merge     {:destination_table "starrez_data.table_62751"}}
             (without-completed-at (starrez.export/run-export {:export-reports "62751"}))))
      (is (= ["62751"] @requested-report-ids))
      (is (= ["62751"] (:report-ids @merged))))))

(deftest run-export-respects-blank-manual-report-overrides
  (with-redefs [starrez.settings/starrez-export-tables
                (constantly "")
                starrez.settings/starrez-export-reports
                (constantly "last-saved-report")
                starrez.export/export-report
                (fn [report-id]
                  (throw (ex-info "blank manual reports should not export saved reports"
                                  {:report-id report-id})))
                starrez.db/record-export-week!
                (fn [_blob-files]
                  (throw (ex-info "empty manual exports should not record snapshots" {})))
                starrez.db/merge-report-exports!
                (fn [_report-ids _results]
                  (throw (ex-info "empty manual exports should not merge reports" {})))]
    (is (= {:results [] :snapshots [] :merge nil}
           (without-completed-at (starrez.export/run-export {:export-reports ""}))))))

(deftest run-export-respects-blank-manual-table-overrides
  (with-redefs [starrez.settings/starrez-export-tables
                (constantly "Entry")
                starrez.settings/starrez-export-reports
                (constantly "")
                starrez.export/export-table
                (fn [table]
                  (throw (ex-info "blank manual tables should not export saved tables"
                                  {:table table})))
                starrez.db/record-export-week!
                (fn [_blob-files]
                  (throw (ex-info "empty manual exports should not record snapshots" {})))]
    (is (= {:results [] :snapshots [] :merge nil}
           (without-completed-at (starrez.export/run-export {:export-tables ""}))))))

(deftest run-export-can-activate-table-snapshot
  (let [recorded  (atom [])
        activated (atom nil)]
    (with-redefs [starrez.settings/starrez-export-tables
                  (constantly "Entry")
                  starrez.settings/starrez-export-reports
                  (constantly "")
                  starrez.export/export-table
                  (fn [table]
                    {:kind          :table
                     :name          table
                     :blob_name     (str "starrez_" table "_2026-05-28_12-07-33.csv")
                     :records_count 2
                     :success       true})
                  starrez.db/record-export-week!
                  (fn [blob-files]
                    (swap! recorded conj blob-files)
                    77)
                  starrez.db/activate-week!
                  (fn [week-id _downloader]
                    (reset! activated week-id)
                    {:results       [{:table "\"starrez_data\".\"Entry\""
                                      :rows 2
                                      :cols 3}]
                     :metadata_sync {:database_id 2
                                     :synced true}
                     :error         nil})]
      (is (= {:results
              [{:kind          :table
                :name          "Entry"
                :blob_name     "starrez_Entry_2026-05-28_12-07-33.csv"
                :records_count 2
                :success       true}]
              :snapshots         [77]
              :merge             nil
              :table_snapshot_id 77
              :activation        {:results       [{:table "\"starrez_data\".\"Entry\""
                                                   :rows 2
                                                   :cols 3}]
                                  :metadata_sync {:database_id 2
                                                  :synced true}
                                  :error         nil}}
             (without-completed-at
              (starrez.export/run-export {:activate-table-snapshot? true}))))
      (is (= [{"Entry" "starrez_Entry_2026-05-28_12-07-33.csv"}]
             @recorded))
      (is (= 77 @activated)))))

(deftest run-export-can-refresh-historical-reports-for-cron
  (let [requested-report-ids (atom [])
        merged              (atom nil)]
    (with-redefs [starrez.settings/starrez-export-tables
                  (constantly "")
                  starrez.settings/starrez-export-reports
                  (constantly "62751")
                  starrez.db/report-ids-for-export
                  (fn [configured-report-ids]
                    (is (= ["62751"] configured-report-ids))
                    ["59906" "62751"])
                  starrez.export/export-report
                  (fn [report-id]
                    (swap! requested-report-ids conj report-id)
                    {:kind      :report
                     :name      report-id
                     :blob_name (str "starrez_report_" report-id "_2026-05-28_12-07-38.csv")
                     :csv_body  "Booking ID,Room\n123,A\n"
                     :success   true})
                  starrez.db/record-export-week!
                  (constantly 42)
                  starrez.db/merge-report-exports!
                  (fn [report-ids results]
                    (reset! merged {:report-ids report-ids :results results})
                    {:destination_table "starrez_data.table_59906"})]
      (is (= {:results
              [{:kind      :report
                :name      "59906"
                :blob_name "starrez_report_59906_2026-05-28_12-07-38.csv"
                :success   true}
               {:kind      :report
                :name      "62751"
                :blob_name "starrez_report_62751_2026-05-28_12-07-38.csv"
                :success   true}]
              :snapshots [42 42]
              :merge     {:destination_table "starrez_data.table_59906"}}
             (without-completed-at
              (starrez.export/run-export {:include-historical-reports? true}))))
      (is (= ["59906" "62751"] @requested-report-ids))
      (is (= ["59906" "62751"] (:report-ids @merged)))
      (is (every? :csv_body (:results @merged))))))

(deftest successful-export-refreshes-performance-cache
  (let [refresh-count (atom 0)]
    (with-redefs [starrez.settings/starrez-export-tables (constantly "Entry")
                  starrez.settings/starrez-export-reports (constantly "")
                  starrez.export/export-table
                  (constantly {:kind :table :name "Entry" :blob_name "entry.csv" :success true})
                  starrez.db/record-export-week! (constantly 42)
                  starrez.db/refresh-weekly-net-bookings-fact-cache!
                  (fn []
                    (swap! refresh-count inc)
                    {:status "completed" :row_count 10})]
      (is (= {:status "completed" :row_count 10}
             (:performance_cache (starrez.export/run-export))))
      (is (= 1 @refresh-count)))))

(deftest failed-export-does-not-refresh-performance-cache
  (let [refresh-count (atom 0)]
    (with-redefs [starrez.settings/starrez-export-tables (constantly "Entry")
                  starrez.settings/starrez-export-reports (constantly "")
                  starrez.export/export-table
                  (constantly {:kind :table :name "Entry" :blob_name "entry.csv" :success false})
                  starrez.db/record-export-week! (constantly 42)
                  starrez.db/refresh-weekly-net-bookings-fact-cache!
                  (fn []
                    (swap! refresh-count inc)
                    {:status "completed"})]
      (is (nil? (:performance_cache (starrez.export/run-export))))
      (is (zero? @refresh-count)))))

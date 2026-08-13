(ns metabase.starrez.db-test
  (:require
   [clojure.string :as str]
   [clojure.test :refer :all]
   [metabase.starrez.db :as starrez.db]
   [metabase.starrez.settings :as starrez.settings]
   [metabase.sync.sync-metadata :as sync-metadata]
   [next.jdbc :as jdbc]))

(deftest load-snapshot-tables-loads-single-report-into-preview-only
  (let [loaded (atom [])]
    (with-redefs [starrez.db/create-and-load-table!
                  (fn [_conn table-name csv-rows]
                    (swap! loaded conj [table-name csv-rows])
                    {:table table-name})]
      (let [csv-rows [["student"] ["A"]]]
        (is (= [{:table "active_report"}]
               (#'starrez.db/load-snapshot-tables!
                nil
                [{:blob-name "starrez_report_59906_2026-05-28_12-07-38.csv"
                  :table-name "59906"
                  :csv-rows csv-rows}])))
        (is (= [["active_report" csv-rows]]
               @loaded))))))

(deftest load-snapshot-tables-keeps-non-report-tables-named
  (let [loaded (atom [])]
    (with-redefs [starrez.db/create-and-load-table!
                  (fn [_conn table-name csv-rows]
                    (swap! loaded conj [table-name csv-rows])
                    {:table table-name})]
      (let [csv-rows [["student"] ["A"]]]
        (is (= [{:table "Entry"}]
               (#'starrez.db/load-snapshot-tables!
                nil
                [{:blob-name "starrez_Entry_2026-05-28_12-07-38.csv"
                  :table-name "Entry"
                  :csv-rows csv-rows}])))
        (is (= [["Entry" csv-rows]]
               @loaded))))))

(deftest load-snapshot-tables-keeps-report-preview-separate-from-named-tables
  (let [loaded (atom [])]
    (with-redefs [starrez.db/create-and-load-table!
                  (fn [_conn table-name _csv-rows]
                    (swap! loaded conj table-name)
                    {:table table-name})]
      (is (= [{:table "Entry"}
              {:table "active_report"}]
             (#'starrez.db/load-snapshot-tables!
              nil
              [{:blob-name "starrez_Entry_2026-05-28_12-07-33.csv"
                :table-name "Entry"
                :csv-rows [["entry_id"] ["1"]]}
               {:blob-name "starrez_report_59906_2026-05-28_12-07-38.csv"
                :table-name "59906"
                :csv-rows [["booking_id"] ["123"]]}])))
      (is (= ["Entry" "active_report"] @loaded)))))

(deftest load-snapshot-tables-refuses-legacy-multi-report-snapshots
  (is (thrown-with-msg?
       clojure.lang.ExceptionInfo
       #"multiple reports"
       (#'starrez.db/load-snapshot-tables!
        nil
        [{:blob-name "starrez_report_59906_2026-05-28_12-07-38.csv"
          :table-name "59906"
          :csv-rows [["booking_id"] ["123"]]}
         {:blob-name "starrez_report_62751_2026-05-28_12-08-38.csv"
          :table-name "62751"
          :csv-rows [["booking_id"] ["456"]]}]))))

(deftest report-ids-for-export-keeps-historical-reports-in-first-seen-order
  (with-redefs [starrez.db/list-weeks
                (constantly
                 [{:blob_files {(keyword "62751") "starrez_report_62751_2026-05-28_12-08-38.csv"}}
                  {:blob_files {(keyword "59906") "starrez_report_59906_2026-05-28_12-07-38.csv"}}])
                starrez.settings/starrez-auto-refresh-disabled-reports
                (constantly [])]
    (is (= ["59906" "62751" "70000"]
           (starrez.db/report-ids-for-export ["62751" "70000"])))))

(deftest report-refresh-selection-selects-reports-unless-disabled
  (with-redefs [starrez.db/list-weeks
                (constantly
                 [{:blob_files {(keyword "62751") "starrez_report_62751_2026-05-28_12-08-38.csv"}}
                  {:blob_files {(keyword "59906") "starrez_report_59906_2026-05-28_12-07-38.csv"}}])
                starrez.settings/starrez-auto-refresh-disabled-reports
                (constantly ["62751"])]
    (is (= {:reports             [{:id "59906"
                                   :selected true
                                   :configured false
                                   :previously_exported true}
                                  {:id "62751"
                                   :selected false
                                   :configured true
                                   :previously_exported true}
                                  {:id "70000"
                                   :selected true
                                   :configured true
                                   :previously_exported false}]
            :selected_report_ids ["59906" "70000"]
            :disabled_report_ids ["62751"]}
           (starrez.db/report-refresh-selection ["62751" "70000"]))))
  (with-redefs [starrez.db/list-weeks
                (constantly [])
                starrez.settings/starrez-auto-refresh-disabled-reports
                (constantly [])]
    (is (= ["70000"]
           (starrez.db/report-ids-for-export ["70000"])))))

(deftest prepare-report-csv-validates-and-normalizes-booking-id
  (is (= {:columns ["booking_id" "room"]
          :rows    [["123" "A"]]}
         (#'starrez.db/prepare-report-csv
          [["Booking ID" "Room"]
           [" 123 " "A"]])))
  (is (thrown-with-msg?
       clojure.lang.ExceptionInfo
       #"blank booking_id"
       (#'starrez.db/prepare-report-csv
        [["Booking ID"] [""]])))
  (is (thrown-with-msg?
       clojure.lang.ExceptionInfo
       #"duplicate booking_id"
       (#'starrez.db/prepare-report-csv
        [["Booking ID"] ["123"] ["123"]])))
  (is (thrown-with-msg?
       clojure.lang.ExceptionInfo
       #"missing required booking_id"
       (#'starrez.db/prepare-report-csv
        [["Entry ID"] ["123"]]))))

(deftest report-load-strategy-falls-back-to-replace-when-booking-id-is-not-mergeable
  (is (= {:mode :merge}
         (#'starrez.db/report-load-strategy
          (#'starrez.db/parse-report-csv
           [["Booking ID" "Room"]
            ["123" "A"]]))))
  (is (= {:mode :replace
          :issue "CSV contains duplicate booking_id values"}
         (#'starrez.db/report-load-strategy
          (#'starrez.db/parse-report-csv
           [["Booking ID" "Room"]
            ["123" "A"]
            ["123" "B"]]))))
  (is (= {:mode :replace
          :issue "CSV is missing required booking_id column"}
         (#'starrez.db/report-load-strategy
          (#'starrez.db/parse-report-csv
           [["Entry ID" "Room"]
            ["111" "A"]])))))

(deftest merge-report-exports-routes-each-report-to-its-own-table
  (let [merged (atom [])]
    (with-redefs [starrez.db/merge-report-csv!
                  (fn [destination-table report-id _csv-body]
                    (swap! merged conj [destination-table report-id])
                    {:report_id report-id})
                  starrez.db/sync-metabase-schema!
                  (constantly {:synced true})]
      (is (= {:destination_tables ["starrez_data.table_59906" "starrez_data.table_62751"]
              :reports            [{:report_id "59906"}
                                   {:report_id "62751"}]
              :metadata_sync      {:synced true}}
             (starrez.db/merge-report-exports!
              ["59906" "62751"]
              [{:name "62751" :success true :csv_body "newer"}
               {:name "59906" :success true :csv_body "older"}])))
      (is (= [["table_59906" "59906"]
              ["table_62751" "62751"]]
             @merged)))))

(deftest merge-report-exports-keeps-going-after-a-failed-report
  (let [merged (atom [])]
    (with-redefs [starrez.db/merge-report-csv!
                  (fn [_destination-table report-id _csv-body]
                    (swap! merged conj report-id)
                    {:report_id report-id})
                  starrez.db/sync-metabase-schema!
                  (constantly {:synced true})]
      (is (= {:destination_tables ["starrez_data.table_59906" "starrez_data.table_62751"]
              :reports            [{:report_id         "59906"
                                    :destination_table "starrez_data.table_59906"
                                    :error             "StarRez unavailable"}
                                   {:report_id "62751"}]
              :metadata_sync      {:synced true}}
             (starrez.db/merge-report-exports!
              ["59906" "62751"]
              [{:name "59906" :success false :error "StarRez unavailable"}
               {:name "62751" :success true :csv_body "newer"}])))
      (is (= ["62751"] @merged)))))

(deftest merge-staging-table-updates-matches-and-inserts-only-new-bookings
  (let [queries (atom [])]
    (with-redefs [starrez.db/query-count
                  (fn [_conn [sql]]
                    (swap! queries conj sql)
                    (count @queries))]
      (is (= {:updated 1
              :inserted 2}
             (#'starrez.db/merge-staging-table!
              nil
              "table_59906"
              "\"staging\""
              ["booking_id" "room"])))
      (is (re-find #"UPDATE \"starrez_data\"\.\"table_59906\" destination" (first @queries)))
      (is (re-find #"destination\.\"booking_id\" = staging\.\"booking_id\"" (first @queries)))
      (is (re-find #"WHERE NOT EXISTS" (second @queries)))
      (is (re-find #"destination\.\"booking_id\" = staging\.\"booking_id\"" (second @queries))))))

(deftest create-report-table-adds-technical-primary-key
  (let [queries (atom [])]
    (with-redefs [jdbc/execute!
                  (fn [_conn [sql]]
                    (swap! queries conj sql))]
      (#'starrez.db/create-table! nil "table_59906" ["booking_id" "room"])
      (is (= ["CREATE TABLE \"starrez_data\".\"table_59906\" (\"_metabase_row_id\" BIGSERIAL PRIMARY KEY, \"booking_id\" TEXT, \"room\" TEXT)"]
             @queries)))))

(deftest create-snapshot-table-adds-technical-primary-key
  (let [queries (atom [])
        copies  (atom [])]
    (with-redefs [jdbc/execute!
                  (fn [_conn [sql]]
                    (swap! queries conj sql))
                  starrez.db/copy-rows!
                  (fn [_conn table-name columns rows]
                    (swap! copies conj [table-name columns rows]))]
      (is (= {:table "\"starrez_data\".\"entry\""
              :rows  1
              :cols  2}
             (#'starrez.db/create-and-load-table!
              nil
              "Entry"
              [["_metabase_row_id" "Room"]
               ["source-id" "A"]])))
      (is (= ["DROP TABLE IF EXISTS \"starrez_data\".\"entry\""
              (str "CREATE TABLE \"starrez_data\".\"entry\" "
                   "(\"_metabase_row_id\" BIGSERIAL PRIMARY KEY, "
                   "\"metabase_row_id\" TEXT, \"room\" TEXT)")]
             @queries))
      (is (= [["\"starrez_data\".\"entry\"" ["metabase_row_id" "room"] (list ["source-id" "A"])]]
             @copies)))))

(deftest ensure-technical-primary-key-adds-row-id-to-existing-report-table
  (let [queries (atom [])]
    (with-redefs [jdbc/execute-one!
                  (fn [_conn [sql & _params] & _opts]
                    (when (str/includes? sql "information_schema.table_constraints")
                      {:exists false}))
                  jdbc/execute!
                  (fn [_conn [sql & _params] & _opts]
                    (if (str/includes? sql "information_schema.columns")
                      []
                      (swap! queries conj sql)))]
      (is (= "_metabase_row_id"
             (#'starrez.db/ensure-technical-primary-key! nil "table_59906")))
      (is (= ["ALTER TABLE \"starrez_data\".\"table_59906\" ADD COLUMN \"_metabase_row_id\" BIGINT"
              "CREATE SEQUENCE IF NOT EXISTS \"starrez_data\".\"table_59906_metabase_row_id_seq\""
              "UPDATE \"starrez_data\".\"table_59906\" SET \"_metabase_row_id\" = nextval('starrez_data.table_59906_metabase_row_id_seq'::regclass) WHERE \"_metabase_row_id\" IS NULL"
              "SELECT setval('starrez_data.table_59906_metabase_row_id_seq'::regclass, COALESCE((SELECT MAX(\"_metabase_row_id\") FROM \"starrez_data\".\"table_59906\"), 0) + 1, false)"
              "ALTER TABLE \"starrez_data\".\"table_59906\" ALTER COLUMN \"_metabase_row_id\" SET DEFAULT nextval('starrez_data.table_59906_metabase_row_id_seq'::regclass)"
              "ALTER TABLE \"starrez_data\".\"table_59906\" ALTER COLUMN \"_metabase_row_id\" SET NOT NULL"
              "ALTER TABLE \"starrez_data\".\"table_59906\" ADD PRIMARY KEY (\"_metabase_row_id\")"
              "ALTER SEQUENCE \"starrez_data\".\"table_59906_metabase_row_id_seq\" OWNED BY \"starrez_data\".\"table_59906\".\"_metabase_row_id\""]
             @queries)))))

(deftest ensure-data-table-primary-keys-repairs-every-existing-data-table
  (let [repaired (atom [])]
    (with-redefs [starrez.db/get-connection
                  (constantly nil)
                  starrez.db/data-table-names
                  (constantly ["active_report" "entry"])
                  starrez.db/ensure-technical-primary-key!
                  (fn [_conn table-name]
                    (swap! repaired conj table-name)
                    "_metabase_row_id")]
      (#'starrez.db/ensure-data-table-primary-keys!)
      (is (= ["active_report" "entry"] @repaired)))))

(deftest truncate-report-table-keeps-dependent-views-intact
  (let [queries (atom [])]
    (with-redefs [jdbc/execute!
                  (fn [_conn [sql]]
                    (swap! queries conj sql))]
      (#'starrez.db/truncate-table! nil "table_65521")
      (is (= ["TRUNCATE TABLE \"starrez_data\".\"table_65521\" RESTART IDENTITY"]
             @queries)))))

(deftest replace-existing-report-table-does-not-drop-dependent-model-source
  (let [calls (atom [])]
    (with-redefs [starrez.db/add-missing-columns!
                  (fn [_conn table-name columns]
                    (swap! calls conj [:add-missing table-name columns])
                    ["new_col"])
                  starrez.db/ensure-technical-primary-key!
                  (fn [_conn table-name]
                    (swap! calls conj [:ensure-primary-key table-name]))
                  starrez.db/drop-booking-id-index!
                  (fn [_conn table-name]
                    (swap! calls conj [:drop-booking-index table-name]))
                  starrez.db/truncate-table!
                  (fn [_conn table-name]
                    (swap! calls conj [:truncate table-name]))
                  starrez.db/copy-rows!
                  (fn [_conn table-name columns rows]
                    (swap! calls conj [:copy table-name columns rows]))]
      (is (= {:added_columns ["new_col"]
              :created_table false
              :replaced_table true
              :inserted      1
              :updated       0}
             (#'starrez.db/replace-report-table!
              nil
              "table_65521"
              ["booking_id" "room" "new_col"]
              [["123" "A" "yes"]]
              true)))
      (is (= [[:add-missing "table_65521" ["booking_id" "room" "new_col"]]
              [:ensure-primary-key "table_65521"]
              [:drop-booking-index "table_65521"]
              [:truncate "table_65521"]
              [:copy "\"starrez_data\".\"table_65521\"" ["booking_id" "room" "new_col"] [["123" "A" "yes"]]]]
             @calls)))))

(deftest merge-existing-report-table-ensures-technical-primary-key
  (let [calls (atom [])]
    (with-redefs [starrez.db/add-missing-columns!
                  (fn [_conn table-name columns]
                    (swap! calls conj [:add-missing table-name columns])
                    [])
                  starrez.db/ensure-technical-primary-key!
                  (fn [_conn table-name]
                    (swap! calls conj [:ensure-primary-key table-name]))
                  starrez.db/normalize-destination-booking-ids!
                  (fn [_conn table-name]
                    (swap! calls conj [:normalize table-name]))
                  starrez.db/assert-valid-destination-booking-ids!
                  (fn [_conn table-name]
                    (swap! calls conj [:assert-valid table-name]))
                  starrez.db/ensure-booking-id-index!
                  (fn [_conn table-name]
                    (swap! calls conj [:ensure-booking-index table-name]))
                  starrez.db/create-staging-table!
                  (fn [_conn columns]
                    (swap! calls conj [:create-staging columns])
                    "\"staging\"")
                  starrez.db/copy-rows!
                  (fn [_conn table-name columns rows]
                    (swap! calls conj [:copy table-name columns rows]))
                  starrez.db/merge-staging-table!
                  (fn [_conn destination-table staging-table columns]
                    (swap! calls conj [:merge destination-table staging-table columns])
                    {:inserted 0
                     :updated  1})]
      (is (= {:added_columns []
              :created_table false
              :inserted      0
              :updated       1}
             (#'starrez.db/merge-existing-report-table!
              nil
              "table_59906"
              ["booking_id" "room"]
              [["123" "A"]])))
      (is (= [[:add-missing "table_59906" ["booking_id" "room"]]
              [:ensure-primary-key "table_59906"]
              [:normalize "table_59906"]
              [:assert-valid "table_59906"]
              [:ensure-booking-index "table_59906"]
              [:create-staging ["booking_id" "room"]]
              [:copy "\"staging\"" ["booking_id" "room"] [["123" "A"]]]
              [:merge "table_59906" "\"staging\"" ["booking_id" "room"]]]
             @calls)))))

(deftest ensure-booking-id-index-creates-a-unique-index
  (let [queries (atom [])]
    (with-redefs [jdbc/execute!
                  (fn [_conn [sql]]
                    (swap! queries conj sql))]
      (#'starrez.db/ensure-booking-id-index! nil "table_59906")
      (is (= ["CREATE UNIQUE INDEX IF NOT EXISTS \"table_59906_booking_id_uniq\" ON \"starrez_data\".\"table_59906\" (\"booking_id\")"]
             @queries)))))

(deftest drop-booking-id-index-removes-the-merge-only-index
  (let [queries (atom [])]
    (with-redefs [jdbc/execute!
                  (fn [_conn [sql]]
                    (swap! queries conj sql))]
      (#'starrez.db/drop-booking-id-index! nil "table_65526")
      (is (= ["DROP INDEX IF EXISTS \"starrez_data\".\"table_65526_booking_id_uniq\""]
             @queries)))))

(deftest sync-metabase-schema-syncs-matched-database
  (let [synced (atom [])]
    (with-redefs [starrez.db/starrez-metabase-database
                  (constantly {:id 2 :name "StarRez"})
                  sync-metadata/sync-db-metadata!
                  (fn [database]
                    (swap! synced conj database)
                    {:ok true})]
      (is (= {:database_id 2
              :synced true}
             (#'starrez.db/sync-metabase-schema!)))
      (is (= [{:id 2 :name "StarRez"}] @synced)))))

(deftest refresh-snapshots-refreshes-list-and-schema
  (let [repaired? (atom false)]
    (with-redefs [starrez.db/configured?
                  (constantly true)
                  starrez.db/ensure-data-table-primary-keys!
                  (fn []
                    (reset! repaired? true))
                  starrez.db/list-weeks-result
                  (constantly {:weeks [{:id 7}]})
                  starrez.db/sync-metabase-schema!
                  (constantly {:database_id 2
                               :synced true})]
      (is (= {:weeks [{:id 7}]
              :metadata_sync {:database_id 2
                              :synced true}}
             (starrez.db/refresh-snapshots!)))
      (is (true? @repaired?)))))

(deftest refresh-snapshots-keeps-list-when-schema-sync-fails
  (with-redefs [starrez.db/list-weeks-result
                (constantly {:weeks [{:id 7}]})
                starrez.db/configured?
                (constantly false)
                starrez.db/sync-metabase-schema!
                (constantly {:synced false
                             :error "No matching Metabase database found"})]
    (is (= {:weeks [{:id 7}]
            :metadata_sync {:synced false
                            :error "No matching Metabase database found"}}
           (starrez.db/refresh-snapshots!)))))

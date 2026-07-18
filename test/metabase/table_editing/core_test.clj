(ns metabase.table-editing.core-test
  (:require
   [clojure.test :refer :all]
   [metabase.actions.core :as actions]
   [metabase.table-editing.core :as table-editing]))

(deftest editable-table-ids-test
  (testing "setting values are sanitized and deduplicated"
    (is (= [1 2 3]
           (table-editing/editable-table-ids
            {:settings {:database-editable-table-ids [1 "2" " 3 " nil "oops" 2]}})))
    (is (= [4]
           (table-editing/editable-table-ids
            {:settings {"database-editable-table-ids" ["4" -1 ""]}})))))

(deftest table-editable?-test
  (testing "tables must be explicitly allowlisted"
    (is (true? (table-editing/table-editable?
                {:settings {:database-editable-table-ids [10 20]}}
                20)))
    (is (false? (table-editing/table-editable?
                 {:settings {:database-editable-table-ids [10 20]}}
                 30)))))

(deftest describe-form-test
  (let [fields [{:id                         1
                 :name                       "id"
                 :display_name               "ID"
                 :semantic_type              :type/PK
                 :base_type                  :type/Integer
                 :database_is_auto_increment true
                 :database_required          true
                 :database_is_nullable       false}
                {:id                   2
                 :name                 "name"
                 :display_name         "Name"
                 :base_type            :type/Text
                 :database_required    true
                 :database_is_nullable false}
                {:id                   3
                 :name                 "notes"
                 :display_name         "Notes"
                 :semantic_type        :type/Description
                 :base_type            :type/Text
                 :database_required    false
                 :database_is_nullable true}
                {:id                   4
                 :name                 "active"
                 :display_name         "Active"
                 :base_type            :type/Boolean
                 :database_required    false
                 :database_is_nullable false}]]
    (with-redefs [table-editing/editable-table-context! (constantly {:table {:display_name "Weekly Lookup"}})
                  metabase.table-editing.core/table-fields (constantly fields)]
      (testing "create form excludes auto-increment primary keys"
        (let [description (table-editing/describe-form 42 :create nil)]
          (is (= "Weekly Lookup: Create" (:title description)))
          (is (= ["name" "notes" "active"]
                 (map :id (:parameters description))))
          (is (= [:text :textarea :boolean]
                 (map :input_type (:parameters description))))))
      (testing "update form includes readonly primary keys and row values"
        (let [description (table-editing/describe-form 42
                                                       :update
                                                       {"id"     7
                                                        "name"   "Alpha"
                                                        "active" true})
              [id-field name-field notes-field active-field] (:parameters description)]
          (is (= ["id" "name" "notes" "active"]
                 (map :id (:parameters description))))
          (is (true? (:readonly id-field)))
          (is (= 7 (:value id-field)))
          (is (= "Alpha" (:value name-field)))
          (is (nil? (:value notes-field)))
          (is (= true (:value active-field))))))))

(deftest execute-row-action!-test
  (let [captured-call (atom nil)]
    (with-redefs [table-editing/editable-table-context! (constantly {:database {:id 1}
                                                                     :table    {:id 42}})
                  table-editing/has-primary-key? (constantly true)
                  actions/perform-action-v2! (fn [& args]
                                               (reset! captured-call args)
                                               {:outputs [{:row {"id" 1}}]})]
      (is (= {:success true
              :outputs [{:row {"id" 1}}]}
             (table-editing/execute-row-action! 42 :update {"id" 1
                                                            "name" "Updated"})))
      (is (= [:table.row/update
              {:table-id 42}
              [{:table-id 42
                :row      {"id" 1
                           "name" "Updated"}}]
              :policy
              :data-editing]
             @captured-call)))))

(deftest add-column-sql-test
  (testing "Postgres identifiers are quoted and nullable columns omit NOT NULL"
    (is (= "ALTER TABLE \"public\".\"asset lookup\" ADD COLUMN \"daily notes\" TEXT"
           (#'table-editing/add-column-sql
            :postgres
            {:schema "public" :name "asset lookup"}
            {:name "daily notes" :type :text :nullable true}))))
  (testing "MySQL identifiers are quoted and non-nullable columns include NOT NULL"
    (is (= "ALTER TABLE `asset lookup` ADD COLUMN `arrival_count` BIGINT NOT NULL"
           (#'table-editing/add-column-sql
            :mysql
            {:name "asset lookup"}
            {:name "arrival_count" :type :integer :nullable false})))))

(deftest add-column!-test
  (testing "adds a column and syncs table metadata"
    (let [executed-sql (atom nil)
          synced-table (atom nil)]
      (with-redefs [table-editing/editable-table-context! (constantly {:database {:id 1 :engine :postgres}
                                                                       :table    {:id 42
                                                                                  :schema "public"
                                                                                  :name "asset lookup"}})
                    metabase.table-editing.core/table-fields (constantly [{:name "id"}])
                    metabase.table-editing.core/execute-ddl! (fn [_database sql]
                                                               (reset! executed-sql sql))
                    metabase.table-editing.core/sync-table-metadata-result (fn [table]
                                                                             (reset! synced-table table)
                                                                             {:synced true})]
        (is (= {:success       true
                :column        {:name "notes"
                                :type "text"
                                :nullable true}
                :metadata_sync {:synced true}}
               (table-editing/add-column! 42 {:name " notes "
                                              :type :text})))
        (is (= "ALTER TABLE \"public\".\"asset lookup\" ADD COLUMN \"notes\" TEXT"
               @executed-sql))
        (is (= {:id 42 :schema "public" :name "asset lookup"} @synced-table)))))
  (testing "rejects duplicate columns"
    (with-redefs [table-editing/editable-table-context! (constantly {:database {:id 1 :engine :postgres}
                                                                     :table    {:id 42 :name "asset_lookup"}})
                  metabase.table-editing.core/table-fields (constantly [{:name "Notes"}])]
      (is (thrown-with-msg?
           clojure.lang.ExceptionInfo
           #"A column with this name already exists"
           (table-editing/add-column! 42 {:name "notes"
                                          :type :text}))))))

(ns metabase.table-editing.core
  "Core helpers for OSS table editing."
  (:require
   [clojure.string :as str]
   [metabase.actions.core :as actions]
   [metabase.api.common :as api]
   [metabase.driver :as driver]
   [metabase.driver.util :as driver.u]
   [metabase.settings.core :as setting]
   [metabase.sync.sync-metadata :as sync-metadata]
   [metabase.table-editing.settings :as table-editing.settings]
   [metabase.util :as u]
   [metabase.util.i18n :refer [tru]]
   [metabase.util.log :as log]
   [metabase.util.malli :as mu]
   [toucan2.core :as t2]))

(set! *warn-on-reflection* true)

(defn- parse-table-id [value]
  (cond
    (pos-int? value)
    value

    (string? value)
    (let [trimmed (str/trim value)]
      (when (re-matches #"\d+" trimmed)
        (let [table-id (parse-long trimmed)]
          (when (pos-int? table-id)
            table-id))))

    :else
    nil))

(mu/defn editable-table-ids :- [:sequential pos-int?]
  "Return sanitized allowlisted table IDs from a Database settings map."
  [{:keys [settings]} :- :map]
  (->> (or (get settings :database-editable-table-ids)
           (get settings "database-editable-table-ids")
           [])
       (keep parse-table-id)
       distinct
       vec))

(mu/defn table-editable? :- :boolean
  "Return whether `table-id` is allowlisted for editing on `database`."
  [database :- :map
   table-id  :- pos-int?]
  (contains? (set (editable-table-ids database)) table-id))

(defn- configured-editable-table-ids
  [database]
  (setting/with-database database
    (->> (table-editing.settings/database-editable-table-ids)
         (keep parse-table-id)
         distinct
         vec)))

(defn- check-table-allowlisted!
  [database table-id]
  (when-not (contains? (set (configured-editable-table-ids database)) table-id)
    (throw (ex-info (tru "This table is not enabled for editing.")
                    {:status-code 403
                     :table-id    table-id
                     :database-id (:id database)}))))

(defn- check-table-writable!
  [table]
  (when-not (:is_writable table)
    (throw (ex-info (tru "This table is read-only.")
                    {:status-code 400
                     :table-id    (:id table)}))))

(mu/defn editable-table-context! :- [:map
                                     [:database :map]
                                     [:table :map]]
  "Fetch the Database and Table for `table-id` and ensure they can be edited."
  [table-id :- pos-int?]
  (let [table    (api/check-404 (t2/select-one :model/Table :id table-id :active true))
        database (api/check-404 (t2/select-one :model/Database :id (:db_id table)))]
    (actions/check-data-editing-enabled-for-database! database)
    (check-table-allowlisted! database table-id)
    (check-table-writable! table)
    {:database database
     :table    table}))

(defn- table-fields
  [table-id]
  (t2/select :model/Field
             :table_id table-id
             :active true
             {:order-by [[:position :asc]]}))

(defn- pk-fields [fields]
  (filter #(= :type/PK (:semantic_type %)) fields))

(def ^:private editable-column-types
  #{:text :integer :decimal :boolean :date :datetime})

(defn- column-type-sql
  [driver column-type]
  (case column-type
    :text     "TEXT"
    :integer  "BIGINT"
    :decimal  (if (= driver :mysql) "DECIMAL(38, 10)" "NUMERIC")
    :boolean  "BOOLEAN"
    :date     "DATE"
    :datetime (if (= driver :mysql) "DATETIME" "TIMESTAMP")))

(defn- normalize-column-name
  [column-name]
  (str/trim (str column-name)))

(defn- validate-column-name!
  [column-name]
  (cond
    (str/blank? column-name)
    (throw (ex-info (tru "Column name is required.")
                    {:status-code 400}))

    (> (count column-name) 128)
    (throw (ex-info (tru "Column name must be 128 characters or fewer.")
                    {:status-code 400}))

    (str/includes? column-name ".")
    (throw (ex-info (tru "Column name cannot contain a period.")
                    {:status-code 400}))

    (re-find #"\p{Cntrl}" column-name)
    (throw (ex-info (tru "Column name cannot contain control characters.")
                    {:status-code 400})))
  column-name)

(defn- validate-existing-column-name!
  [column-name]
  (cond
    (str/blank? column-name)
    (throw (ex-info (tru "Column name is required.")
                    {:status-code 400}))

    (> (count column-name) 128)
    (throw (ex-info (tru "Column name must be 128 characters or fewer.")
                    {:status-code 400}))

    (re-find #"\p{Cntrl}" column-name)
    (throw (ex-info (tru "Column name cannot contain control characters.")
                    {:status-code 400})))
  column-name)

(defn- validate-column-type!
  [column-type]
  (when-not (contains? editable-column-types column-type)
    (throw (ex-info (tru "Unsupported column type.")
                    {:status-code 400
                     :type        column-type})))
  column-type)

(defn- check-column-does-not-exist!
  [fields column-name]
  (let [existing-field-names (into #{}
                                   (map (comp u/lower-case-en :name))
                                   fields)]
    (when (contains? existing-field-names (u/lower-case-en column-name))
      (throw (ex-info (tru "A column with this name already exists.")
                      {:status-code 400
                       :column      column-name})))))

(defn- column-field
  [fields column-name]
  (some #(when (= (:name %) column-name) %) fields))

(defn- existing-column-field!
  [fields column-name]
  (or (column-field fields column-name)
      (throw (ex-info (tru "Column not found.")
                      {:status-code 404
                       :column      column-name}))))

(defn- check-column-droppable!
  [field]
  (when (= :type/PK (:semantic_type field))
    (throw (ex-info (tru "Primary key columns cannot be deleted.")
                    {:status-code 400
                     :column      (:name field)}))))

(defn- supported-ddl-driver?
  [driver]
  (contains? #{:postgres :mysql} driver))

(defn- quote-ident
  [driver identifier]
  (case driver
    :mysql    (str "`" (str/replace identifier "`" "``") "`")
    :postgres (str "\"" (str/replace identifier "\"" "\"\"") "\"")))

(defn- qualified-table-name
  [driver table]
  (if (seq (:schema table))
    (str (quote-ident driver (:schema table))
         "."
         (quote-ident driver (:name table)))
    (quote-ident driver (:name table))))

(defn- add-column-sql
  [driver table {:keys [name type nullable]}]
  (format "ALTER TABLE %s ADD COLUMN %s %s%s"
          (qualified-table-name driver table)
          (quote-ident driver name)
          (column-type-sql driver type)
          (if nullable "" " NOT NULL")))

(defn- drop-column-sql
  [driver table column-name]
  (format "ALTER TABLE %s DROP COLUMN %s"
          (qualified-table-name driver table)
          (quote-ident driver column-name)))

(defn- execute-ddl!
  [database sql]
  (let [database-driver (driver.u/database->driver database)]
    (when-not (supported-ddl-driver? database-driver)
      (throw (ex-info (tru "Editing columns is only supported for PostgreSQL and MySQL tables.")
                      {:status-code 400
                       :driver      database-driver})))
    (driver/execute-raw-queries! database-driver (:id database) [[sql nil]])))

(defn- sync-table-metadata-result
  [table]
  (try
    (sync-metadata/sync-table-metadata! table)
    {:synced true}
    (catch Throwable e
      (log/warn e "Unable to sync table metadata after editing columns")
      {:synced false
       :error  (or (ex-message e) (str e))})))

(mu/defn has-primary-key? :- :boolean
  "Return whether `table-id` has at least one active primary-key field."
  [table-id :- pos-int?]
  (boolean (seq (pk-fields (table-fields table-id)))))

(mu/defn add-column! :- [:map
                         [:success [:= true]]
                         [:column [:map
                                   [:name :string]
                                   [:type :string]
                                   [:nullable :boolean]]]
                         [:metadata_sync [:map
                                          [:synced :boolean]
                                          [:error {:optional true} :string]]]]
  "Add a column to an editable table and sync Metabase metadata for that table."
  [table-id :- pos-int?
   column   :- [:map
                [:name :string]
                [:type :keyword]
                [:nullable {:optional true} [:maybe :boolean]]]]
  (let [{:keys [database table]} (editable-table-context! table-id)
        database-driver          (driver.u/database->driver database)
        column-name              (validate-column-name! (normalize-column-name (:name column)))
        column-type              (validate-column-type! (:type column))
        nullable?                (not (false? (:nullable column)))
        sanitized-column         {:name     column-name
                                  :type     column-type
                                  :nullable nullable?}]
    (when-not (supported-ddl-driver? database-driver)
      (throw (ex-info (tru "Adding columns is only supported for PostgreSQL and MySQL tables.")
                      {:status-code 400
                       :driver      database-driver})))
    (check-column-does-not-exist! (table-fields table-id) column-name)
    (execute-ddl! database (add-column-sql database-driver table sanitized-column))
    {:success       true
     :column        {:name     column-name
                     :type     (name column-type)
                     :nullable nullable?}
     :metadata_sync (sync-table-metadata-result table)}))

(mu/defn delete-column! :- [:map
                            [:success [:= true]]
                            [:column [:map
                                      [:name :string]]]
                            [:metadata_sync [:map
                                             [:synced :boolean]
                                             [:error {:optional true} :string]]]]
  "Delete a non-primary-key column from an editable table and sync Metabase metadata for that table."
  [table-id :- pos-int?
   column   :- [:map
                [:name :string]]]
  (let [{:keys [database table]} (editable-table-context! table-id)
        database-driver          (driver.u/database->driver database)
        column-name              (validate-existing-column-name! (normalize-column-name (:name column)))
        field                    (existing-column-field! (table-fields table-id) column-name)]
    (when-not (supported-ddl-driver? database-driver)
      (throw (ex-info (tru "Editing columns is only supported for PostgreSQL and MySQL tables.")
                      {:status-code 400
                       :driver      database-driver})))
    (check-column-droppable! field)
    (execute-ddl! database (drop-column-sql database-driver table column-name))
    {:success       true
     :column        {:name column-name}
     :metadata_sync (sync-table-metadata-result table)}))

(defn- input-type
  [action field]
  (let [create? (= action :create)
        base-type (:base_type field)
        semantic-type (:semantic_type field)]
    (cond
      (isa? semantic-type :type/Description) :textarea
      (isa? semantic-type :type/Boolean) :boolean
      (isa? semantic-type :type/Category) :dropdown
      (isa? semantic-type :type/FK) :dropdown
      (isa? semantic-type :type/PK) (if create?
                                      (case base-type
                                        (:type/Integer :type/BigInteger) :integer
                                        (:type/Float :type/Decimal) :float
                                        :type/Boolean :boolean
                                        (:type/Date) :date
                                        (:type/DateTime :type/DateTimeWithLocalTZ :type/DateTimeWithTZ) :datetime
                                        :text)
                                      :text)
      (isa? base-type :type/Boolean) :boolean
      (isa? base-type :type/Integer) :integer
      (isa? base-type :type/BigInteger) :integer
      (isa? base-type :type/Float) :float
      (isa? base-type :type/Decimal) :float
      (isa? base-type :type/Date) :date
      (isa? base-type :type/DateTime) :datetime
      (isa? base-type :type/DateTimeWithLocalTZ) :datetime
      (isa? base-type :type/DateTimeWithTZ) :datetime
      :else :text)))

(defn- required-field?
  [field]
  (boolean (:database_required field false)))

(defn- readonly-field?
  [action field]
  (let [pk?       (= :type/PK (:semantic_type field))
        auto-inc? (boolean (:database_is_auto_increment field))]
    (or auto-inc?
        (and pk? (not= action :create)))))

(defn- include-field?
  [action field]
  (let [pk?       (= :type/PK (:semantic_type field))
        auto-inc? (boolean (:database_is_auto_increment field))]
    (case action
      :create (not auto-inc?)
      :update true
      :delete pk?
      false)))

(mu/defn describe-form :- [:map
                           [:title :string]
                           [:parameters [:sequential
                                         [:map
                                          [:id :string]
                                          [:display_name :string]
                                          [:field_id pos-int?]
                                          [:input_type [:enum
                                                        :text
                                                        :textarea
                                                        :date
                                                        :datetime
                                                        :dropdown
                                                        :boolean
                                                        :integer
                                                        :float]]
                                          [:optional :boolean]
                                          [:nullable {:optional true} :boolean]
                                          [:readonly :boolean]
                                          [:database_default {:optional true} :any]
                                          [:semantic_type {:optional true} :keyword]
                                          [:value {:optional true} :any]]]]]
  "Describe the editable fields for `action` on `table-id`."
  [table-id :- pos-int?
   action   :- [:enum :create :update :delete]
   row-data :- [:maybe [:map-of :string :any]]]
  (let [{:keys [table]} (editable-table-context! table-id)
        fields          (table-fields table-id)
        _               (when (and (not= action :create)
                                   (empty? (pk-fields fields)))
                          (throw (ex-info (tru "This table does not have a primary key, so it cannot be edited here.")
                                          {:status-code 400
                                           :table-id    table-id})))]
    {:title      (format "%s: %s" (:display_name table) (str/capitalize (name action)))
     :parameters
     (mapv (fn [field]
             (cond-> {:id           (:name field)
                      :display_name (:display_name field)
                      :field_id     (:id field)
                      :input_type   (input-type action field)
                      :optional     (not (or (= action :delete)
                                             (= :type/PK (:semantic_type field))
                                             (required-field? field)))
                      :readonly     (readonly-field? action field)}
               (some? (:semantic_type field))
               (assoc :semantic_type (:semantic_type field))

               (contains? field :database_is_nullable)
               (assoc :nullable (boolean (:database_is_nullable field)))

               (contains? field :database_default)
               (assoc :database_default (:database_default field))

               (contains? row-data (:name field))
               (assoc :value (get row-data (:name field)))))
           (filter #(include-field? action %) fields))}))

(defn- action-keyword [action]
  (case action
    :create :table.row/create
    :update :table.row/update
    :delete :table.row/delete))

(mu/defn execute-row-action! :- [:map
                                 [:success [:= true]]
                                 [:outputs {:optional true} [:sequential :map]]]
  "Execute a single-row table editing action for `table-id`."
  [table-id :- pos-int?
   action   :- [:enum :create :update :delete]
   row      :- [:map-of :string :any]]
  (editable-table-context! table-id)
  (when (and (not= action :create)
             (not (has-primary-key? table-id)))
    (throw (ex-info (tru "This table does not have a primary key, so it cannot be edited here.")
                    {:status-code 400
                     :table-id    table-id})))
  {:success true
   :outputs (:outputs (actions/perform-action-v2!
                       (action-keyword action)
                       {:table-id table-id}
                       [{:table-id table-id
                         :row      row}]
                       :policy :data-editing))})

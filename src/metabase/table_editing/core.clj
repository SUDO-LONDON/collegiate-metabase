(ns metabase.table-editing.core
  "Core helpers for OSS table editing."
  (:require
   [clojure.string :as str]
   [metabase.actions.core :as actions]
   [metabase.api.common :as api]
   [metabase.settings.core :as setting]
   [metabase.table-editing.settings :as table-editing.settings]
   [metabase.util.i18n :refer [tru]]
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

(mu/defn has-primary-key? :- :boolean
  "Return whether `table-id` has at least one active primary-key field."
  [table-id :- pos-int?]
  (boolean (seq (pk-fields (table-fields table-id)))))

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

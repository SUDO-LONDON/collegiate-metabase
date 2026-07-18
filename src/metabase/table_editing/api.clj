(ns metabase.table-editing.api
  "/api/table-editing endpoints — admin-only table editing for allowlisted tables."
  (:require
   [metabase.api.common :as api]
   [metabase.api.macros :as api.macros]
   [metabase.permissions.core :as perms]
   [metabase.table-editing.core :as table-editing]
   [metabase.util.malli.registry :as mr]
   [metabase.util.malli.schema :as ms]))

(set! *warn-on-reflection* true)

(mr/def ::action
  [:enum "create" "update" "delete"])

(mr/def ::row
  [:map-of :string :any])

(mr/def ::column-type
  [:enum "text" "integer" "decimal" "boolean" "date" "datetime"])

(mr/def ::column
  [:map
   [:name ms/NonBlankString]
   [:type ::column-type]
   [:nullable {:optional true} [:maybe :boolean]]])

(mr/def ::delete-column
  [:map
   [:name ms/NonBlankString]])

(mr/def ::describe-form-response
  [:map
   [:title :string]
   [:parameters [:sequential
                 [:map
                  [:id :string]
                  [:display_name :string]
                  [:field_id ms/PositiveInt]
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
                  [:value {:optional true} :any]]]]])

(mr/def ::execute-response
  [:map
   [:success [:= true]]
   [:outputs {:optional true} [:sequential :map]]])

(mr/def ::metadata-sync-response
  [:map
   [:synced :boolean]
   [:error {:optional true} :string]])

(mr/def ::add-column-response
  [:map
   [:success [:= true]]
   [:column [:map
             [:name :string]
             [:type ::column-type]
             [:nullable :boolean]]]
   [:metadata_sync ::metadata-sync-response]])

(mr/def ::delete-column-response
  [:map
   [:success [:= true]]
   [:column [:map
             [:name :string]]]
   [:metadata_sync ::metadata-sync-response]])

(defn- parse-action [action]
  (keyword action))

(api.macros/defendpoint :post "/:table-id/describe-form" :- ::describe-form-response
  "Describe the editable fields for a single-table row action."
  [{:keys [table-id]} :- [:map
                          [:table-id ms/PositiveInt]]
   _query-params
   {:keys [action input]} :- [:map
                              [:action ::action]
                              [:input {:optional true} [:maybe ::row]]]]
  (perms/check-has-application-permission :setting)
  (api/check-superuser)
  (table-editing/describe-form table-id (parse-action action) input))

(api.macros/defendpoint :post "/:table-id/create" :- ::execute-response
  "Create a single row in an allowlisted table."
  [{:keys [table-id]} :- [:map
                          [:table-id ms/PositiveInt]]
   _query-params
   {:keys [row]} :- [:map
                     [:row ::row]]]
  (perms/check-has-application-permission :setting)
  (api/check-superuser)
  (table-editing/execute-row-action! table-id :create row))

(api.macros/defendpoint :post "/:table-id/update" :- ::execute-response
  "Update a single row in an allowlisted table."
  [{:keys [table-id]} :- [:map
                          [:table-id ms/PositiveInt]]
   _query-params
   {:keys [row]} :- [:map
                     [:row ::row]]]
  (perms/check-has-application-permission :setting)
  (api/check-superuser)
  (table-editing/execute-row-action! table-id :update row))

(api.macros/defendpoint :post "/:table-id/delete" :- ::execute-response
  "Delete a single row from an allowlisted table."
  [{:keys [table-id]} :- [:map
                          [:table-id ms/PositiveInt]]
   _query-params
   {:keys [row]} :- [:map
                     [:row ::row]]]
  (perms/check-has-application-permission :setting)
  (api/check-superuser)
  (table-editing/execute-row-action! table-id :delete row))

(api.macros/defendpoint :post "/:table-id/columns" :- ::add-column-response
  "Add a column to an allowlisted table."
  [{:keys [table-id]} :- [:map
                          [:table-id ms/PositiveInt]]
   _query-params
   {:keys [column]} :- [:map
                        [:column ::column]]]
  (perms/check-has-application-permission :setting)
  (api/check-superuser)
  (table-editing/add-column! table-id (update column :type keyword)))

(api.macros/defendpoint :post "/:table-id/columns/delete" :- ::delete-column-response
  "Delete a column from an allowlisted table."
  [{:keys [table-id]} :- [:map
                          [:table-id ms/PositiveInt]]
   _query-params
   {:keys [column]} :- [:map
                        [:column ::delete-column]]]
  (perms/check-has-application-permission :setting)
  (api/check-superuser)
  (table-editing/delete-column! table-id column))

(def ^:private keep-me ::keep-me)

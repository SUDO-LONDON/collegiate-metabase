(ns metabase.table-editing.settings
  (:require
   [metabase.settings.core :as setting :refer [defsetting]]
   [metabase.util.i18n :as i18n]))

(defsetting database-editable-table-ids
  (i18n/deferred-tru "List of allowlisted table IDs that can be edited from Browse Data for a specific Database.")
  :default          []
  :driver-feature   :actions/data-editing
  :type             :json
  :encryption       :no
  :visibility       :public
  :database-local   :only
  :export?          true)

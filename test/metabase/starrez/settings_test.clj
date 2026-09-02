(ns metabase.starrez.settings-test
  (:require
   [clojure.test :refer :all]
   [metabase.settings.models.setting :as setting]
   [metabase.starrez.settings :as starrez.settings]
   [metabase.test :as mt]))

(set! *warn-on-reflection* true)

(defn- assert-secret-is-obfuscated
  [setting-key getter secret]
  (is (= secret (getter)))
  (is (not= secret (setting/user-facing-value setting-key)))
  (is (not (re-find (re-pattern secret)
                    (setting/user-facing-value setting-key)))))

(deftest secret-settings-are-obfuscated-test
  (testing "StarRez REST token"
    (mt/with-temporary-setting-values [starrez-api-token "rest-token-secret"]
      (assert-secret-is-obfuscated "starrez-api-token"
                                   starrez.settings/starrez-api-token
                                   "rest-token-secret")))
  (testing "Blob SAS URL"
    (mt/with-temporary-setting-values [starrez-blob-sas-url "blob-sas-secret"]
      (assert-secret-is-obfuscated "starrez-blob-sas-url"
                                   starrez.settings/starrez-blob-sas-url
                                   "blob-sas-secret")))
  (testing "StarRez Postgres password"
    (mt/with-temporary-setting-values [starrez-pg-password "postgres-password-secret"]
      (assert-secret-is-obfuscated "starrez-pg-password"
                                   starrez.settings/starrez-pg-password
                                   "postgres-password-secret"))))

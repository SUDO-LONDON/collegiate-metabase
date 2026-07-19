(ns metabase.starrez.client-test
  (:require
   [clj-http.client :as http]
   [clojure.test :refer :all]
   [metabase.starrez.client :as starrez.client]
   [metabase.starrez.settings :as starrez.settings]))

(deftest fetch-report-csv-uses-extended-timeout-test
  (let [captured-request (atom nil)]
    (with-redefs [starrez.settings/starrez-api-url
                  (constantly "https://example.starrezhousing.com/StarRezRest")
                  starrez.settings/starrez-api-username
                  (constantly "api-user")
                  starrez.settings/starrez-api-token
                  (constantly "api-token")
                  http/get
                  (fn [url opts]
                    (reset! captured-request {:url url :opts opts})
                    {:status 200
                     :body   "booking_id,room\n123,A\n"})]
      (is (= {:ok true :body "booking_id,room\n123,A\n"}
             (starrez.client/fetch-report-csv "65521")))
      (is (= "https://example.starrezhousing.com/StarRezRest/services/getreport/65521.csv"
             (:url @captured-request)))
      (is (= 1800000 (get-in @captured-request [:opts :socket-timeout])))
      (is (= 60000 (get-in @captured-request [:opts :connection-timeout])))
      (is (= :string (get-in @captured-request [:opts :as]))))))

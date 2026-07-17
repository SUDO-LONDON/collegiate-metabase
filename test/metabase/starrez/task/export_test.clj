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

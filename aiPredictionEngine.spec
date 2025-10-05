<concept_spec>
concept PredictionEngine

purpose
    Generate forecasts of wait times and entry likelihood and outputs a thorough summary of information 
    based on AI predictions and user input.

principle
    Combines user reports about queue status and LLM natural-language interpretation
    to produce structured predictions and user-facing summaries. The LLM will:
      - Interpreting free-text user reports into structured fields (estPplInLine, estimatedWaitMins, movementRate, entryOutcome) which is used for running predictions
      - Generating concise human summaries of predictions

state
    a set of Predictions with
        queueID
        historicalData
        liveReports
        predictionResult (estWaitTime, entryProbability, confidenceInterval, aiSummary)
        lastRun

actions
        interpretReport(reportText: String, queueID: String): StructuredReport: Object
            requires queueID must exist
            effect sends natural-language report to LLM and returns {estPplInLine, 
            estimatedWaitMins, movementRate, entryOutcome, aiConfidence}.
            The system validates the result, stores it as a UserReport, and uses it in subsequent predictions

        runPrediction(queueID: String): predictionResult: Object, lastRun:DateTime
            requires queueID must exist
            effect generates updated prediction results using structured stats + 
            LLM refinement

        summarizeForecast(queueID: String, predictionResult: Object): aiSummary: String
            requires queueID, predictionResult must exist
            effect generates a human-readable forecast (e.g. “About a 1 hr wait, slow entry pace 
            with 65% chance of getting in”)

Notes about validators & safety
- LLM outputs are always parsed and validated. Numeric fields are coerced to integers and must be in reasonable bounds (0 <= wait <= 24*60, 0 <= entryProbability <= 100).
- The LLM may not add arbitrary new state fields or invent extraneous events (such outputs are filtered).
- The system retains the manual/pure-statistical pipeline so that functionality remains available without LLM involvement

</concept_spec>
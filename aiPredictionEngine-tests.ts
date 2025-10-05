/**
 * Test driver for aiPredictionEngine prototype
 *
 * This script:
 *  - loads config.json (API key)
 *  - creates PredictionEngine + queues
 *  - submits text reports
 *  - runs interpretReport (LLM) and runPrediction (heuristic + LLM summary)
 *  - prints results for inspection
 *
 * Usage: ts-node src/testDriver.ts  (or compile via tsc and run node)
 */

import { GeminiLLM } from './gemini-llm';
import { PredictionEngine } from './aiPredictionEngine';

function loadConfig() {
  try {
    const config = require('../config.json');
    return config;
  } catch (error) {
    console.error('❌ Error loading config.json. Please ensure it exists with your API key.');
    console.error('Error details:', (error as Error).message);
    process.exit(1);
  }
}

async function testScenario(engine: PredictionEngine, queueID: string, rawText: string, variant = 0) {
  console.log('\n----------------------------------------');
  console.log(`TEST SCENARIO for queue=${queueID}`);
  console.log('Report text:', rawText);
  const reportId = engine.submitUserReport(queueID, rawText, 'test-user');

  try {
    const interpreted = await engine.interpretReport(reportId, variant);
    console.log('Interpreted report ✅ ✅ ✅ :', {
      estPplInLine: interpreted.estPplInLine,
      estimatedWaitMins: interpreted.estimatedWaitMins,
      movementRate: interpreted.movementRate,
      entryOutcome: interpreted.entryOutcome,
      aiConfidence: interpreted.aiConfidence,
    });
  } catch (err) {
    console.error('interpretReport failed:', (err as Error).message);
    return;
  }

  try {
    const pred = await engine.runPrediction(queueID);
    console.log('Prediction result ✅ ✅ ✅ :', {
      estWaitTimeMins: pred.estWaitTimeMins,
      entryProbability: pred.entryProbability,
      confidenceIntervalMins: pred.confidenceIntervalMins,
      aiSummary: pred.aiSummary,
    });
  } catch (err) {
    console.error('runPrediction failed ❌ ❌ ❌:', (err as Error).message);
    return;
  }

  try {
    const summary = await engine.summarizeForecast(queueID);
    console.log('📝 Final AI summary (from summarizeForecast):', summary);
  } catch (err) {
    console.warn('⚠️ summarizeForecast failed:', (err as Error).message);
  }
}

async function main() {
  console.log('Starting AI PredictionEngine Test Driver');
  console.log('================================');

  const config = loadConfig();
  const llm = new GeminiLLM(config);
  const engine = new PredictionEngine(llm);

  // create a queue with some historical info
  const queueID = 'pop-up-makeup-launch-001';
  engine.createQueue(queueID, 45 /*hist avg mins*/, 20 /*hist ppl*/);

  //3 test cases/scenarios
  const cases = [
    {
      text: 'Line wraps around two blocks, maybe ~30 people ahead, moving steady but slow',
      variant: 0,
    },
    {
      text: 'About 10 ppl ahead, inside building, moving fast. I am close.',
      variant: 1,
    },
    {
      text: 'Crazy long, not moving at all. People leaving. Looks like a disaster, probably >100 people',
      variant: 2,
    },
  ];

  for (const c of cases) {
    await testScenario(engine, queueID, c.text, c.variant);
  }

  //show all stored reports
  console.log('\nAll stored reports:');
  const reports = engine.getReports(queueID);
  for (const r of reports) {
    console.log('-', r.id, r.rawText, '=>', {
      ppl: r.estPplInLine, 
      wait: r.estimatedWaitMins, 
      movement: r.movementRate,
    });
  }

  console.log('\nTests complete.');
}

if (require.main === module) {
  main().catch(err => {
    console.error('Driver error ❌ ❌ ❌: ', (err as Error).message);
    process.exit(1);
  });
}
//Note to self: try to run: ts-node src/aiPredictionEngine.ts
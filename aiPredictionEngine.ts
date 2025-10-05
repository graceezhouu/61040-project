/**
 * Grace Zhou
 * PredictionEngine (AI-augmented) prototype
 * - interpretReport(reportText, queueID): calls LLM to parse free text into structured fields
 * - runPrediction(queueID): combine historical heuristic + parsed reports -> produce predictionResult
 * - summarizeForecast(queueID): calls LLM to produce a natural-language summary
 *
 * minimal backend prototype
 */

import { GeminiLLM } from './gemini-llm';

export interface UserReport {
  id: string;
  queueID: string;
  userID?: string;
  rawText: string;
  timestamp: number;
  // structured (optional): populated after LLM interpretation
  estPplInLine?: number | null;
  estimatedWaitMins?: number | null;
  movementRate?: 'stopped' | 'slow' | 'steady' | 'fast' | null;
  entryOutcome?: 'entered' | 'denied' | 'left' | null;
  aiConfidence?: number | null;
}

export interface PredictionResult {
  queueID: string;
  estWaitTimeMins: number | null;
  entryProbability: number | null; // 0..100
  confidenceIntervalMins?: [number, number] | null;
  aiSummary?: string | null;
  lastRun: number;
}

interface StoredQueue {
  queueID: string;
  historicalAvgMins?: number | null;
  historicalAvgPpl?: number | null;
}

export class PredictionEngine {
  private llm: GeminiLLM;
  //in-memory stores
  private userReports: Map<string, UserReport[]> = new Map();
  private predictions: Map<string, PredictionResult> = new Map();
  private queues: Map<string, StoredQueue> = new Map();

  constructor(llm: GeminiLLM) {
    this.llm = llm;
  }

  //create or update a queue (minimal)
  createQueue(queueID: string, historicalAvgMins?: number | null, historicalAvgPpl?: number | null) {
    this.queues.set(queueID, {
      queueID,
      historicalAvgMins: historicalAvgMins ?? null,
      historicalAvgPpl: historicalAvgPpl ?? null,
    });
    this.userReports.set(queueID, []);
  }

  //apend a raw user report (text)
  submitUserReport(queueID: string, rawText: string, userID?: string) {
    if (!this.queues.has(queueID)) throw new Error(`Queue ${queueID} does not exist`);
    const r: UserReport = {
      id: `r-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      queueID,
      userID,
      rawText,
      timestamp: Date.now(),
    };
    this.userReports.get(queueID)!.push(r);
    return r.id;
  }

  //interpret a single report using the LLM. Returns structured UserReport.
  async interpretReport(reportId: string, promptVariant = 0): Promise<UserReport> {
    //locate report
    let targetReport: UserReport | undefined;
    for (const [q, list] of this.userReports.entries()) {
      const found = list.find((r) => r.id === reportId);
      if (found) { targetReport = found; break; }
    }
    if (!targetReport) throw new Error(`Report ${reportId} not found`);

    const prompt = this.buildInterpretPrompt(targetReport.rawText, promptVariant);

    console.log(`\nInterpretReport: sending to LLM (variant ${promptVariant})`);
    console.log('PROMPT (truncated):', prompt.slice(0, 450), '...\n');

    const raw = await this.llm.executeLLM(prompt, 300);

    console.log('⤷ Raw LLM interpret output:\n', raw);

    // Try to extract JSON object from LLM output
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM interpretReport did not return JSON object');
    }

    let parsed: any;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (err) {
      //if parse fails, try to be tolerant: replace single quotes etc
      const cleaned = jsonMatch[0].replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":').replace(/'/g, '"');
      parsed = JSON.parse(cleaned);
    }

    //validate and normalize parsed result
    const validated = this.validateInterpreted(parsed);

    // merge into stored report object
    targetReport.estPplInLine = validated.estPplInLine;
    targetReport.estimatedWaitMins = validated.estimatedWaitMins;
    targetReport.movementRate = validated.movementRate;
    targetReport.entryOutcome = validated.entryOutcome ?? null;
    targetReport.aiConfidence = validated.aiConfidence ?? null;

    return targetReport;
  }

  /**
   * runPrediction(queueID): compute prediction based on:
   *  - queue historical averages (if present)
   *  - parsed user reports (if any)
   *  - produce numeric estWaitTimeMins, entryProbability, confidenceInterval
   *
   */
  async runPrediction(queueID: string): Promise<PredictionResult> {
    if (!this.queues.has(queueID)) throw new Error(`Queue ${queueID} does not exist`);

    const stored = this.queues.get(queueID)!;
    const reports = (this.userReports.get(queueID) ?? []).filter(r => r.estPplInLine !== undefined);

    //heuristic baseline using historical averages
    const historicalEstimate = stored.historicalAvgMins ?? null;
    const historicalPpl = stored.historicalAvgPpl ?? null;

    // Compute aggregated reported stats
    let reportedPplAvg: number | null = null;
    let reportedWaitAvg: number | null = null;
    if (reports.length > 0) {
      const pplVals = reports.map(r => r.estPplInLine!).filter(n => typeof n === 'number' && n >= 0);
      const waitVals = reports.map(r => r.estimatedWaitMins!).filter(n => typeof n === 'number' && n >= 0);
      if (pplVals.length > 0) reportedPplAvg = Math.round(pplVals.reduce((a,b) => a+b, 0) / pplVals.length);
      if (waitVals.length > 0) reportedWaitAvg = Math.round(waitVals.reduce((a,b) => a+b, 0) / waitVals.length);
    }

    //prefer live reports when present
    const estWait = reportedWaitAvg ?? historicalEstimate ?? (reportedPplAvg ? reportedPplAvg * 2 : null); //naive factor: 2 mins per person
    const estPpl = reportedPplAvg ?? historicalPpl ?? null;

    //entryProbability: crude heuristic
    let entryProb: number | null = null;
    if (estWait === null && estPpl === null) {
      entryProb = null;
    } else {
      if (estWait !== null) {
        //longer waits reduce entry probability
        entryProb = Math.max(5, 95 - estWait / 2); // arbitrary mapping
      } else if (estPpl !== null) {
        entryProb = Math.max(5, 95 - estPpl * 1.5);
      } else {
        entryProb = 50;
      }
    }
    //clamp
    if (typeof entryProb === 'number') {
      entryProb = Math.max(0, Math.min(100, Math.round(entryProb)));
    }

    //confidence interval: small if many reports, larger if only historical
    let ci: [number, number] | null = null;
    if (estWait !== null) {
      const base = Math.max(10, Math.round((reports.length > 0 ? 20 / reports.length : 30)));
      ci = [Math.max(0, estWait - base), estWait + base];
    }

    //assemble prediction result
    const pred: PredictionResult = {
      queueID,
      estWaitTimeMins: estWait ?? null,
      entryProbability: entryProb ?? null,
      confidenceIntervalMins: ci,
      aiSummary: null,
      lastRun: Date.now(),
    };

    //Save preliminary prediction
    this.predictions.set(queueID, pred);

    //use LLM to produce an AI summary and optionally refine numbers (safe mode: don't let LLM override validated numeric outputs unless validated)
    try {
      const summaryPrompt = this.buildSummaryPrompt(queueID, pred, reports);
      const summaryRaw = await this.llm.executeLLM(summaryPrompt, 220);
      //extract JSON if poss
      const jsonMatch = summaryRaw.match(/\{[\s\S]*\}/);
      let aiSummary = summaryRaw;
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          //if LLM suggests numeric adjustments, validate them before applying
          if (typeof parsed.estWaitTimeMins === 'number' || typeof parsed.entryProbability === 'number') {
            //validators: ensure reasonable ranges and not contradictory
            const candidate = {
              estWaitTimeMins: parsed.estWaitTimeMins ?? pred.estWaitTimeMins,
              entryProbability: parsed.entryProbability ?? pred.entryProbability,
            };
            this.runPredictionValidators(candidate);
            //accept candidate values
            pred.estWaitTimeMins = candidate.estWaitTimeMins ?? pred.estWaitTimeMins;
            pred.entryProbability = candidate.entryProbability ?? pred.entryProbability;
            if (parsed.confidenceIntervalMins && Array.isArray(parsed.confidenceIntervalMins)) {
              pred.confidenceIntervalMins = parsed.confidenceIntervalMins as [number, number];
            }
            if (parsed.aiSummary && typeof parsed.aiSummary === 'string') {
              aiSummary = parsed.aiSummary;
            }
          } else if (parsed.aiSummary && typeof parsed.aiSummary === 'string') {
            aiSummary = parsed.aiSummary;
          }
        } catch (err) {
          //ignore JSON parse issues, use raw text as summary
        }
      }
      pred.aiSummary = (typeof aiSummary === 'string') ? aiSummary.trim() : null;
      pred.lastRun = Date.now();
      this.predictions.set(queueID, pred);
    } catch (err) {
      console.warn('LLM summary/refinement failed ⚠️ ⚠️ ⚠️ :', (err as Error).message);
      //leave pred.aiSummary null
    }

    return pred;
  }

  //produce a human-readable summary using the LLM (separate action)
  async summarizeForecast(queueID: string): Promise<string> {
    const pred = this.predictions.get(queueID);
    if (!pred) throw new Error(`No prediction for queue ${queueID}`);

    const prompt = `You are a concise queue-reporting assistant. Given:
- estimated wait minutes: ${pred.estWaitTimeMins ?? 'unknown'}
- entry probability (0-100): ${pred.entryProbability ?? 'unknown'}
- confidence interval: ${pred.confidenceIntervalMins ? pred.confidenceIntervalMins.join(' to ') : 'unknown'}

Write a single-sentence summary (<= 30 words) for end users, and then return a JSON object with keys:
{
  "aiSummary": "...",
  "estWaitTimeMins": number|null,
  "entryProbability": number|null
}
Return ONLY the JSON object.`;

    const raw = await this.llm.executeLLM(prompt, 120);
    console.log('Raw LLM summarizeForecast output:\n', raw);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LLM did not return JSON from summarizeForecast');

    const parsed = JSON.parse(jsonMatch[0]);
    // basic validation
    if (parsed.estWaitTimeMins !== null) {
      if (typeof parsed.estWaitTimeMins !== 'number') throw new Error('summarizeForecast: estWaitTimeMins not numeric');
    }
    if (parsed.entryProbability !== null) {
      if (typeof parsed.entryProbability !== 'number') throw new Error('summarizeForecast: entryProbability not numeric');
    }
    //store summary
    const predStore = this.predictions.get(queueID)!;
    predStore.aiSummary = parsed.aiSummary ?? predStore.aiSummary;
    if (typeof parsed.estWaitTimeMins === 'number') predStore.estWaitTimeMins = parsed.estWaitTimeMins;
    if (typeof parsed.entryProbability === 'number') predStore.entryProbability = parsed.entryProbability;
    this.predictions.set(queueID, predStore);
    return parsed.aiSummary;
  }

  //helpers: build prompts and validators

  private buildInterpretPrompt(rawText: string, variant = 0): string {
    // three prompt styles supported by test driver (variant 0,1,2)
    const base = `You are an assistant that reads a short user report about a physical queue (line) and returns a JSON object describing:
- estPplInLine: integer estimate of people ahead of the reporter (or null)
- estimatedWaitMins: integer estimate of remaining minutes (or null)
- movementRate: one of "stopped","slow","steady","fast" (or null)
- entryOutcome: optional one of "entered","denied","left" (or null)
- aiConfidence: optional integer 0-100 indicating confidence in extraction

Report text: """${rawText}"""

Return ONLY a JSON object.`;
    if (variant === 0) {
      // direct/extraction
      return `Extract the numeric information from the report.\n\n${base}`;
    } else if (variant === 1) {
      //role-based
      return `You are a careful queue analyst. Interpret the report conservatively; when in doubt prefer null. ${base}`;
    } else {
      //guided mapping with tiny heuristics
      return `Map qualitative phrases to numbers: "block" => 20 people, "crowded" => +30 people, "small" => 5 people.
${base}`;
    }
  }

  private buildSummaryPrompt(queueID: string, pred: any, reports: UserReport[]) {
    const reportsShort = reports.slice(-4).map(r => `- "${r.rawText}"`).join('\n');
    return `You are a helpful assistant that summarizes queue predictions for users.
Queue: ${queueID}
Baseline estWaitTimeMins: ${pred.estWaitTimeMins ?? 'unknown'}
EntryProbability: ${pred.entryProbability ?? 'unknown'}
Recent reports (latest up to 4):
${reportsShort || '- none'}

Return a JSON object containing optionally:
{
  "estWaitTimeMins": number | null,
  "entryProbability": number | null,
  "confidenceIntervalMins": [number, number] | null,
  "aiSummary": string
}
Be concise. Return ONLY the JSON object.`;
  }

  //basic validation of interpreted fields (from LLM)
  private validateInterpreted(parsed: any): {
    estPplInLine: number | null;
    estimatedWaitMins: number | null;
    movementRate: 'stopped'|'slow'|'steady'|'fast'|null;
    entryOutcome?: 'entered'|'denied'|'left'|null;
    aiConfidence?: number|null;
  } {
    const out: any = {
      estPplInLine: null,
      estimatedWaitMins: null,
      movementRate: null,
      entryOutcome: null,
      aiConfidence: null,
    };

    //accept numeric or numeric-like strings
    if (parsed.estPplInLine !== undefined && parsed.estPplInLine !== null) {
      const asNum = Number(parsed.estPplInLine);
      if (!Number.isFinite(asNum) || asNum < 0) throw new Error('validator: estPplInLine invalid');
      out.estPplInLine = Math.round(asNum);
    }

    if (parsed.estimatedWaitMins !== undefined && parsed.estimatedWaitMins !== null) {
      const asNum = Number(parsed.estimatedWaitMins);
      if (!Number.isFinite(asNum) || asNum < 0) throw new Error('validator: estimatedWaitMins invalid');
      out.estimatedWaitMins = Math.round(asNum);
    }

    if (parsed.movementRate) {
      const v = String(parsed.movementRate).toLowerCase();
      if (['stopped','slow','steady','fast'].includes(v)) out.movementRate = v as any;
      else throw new Error('validator: movementRate invalid');
    }

    if (parsed.entryOutcome) {
      const v = String(parsed.entryOutcome).toLowerCase();
      if (['entered','denied','left'].includes(v)) out.entryOutcome = v as any;
      else throw new Error('validator: entryOutcome invalid');
    }

    if (parsed.aiConfidence !== undefined && parsed.aiConfidence !== null) {
      const asNum = Number(parsed.aiConfidence);
      if (!Number.isFinite(asNum) || asNum < 0 || asNum > 100) throw new Error('validator: aiConfidence invalid');
      out.aiConfidence = Math.round(asNum);
    }

    return out;
  }

  // validators for candidate prediction overrides from LLM
  private runPredictionValidators(candidate: { estWaitTimeMins?: any; entryProbability?: any }) {
    if (candidate.estWaitTimeMins !== undefined && candidate.estWaitTimeMins !== null) {
      if (typeof candidate.estWaitTimeMins !== 'number') throw new Error('Prediction validator: estWaitTimeMins not numeric');
      if (!Number.isFinite(candidate.estWaitTimeMins) || candidate.estWaitTimeMins < 0 || candidate.estWaitTimeMins > 24*60) throw new Error('Prediction validator: estWaitTimeMins out of range');
    }
    if (candidate.entryProbability !== undefined && candidate.entryProbability !== null) {
      if (typeof candidate.entryProbability !== 'number') throw new Error('Prediction validator: entryProbability not numeric');
      if (!Number.isFinite(candidate.entryProbability) || candidate.entryProbability < 0 || candidate.entryProbability > 100) throw new Error('Prediction validator: entryProbability out of range');
    }
    //coherence check: a zero ppl / zero wait but high entryProbability is suspicious but allowed; keep soft checks only
  }

  // getter for stored predictions (for test driver)
  getPrediction(queueID: string): PredictionResult | undefined {
    return this.predictions.get(queueID);
  }

  getReports(queueID: string): UserReport[] {
    return this.userReports.get(queueID) ?? [];
  }
}

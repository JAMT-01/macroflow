import { runBenchmark, type BenchmarkStrategy } from "../server/benchmark.js";
import { db } from "../server/db.js";

const promptVersion = "cvpr-two-step-v2-reasoning-controlled";
const caseIds = [
  "nutrition5k-1558459115",
  "nutrition5k-1558546663",
  "nutrition5k-1557862783"
];
const models = [
  "google/gemini-3.1-flash-lite",
  "google/gemma-4-31b-it",
  "qwen/qwen3.7-plus",
  "google/gemini-3.6-flash",
  "qwen/qwen3.8-max"
];
const strategies: BenchmarkStrategy[] = ["one-step", "two-step"];

const jobs = models.flatMap((model) => strategies.flatMap((strategy) => caseIds.map((caseId) => ({ model, strategy, caseId }))));
const existing = db.prepare("SELECT 1 FROM benchmark_runs WHERE prompt_version = ? AND model = ? AND strategy = ? AND case_id = ? LIMIT 1");
const pending = jobs.filter((job) => !existing.get(promptVersion, job.model, job.strategy, job.caseId));
let cursor = 0;
let failures = 0;

console.log(JSON.stringify({ event: "start", total: jobs.length, existing: jobs.length - pending.length, pending: pending.length }));

async function worker(workerId: number) {
  while (cursor < pending.length) {
    const jobNumber = cursor++;
    const job = pending[jobNumber];
    try {
      const result = await runBenchmark(job.caseId, job.model, job.strategy);
      console.log(JSON.stringify({
        event: "complete",
        worker: workerId,
        progress: `${jobNumber + 1}/${pending.length}`,
        model: job.model,
        strategy: job.strategy,
        caseId: job.caseId,
        calorieError: result?.metrics.calories.absolute,
        costUsd: result?.usage.costUsd,
        latencyMs: result?.latencyMs
      }));
    } catch (error) {
      failures += 1;
      console.error(JSON.stringify({ event: "failure", worker: workerId, ...job, error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

await Promise.all([worker(1), worker(2)]);
console.log(JSON.stringify({ event: "finish", completed: pending.length - failures, failures }));
if (failures) process.exitCode = 1;

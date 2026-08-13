import { useEffect, useMemo, useState } from "react";
import { Activity, Beaker, BrainCircuit, Camera, ChevronDown, Clock3, Coins, Database, ExternalLink, FlaskConical, Gauge, Image as ImageIcon, LoaderCircle, Plus, Ruler, ScanLine, Sparkles, Trophy, Upload } from "lucide-react";
import { api } from "../api";
import type { BenchmarkCase, BenchmarkResearch, Settings, VisionModel } from "../types";

type Strategy = "one-step" | "one-step-depth" | "one-step-predicted-depth" | "two-step" | "two-step-depth" | "two-step-predicted-depth";

const strategies: Array<{ id: Strategy; title: string; flow: string; description: string; icon: typeof Camera }> = [
  { id: "one-step", title: "One-step RGB", flow: "image → macros", description: "Direct baseline: one prompt estimates the whole meal.", icon: Camera },
  { id: "one-step-depth", title: "RGB + sensor depth", flow: "RGB + RealSense → macros", description: "Direct prompt with actual measured depth as a control.", icon: ScanLine },
  { id: "one-step-predicted-depth", title: "RGB + photo depth", flow: "RGB + predicted depth → macros", description: "Direct prompt with CPU-generated relative geometry.", icon: Ruler },
  { id: "two-step", title: "Two-step RGB", flow: "image → components → macros", description: "CVPR 2025 method: portions, oil and cooking first; nutrition second.", icon: BrainCircuit },
  { id: "two-step-depth", title: "Sensor depth control", flow: "RGB + RealSense → components → macros", description: "Uses the dataset's actual depth sensor as a control.", icon: ScanLine },
  { id: "two-step-predicted-depth", title: "Photo-only depth", flow: "RGB + predicted depth → macros", description: "Uses CPU-generated relative geometry without LiDAR.", icon: Ruler }
];

function format(value: number, digits = 1) {
  return Number(value).toFixed(digits);
}

export function BenchmarkLab({ settings }: { settings: Settings }) {
  const [cases, setCases] = useState<BenchmarkCase[]>([]);
  const [models, setModels] = useState<VisionModel[]>([]);
  const [research, setResearch] = useState<BenchmarkResearch | null>(null);
  const [model, setModel] = useState(settings.openrouterModel);
  const [strategy, setStrategy] = useState<Strategy>("two-step");
  const [runningCase, setRunningCase] = useState("");
  const [error, setError] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [savingCase, setSavingCase] = useState(false);

  async function refreshCases() { setCases(await api.benchmarkCases()); }
  useEffect(() => {
    Promise.all([api.benchmarkCases(), api.benchmarkModels(), api.benchmarkResearch()])
      .then(([nextCases, nextModels, nextResearch]) => { setCases(nextCases); setModels(nextModels); setResearch(nextResearch); })
      .catch((reason: Error) => setError(reason.message));
  }, []);

  const leaderboard = useMemo(() => {
    const groups = new Map<string, BenchmarkCase["runs"]>();
    for (const benchmarkCase of cases) for (const run of benchmarkCase.runs) {
      const key = `${run.model}|||${run.strategy}`;
      groups.set(key, [...(groups.get(key) ?? []), run]);
    }
    return [...groups.entries()].map(([key, runs]) => {
      const [groupModel, groupStrategy] = key.split("|||");
      const avg = (read: (run: BenchmarkCase["runs"][number]) => number) => runs.reduce((sum, run) => sum + read(run), 0) / runs.length;
      const pmae = (metric: "calories" | "protein" | "carbs" | "fat" | "mass") => runs.reduce((sum, run) => sum + run.metrics[metric].absolute, 0) / Math.max(1, runs.reduce((sum, run) => sum + run.metrics[metric].truth, 0)) * 100;
      return {
        model: groupModel, strategy: groupStrategy, runs: runs.length,
        calorieMae: avg((run) => run.metrics.calories.absolute),
        macroMae: avg((run) => run.macroAbsoluteError),
        caloriePmae: pmae("calories"),
        macroPmae: (pmae("protein") + pmae("carbs") + pmae("fat")) / 3,
        costPerRun: avg((run) => run.usage.costUsd),
        latencyMs: avg((run) => run.latencyMs)
      };
    }).sort((a, b) => a.calorieMae - b.calorieMae);
  }, [cases]);

  const leaders = useMemo(() => {
    if (!leaderboard.length) return null;
    const pick = (field: "macroMae" | "costPerRun" | "latencyMs") => [...leaderboard].sort((a, b) => a[field] - b[field])[0];
    return { calorie: leaderboard[0], macros: pick("macroMae"), cost: pick("costPerRun"), speed: pick("latencyMs") };
  }, [leaderboard]);

  const depthComparison = useMemo(() => {
    const rows = leaderboard.filter((row) => row.model === "google/gemini-3.6-flash");
    const rgb = rows.find((row) => row.strategy === "one-step");
    const predicted = rows.find((row) => row.strategy === "one-step-predicted-depth");
    const sensor = rows.find((row) => row.strategy === "one-step-depth");
    if (!rgb || !predicted || !sensor) return null;
    return { rgb, predicted, sensor, calorieChange: (predicted.calorieMae - rgb.calorieMae) / rgb.calorieMae * 100 };
  }, [leaderboard]);

  async function run(caseId: string) {
    setRunningCase(caseId); setError("");
    try { await api.runBenchmark(caseId, model, strategy); await refreshCases(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Benchmark failed"); }
    finally { setRunningCase(""); }
  }

  async function createCase(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSavingCase(true); setError("");
    try { await api.createBenchmarkCase(new FormData(event.currentTarget)); await refreshCases(); event.currentTarget.reset(); setShowCustom(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not add case"); }
    finally { setSavingCase(false); }
  }

  return (
    <div className="page benchmark-page">
      <header className="page-header benchmark-header"><div><p className="eyebrow">EVIDENCE, NOT VIBES</p><h1>Nutrition accuracy lab</h1><p className="page-subtitle">Test the exact same weighed meals across models and prompt pipelines.</p></div><div className={`status-badge ${settings.openrouterConfigured ? "online" : "offline"}`}><i />{settings.openrouterConfigured ? "OpenRouter ready" : "Add a new API key"}</div></header>

      {error && <div className="notice warning benchmark-error"><Activity size={18} /><span>{error}</span></div>}

      {research && <section className="research-strip">
        <div className="research-intro"><span><Database /></span><div><p className="eyebrow">GROUND TRUTH</p><h2>{research.dataset.name}</h2><p>{research.dataset.note}</p><a href={research.dataset.url} target="_blank" rel="noreferrer">Official dataset · {research.dataset.license} <ExternalLink size={13} /></a></div></div>
        <div className="finding-grid">{research.findings.map((finding) => <a href={finding.url} target="_blank" rel="noreferrer" key={`${finding.label}-${finding.value}`}><span>{finding.label}</span><strong>{finding.value}</strong></a>)}</div>
      </section>}

      <section className="lab-controls">
        <div className="control-heading"><div><p className="eyebrow">EXPERIMENT DESIGN</p><h2>Choose one variable at a time</h2></div><div className="model-select"><label>OpenRouter model</label><div><select value={model} onChange={(event) => setModel(event.target.value)}><option value={settings.openrouterModel}>{settings.openrouterModel}</option>{models.filter((item) => item.id !== settings.openrouterModel).map((item) => <option value={item.id} key={item.id}>{item.name} · {item.id}</option>)}</select><ChevronDown size={16} /></div></div></div>
        <div className="strategy-grid">{strategies.map(({ id, title, flow, description, icon: Icon }) => <button className={strategy === id ? "active" : ""} onClick={() => setStrategy(id)} key={id}><span><Icon /></span><div><strong>{title}</strong><code>{flow}</code><p>{description}</p></div></button>)}</div>
        <div className="lab-method"><FlaskConical /><span>Controlled settings: temperature 0.5, strict JSON, 1,024 answer-token budget. Models that require reasoning use minimum effort; those tokens and their cost are logged separately.</span></div>
      </section>

      {research?.depthStudy && depthComparison && <section className="depth-study-card">
        <div className="depth-study-heading"><span><Ruler /></span><div><p className="eyebrow">PHOTO-ONLY DEPTH ABLATION</p><h2>No consistent improvement yet</h2><p>Depth Anything V2 recovered useful relative structure, but its absolute scale was wrong and passing the colorized map to the nutrition model did not improve the repeated estimate.</p></div><strong>KEEP RGB BASELINE</strong></div>
        <div className="depth-study-grid">
          <article><small>RGB only · 9 trials</small><strong>{format(depthComparison.rgb.calorieMae)} kcal</strong><span>{format(depthComparison.rgb.macroMae)} g macro MAE · ${depthComparison.rgb.costPerRun.toFixed(4)}</span></article>
          <article className="depth-negative"><small>RGB + predicted depth · 9 trials</small><strong>{format(depthComparison.predicted.calorieMae)} kcal</strong><span>{format(depthComparison.predicted.macroMae)} g macro MAE · {format(Math.abs(depthComparison.calorieChange))}% {depthComparison.calorieChange > 0 ? "worse" : "better"}</span></article>
          <article><small>RGB + sensor depth · 9 trials</small><strong>{format(depthComparison.sensor.calorieMae)} kcal</strong><span>{format(depthComparison.sensor.macroMae)} g macro MAE · ${depthComparison.sensor.costPerRun.toFixed(4)}</span></article>
          <article><small>Depth model diagnostic</small><strong>{format(research.depthStudy.meanScaleAlignedMaeMeters * 100)} cm</strong><span>aligned depth MAE · {format(research.depthStudy.meanLatencySeconds, 2)}s CPU</span></article>
        </div>
        <p className="depth-study-note"><b>Why:</b> median predicted distance was about 0.96 m while the RealSense measurement was about 0.38 m. A remembered plate diameter can correct global scale, but the geometry must be calculated numerically; merely showing a depth heatmap to the VLM is not enough. SAM 3 remains untested because no fal API credential is configured.</p>
      </section>}

      {leaderboard.length > 0 && leaders && <section className="leaderboard-card">
        <div className="section-title"><div><p className="eyebrow">RUNNING AVERAGES</p><h2>Leaderboard</h2></div><span>Lower is better</span></div>
        <div className="lab-summary-grid">
          <article><Trophy /><small>Best calories</small><strong>{leaders.calorie.model}</strong><span>{format(leaders.calorie.calorieMae)} kcal MAE</span></article>
          <article><Gauge /><small>Best macros</small><strong>{leaders.macros.model}</strong><span>{format(leaders.macros.macroMae)} g MAE</span></article>
          <article><Coins /><small>Lowest API cost</small><strong>{leaders.cost.model}</strong><span>${leaders.cost.costPerRun.toFixed(4)} / plate</span></article>
          <article><Clock3 /><small>Fastest</small><strong>{leaders.speed.model}</strong><span>{(leaders.speed.latencyMs / 1000).toFixed(1)}s / plate</span></article>
        </div>
        <div className="accuracy-bars"><div className="accuracy-bars-title"><strong>Calorie error by configuration</strong><span>Mean absolute error across the weighed plates</span></div>{leaderboard.map((row) => <div className="accuracy-bar-row" key={`bar-${row.model}-${row.strategy}`}><span><strong>{row.model.replace(/^.*\//, "")}</strong><small>{strategies.find((item) => item.id === row.strategy)?.title}</small></span><i><b style={{ width: `${Math.max(3, row.calorieMae / Math.max(...leaderboard.map((item) => item.calorieMae)) * 100)}%` }} /></i><em>{format(row.calorieMae)} kcal</em></div>)}</div>
        <div className="leaderboard-table"><div className="table-head"><span>Model / pipeline</span><span>Trials</span><span>Calorie MAE</span><span>Calorie PMAE</span><span>Macro MAE</span><span>Macro PMAE</span><span>Cost / plate</span><span>Latency</span></div>{leaderboard.map((row, index) => <div className="table-row" key={`${row.model}-${row.strategy}`}><span><b>{index + 1}</b><div><strong>{row.model}</strong><small>{strategies.find((item) => item.id === row.strategy)?.title}</small></div></span><span>{row.runs}</span><span>{format(row.calorieMae)} kcal</span><span>{format(row.caloriePmae)}%</span><span>{format(row.macroMae)} g</span><span>{format(row.macroPmae)}%</span><span>${row.costPerRun.toFixed(4)}</span><span>{(row.latencyMs / 1000).toFixed(1)}s</span></div>)}</div>
        <p className="benchmark-caveat">Exploratory benchmark: the five-model comparison uses one valid run per plate/configuration. The Gemini 3.6 direct-depth ablation uses three repetitions per plate (nine trials per configuration). Qwen 3.7 Plus produced valid strict JSON on 3/6 first attempts; failed calls were retried and excluded from displayed accuracy and cost. Three plates are not a statistically conclusive model ranking.</p>
      </section>}

      <section className="benchmark-cases">
        <div className="section-title"><div><p className="eyebrow">WEIGHED TEST PLATES</p><h2>Benchmark cases</h2></div><button className="secondary" onClick={() => setShowCustom(!showCustom)}><Plus size={16} /> Add weighed meal</button></div>

        {showCustom && <form className="custom-case" onSubmit={createCase}>
          <div className="custom-case-copy"><Upload /><div><h3>Add your own ground truth</h3><p>Weigh the complete edible meal and enter known totals. An optional aligned depth image lets you test the depth pipeline.</p></div></div>
          <div className="form-grid two"><label className="field"><span>Case name</span><input required name="name" placeholder="Homemade chicken milanesa" /></label><label className="field"><span>Known ingredients, comma-separated</span><input name="ingredients" placeholder="chicken, breadcrumbs, sunflower oil" /></label></div>
          <div className="form-grid five"><label className="field"><span>Mass (g)</span><input required name="truthMass" type="number" step="0.1" /></label><label className="field"><span>Calories</span><input required name="truthCalories" type="number" step="0.1" /></label><label className="field"><span>Protein</span><input required name="truthProtein" type="number" step="0.1" /></label><label className="field"><span>Carbs</span><input required name="truthCarbs" type="number" step="0.1" /></label><label className="field"><span>Fat</span><input required name="truthFat" type="number" step="0.1" /></label></div>
          <div className="file-pair"><label><ImageIcon /><span><strong>RGB meal photo</strong><small>Required</small></span><input required name="image" type="file" accept="image/*" /></label><label><Ruler /><span><strong>Aligned depth image</strong><small>Optional</small></span><input name="depth" type="file" accept="image/*" /></label></div>
          <button className="primary" disabled={savingCase}>{savingCase ? <LoaderCircle className="spin" /> : <Plus />} Save benchmark case</button>
        </form>}

        <div className="case-grid">{cases.map((benchmarkCase) => {
          const latest = benchmarkCase.runs[0];
          return <article className="case-card" key={benchmarkCase.id}>
            <div className="case-image"><img src={benchmarkCase.imagePath} alt={benchmarkCase.name} /><span>{benchmarkCase.depthPath ? <><ScanLine size={13} /> RGB-D</> : <><Camera size={13} /> RGB</>}</span></div>
            <div className="case-content"><div className="case-source"><span>{benchmarkCase.source}</span><code>{benchmarkCase.sourceId}</code></div><h3>{benchmarkCase.name}</h3><p>{benchmarkCase.ingredients.join(" · ")}</p>
              <div className="truth-grid"><span><small>Ground truth</small><strong>{format(benchmarkCase.truth.calories, 0)} kcal</strong></span><span><small>Mass</small><strong>{format(benchmarkCase.truth.mass, 0)} g</strong></span><span><small>P / C / F</small><strong>{format(benchmarkCase.truth.protein)} / {format(benchmarkCase.truth.carbs)} / {format(benchmarkCase.truth.fat)}</strong></span></div>
              {latest && <div className="latest-run"><span><Gauge /><small>Latest · {strategies.find((item) => item.id === latest.strategy)?.title}</small></span><strong>{format(latest.metrics.calories.predicted, 0)} kcal <em>±{format(latest.metrics.calories.absolute, 0)}</em></strong><p>{latest.model} · {(latest.latencyMs / 1000).toFixed(1)}s</p></div>}
              <button className="primary wide" disabled={Boolean(runningCase) || (strategy.endsWith("-depth") && !strategy.endsWith("predicted-depth") && !benchmarkCase.depthPath) || (strategy.endsWith("predicted-depth") && !benchmarkCase.predictedDepthPath) || !settings.openrouterConfigured} onClick={() => run(benchmarkCase.id)}>{runningCase === benchmarkCase.id ? <><LoaderCircle className="spin" /> Running pipeline…</> : <><Sparkles size={17} /> Run {strategies.find((item) => item.id === strategy)?.title}</>}</button>
              {strategy.endsWith("-depth") && !strategy.endsWith("predicted-depth") && !benchmarkCase.depthPath && <small className="depth-missing">This case has no aligned depth image.</small>}
              {strategy.endsWith("predicted-depth") && !benchmarkCase.predictedDepthPath && <small className="depth-missing">Generate predicted depth for this case first.</small>}
            </div>
          </article>;
        })}</div>
      </section>

      <section className="sam-note"><span><Beaker /></span><div><h3>Where SAM 3 fits—and where it doesn’t</h3><p>SAM 3 can isolate every item matching a short noun or exemplar prompt, but it does not estimate grams or nutrients. The published food study tested SAM 2.1/FoodSAM masks and found segmentation was not a universal accuracy win. Keep it as a separate experiment after the raw two-step baseline is measured; otherwise you won’t know which stage helped.</p><a href="https://ai.meta.com/research/publications/sam-3-segment-anything-with-concepts/" target="_blank" rel="noreferrer">SAM 3 primary paper <ExternalLink size={13} /></a></div></section>
    </div>
  );
}

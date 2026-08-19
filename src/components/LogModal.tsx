import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BookMarked, Brain, Camera, Check, Eye, History, Images, ImagePlus, Info, LoaderCircle, Plus, Ruler, Search, Send, Sparkles, Trash2, Utensils, X, Zap } from "lucide-react";
import { api, sumItems } from "../api";
import { prepareMealPhoto } from "../imageCapture";
import { guessMealTypeFromLocalTime, mealTypeMeta, mealTypes } from "../mealTypes";
import type { Analysis, CaptureMetadata, Food, LoggedFood, MealItem, MealTypeChoice, QuickAdd, ScaleReference, Settings } from "../types";

type Mode = "scan" | "search" | "quick" | "mine";

export function LogModal({ defaultMealType, date, settings, onClose, onSaved }: { defaultMealType: MealTypeChoice; date: string; settings: Settings; onClose: () => void; onSaved: () => void }) {
  const [mode, setMode] = useState<Mode>("scan");
  const [mealType, setMealType] = useState<MealTypeChoice>(defaultMealType);
  const [scaleMode, setScaleMode] = useState<ScaleReference["mode"]>("default-plate");
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [capture, setCapture] = useState<CaptureMetadata | null>(null);
  const [preparingImage, setPreparingImage] = useState(false);
  const [description, setDescription] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const [refining, setRefining] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [foods, setFoods] = useState<Food[]>([]);
  const [selected, setSelected] = useState<MealItem[]>([]);
  const [quick, setQuick] = useState({ title: "", calories: 0, protein: 0, carbs: 0, fiber: 0, fat: 0 });
  const [quickAdds, setQuickAdds] = useState<QuickAdd[]>([]);
  const [myFoods, setMyFoods] = useState<LoggedFood[]>([]);
  const [myQuery, setMyQuery] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  // `capture` means camera-only on iOS, so picking from the library needs its own input.
  const galleryInput = useRef<HTMLInputElement>(null);

  const scaleReference: ScaleReference = scaleMode === "none"
    ? { mode: "none", diameterCm: null }
    : { mode: "default-plate", diameterCm: settings.plateDiameterCm };
  // "Auto" resolves to the analysed suggestion when there is one; otherwise to the
  // Argentine time bands. Past days have no meaningful "now", so they fall back to lunch.
  const autoMealType = analysis?.mealTypeSuggestion?.type
    ?? (date === settings.today ? guessMealTypeFromLocalTime(settings.localTime) : "Lunch");
  const resolvedMealType = mealType === "Auto" ? autoMealType : mealType;
  const suggestion = analysis?.mealTypeSuggestion;

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => {
    if (mode !== "search") return;
    const timeout = setTimeout(() => api.foods(query).then(setFoods), 150);
    return () => clearTimeout(timeout);
  }, [mode, query]);
  useEffect(() => {
    if (mode !== "quick") return;
    api.quickAdds().then(setQuickAdds).catch(() => setQuickAdds([]));
  }, [mode]);
  useEffect(() => {
    if (mode !== "mine") return;
    const timeout = setTimeout(() => api.myFoods(myQuery).then(setMyFoods).catch(() => setMyFoods([])), 150);
    return () => clearTimeout(timeout);
  }, [mode, myQuery]);

  async function chooseImage(file: File | undefined) {
    if (!file) return;
    setPreparingImage(true); setError("");
    try {
      const prepared = await prepareMealPhoto(file);
      if (preview) URL.revokeObjectURL(preview);
      setImage(prepared.file);
      setCapture(prepared.metadata);
      setPreview(URL.createObjectURL(prepared.file));
      setAnalysis(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not prepare the photo");
    } finally {
      setPreparingImage(false);
    }
  }

  async function analyze() {
    setLoading(true); setError("");
    try {
      const result = await api.analyze(image, description, capture ?? undefined, scaleReference, date);
      setAnalysis(result);
      if (result.mealTypeSuggestion) setMealType(result.mealTypeSuggestion.type);
      setChatMessages([{ role: "assistant", text: result.assistantReply || (result.appliedMemories?.length ? `I used what I remember: ${result.appliedMemories.join("; ")}. Tell me if anything is different today.` : "I made a first estimate. Tell me how this was cooked or correct anything I can't see.") }]);
    }
    catch (err) { setError(err instanceof Error ? err.message : "Analysis failed"); }
    finally { setLoading(false); }
  }

  async function sendCorrection(prefill?: string) {
    const message = (prefill ?? chatInput).trim();
    if (!analysis || !message || refining) return;
    setChatInput("");
    setChatMessages((messages) => [...messages, { role: "user", text: message }]);
    setRefining(true); setError("");
    try {
      const refined = await api.refineAnalysis(analysis, message);
      setAnalysis(refined);
      const reply = refined.assistantReply || refined.warnings[0] || "I've updated the estimate.";
      setChatMessages((messages) => [...messages, { role: "assistant", text: reply }]);
    } catch (err) {
      const text = err instanceof Error ? err.message : "Could not refine the estimate";
      setError(text);
      setChatMessages((messages) => [...messages, { role: "assistant", text: `I couldn't apply that correction: ${text}` }]);
    } finally { setRefining(false); }
  }

  function updateAnalysisGrams(index: number, grams: number) {
    if (!analysis) return;
    const items = analysis.items.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      const ratio = item.grams ? grams / item.grams : 1;
      return { ...item, grams, gramsLow: item.gramsLow == null ? undefined : item.gramsLow * ratio, gramsHigh: item.gramsHigh == null ? undefined : item.gramsHigh * ratio, calories: item.calories * ratio, protein: item.protein * ratio, carbs: item.carbs * ratio, fiber: (item.fiber ?? 0) * ratio, fat: item.fat * ratio };
    });
    setAnalysis({ ...analysis, items });
  }

  function addFood(food: Food) {
    const grams = food.servingGrams;
    const factor = grams / 100;
    setSelected((items) => [...items, { foodId: food.id, name: food.name, emoji: food.emoji, grams, calories: food.calories * factor, protein: food.protein * factor, carbs: food.carbs * factor, fiber: (food.fiber ?? 0) * factor, fat: food.fat * factor }]);
  }

  function addLoggedFood(entry: LoggedFood) {
    setSelected((items) => [...items, {
      foodId: entry.foodId, name: entry.name, emoji: "🍽️", grams: entry.grams,
      calories: entry.calories, protein: entry.protein, carbs: entry.carbs, fiber: entry.fiber, fat: entry.fat
    }]);
  }

  function updateSelectedGrams(index: number, grams: number) {
    setSelected((items) => items.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      const ratio = item.grams ? grams / item.grams : 1;
      return { ...item, grams, calories: item.calories * ratio, protein: item.protein * ratio, carbs: item.carbs * ratio, fiber: (item.fiber ?? 0) * ratio, fat: item.fat * ratio };
    }));
  }

  async function save(items: MealItem[], title: string, options?: { imagePath?: string; source?: string; confidence?: number }) {
    setLoading(true); setError("");
    try {
      await api.createMeal({ loggedDate: date, mealType: resolvedMealType, title, notes: description, items, imagePaths: analysis?.imagePaths, ...options });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save meal"); setLoading(false); }
  }

  const analysisTotals = useMemo(() => analysis ? sumItems(analysis.items) : null, [analysis]);
  const selectedTotals = useMemo(() => sumItems(selected), [selected]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="log-modal">
        <header className="log-header"><button className="icon-button" onClick={analysis ? () => setAnalysis(null) : onClose}>{analysis ? <ArrowLeft /> : <X />}</button><div><span>LOG A MEAL</span><strong>{analysis ? "Review estimate" : "Add to your diary"}</strong></div><select value={mealType} onChange={(e) => setMealType(e.target.value as MealTypeChoice)}><option value="Auto">Auto → {autoMealType}</option>{mealTypes.map((type) => <option key={type} value={type}>{mealTypeMeta[type].emoji} {type} · {mealTypeMeta[type].hint}</option>)}</select></header>

        {!analysis && <div className="log-tabs"><button className={mode === "scan" ? "active" : ""} onClick={() => setMode("scan")}><Sparkles size={17} /> AI scan</button><button className={mode === "search" ? "active" : ""} onClick={() => setMode("search")}><Search size={17} /> Search</button><button className={mode === "quick" ? "active" : ""} onClick={() => setMode("quick")}><Zap size={17} /> Quick add</button><button className={mode === "mine" ? "active" : ""} onClick={() => setMode("mine")}><BookMarked size={17} /> My foods</button></div>}

        <div className="log-body">
          {!analysis && mode === "scan" && <div className="scan-flow">
            <div className={`upload-zone ${preview ? "has-image" : ""}`} onClick={() => fileInput.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void chooseImage(e.dataTransfer.files[0]); }}>
              <input ref={fileInput} hidden type="file" accept="image/*" capture="environment" onChange={(e) => chooseImage(e.target.files?.[0])} />
              <input ref={galleryInput} hidden type="file" accept="image/*" onChange={(e) => chooseImage(e.target.files?.[0])} />
              {preparingImage ? <><span className="camera-orb"><LoaderCircle className="spin" /></span><strong>Checking photo quality…</strong></> : preview ? <><img src={preview} alt="Meal preview" /><button className="change-photo"><ImagePlus size={16} /> Change photo</button></> : <><span className="camera-orb"><Camera /></span><strong>Take one meal photo</strong><p>About 45°, good light, full plate rim visible</p><button className="secondary"><ImagePlus size={17} /> Take photo</button><button className="ghost pick-gallery" onClick={(e) => { e.stopPropagation(); galleryInput.current?.click(); }}><Images size={15} /> Choose from gallery</button><em className="upload-optional">Optional — you can just describe the meal below</em></>}
            </div>
            {capture && <div className={`capture-quality ${capture.qualityScore >= 70 ? "good" : capture.qualityScore >= 45 ? "usable" : "poor"}`}><span>{capture.qualityScore >= 70 ? <Check size={17} /> : <Info size={17} />}</span><div><strong>{capture.qualityScore >= 70 ? "Photo quality looks good" : capture.qualityScore >= 45 ? "Photo is usable" : "Retake recommended"}</strong><small>{capture.issues.length ? capture.issues.join(" · ") : `${capture.width}×${capture.height} · lighting and sharpness passed`}</small></div></div>}
            {preview && <div className="scale-choice">
              <div className="scale-choice-head"><Ruler size={16} /><strong>Size reference for this photo</strong></div>
              <div className="scale-options">
                <button type="button" className={scaleMode === "default-plate" ? "active" : ""} onClick={() => setScaleMode("default-plate")} aria-pressed={scaleMode === "default-plate"}>
                  <span className="scale-option-title">My {settings.plateDiameterCm} cm plate{scaleMode === "default-plate" && <Check size={14} />}</span>
                  <small><b>{settings.plateDiameterCm} cm straight across the rim</b> — that is the diameter of the whole round plate, not {settings.plateDiameterCm}×{settings.plateDiameterCm}. Keep the complete outer rim in frame.</small>
                </button>
                <button type="button" className={scaleMode === "none" ? "active" : ""} onClick={() => setScaleMode("none")} aria-pressed={scaleMode === "none"}>
                  <span className="scale-option-title">No size reference{scaleMode === "none" && <Check size={14} />}</span>
                  <small>A different plate, a bowl, a pan, a wrapper, or a cropped rim. The model will not convert pixels to centimetres and portions come from familiar serving sizes with a wider range.</small>
                </button>
              </div>
            </div>}
            <label className="field describe-field"><span>{preview ? "Add a note about the meal" : "Or tell me what you ate"} {!preview && <em>no photo needed</em>}</span><textarea rows={3} placeholder={preview ? "Anything the camera cannot see: oil, sugar, hidden ingredients…" : "milanesa con puré y una coca, y de postre un alfajor"} value={description} onChange={(e) => setDescription(e.target.value)} />{!preview && <small>Plain language is fine. Quantities help — “un plato de fideos”, “dos huevos”, “200g de pollo” — but are not required.</small>}</label>
            {!settings.openrouterConfigured && <div className="notice warning"><Info size={18} /><span><strong>OpenRouter key not configured.</strong> Add it once in Settings to enable photo recognition. A description can still be matched locally.</span></div>}
            {error && <div className="error-banner">{error}</div>}
            <button className="primary wide analyze-button" disabled={loading || preparingImage || (!image && !description.trim())} onClick={analyze}>{loading ? <><LoaderCircle className="spin" /> {preview ? "Measuring one photo…" : "Working out the portions…"}</> : <><Sparkles size={18} /> {preview ? "Analyze one photo" : "Estimate from description"}</>}</button>
            <p className="privacy-line"><Check size={14} /> Photos stay on your server and are sent to OpenRouter only for analysis.</p>
          </div>}

          {analysis && analysisTotals && <div className="review-flow">
            <div className="review-hero">{analysis.imagePath && <img src={analysis.imagePath} alt="Analyzed meal" />}<div><span className={`confidence ${analysis.confidence >= .75 ? "good" : "medium"}`}>{Math.round(analysis.confidence * 100)}% confidence</span><h2>{analysis.title}</h2><p>{analysis.provider === "openrouter" ? `${settings.openrouterModel} · ${analysis.usage ? `$${analysis.usage.costUsd.toFixed(4)} · ${(analysis.usage.latencyMs / 1000).toFixed(1)}s` : "estimate"}` : "Local text match"}</p></div></div>
            <div className="estimate-summary five"><div><strong>{Math.round(analysisTotals.calories)}</strong><span>calories</span></div><div><strong>{Math.round(analysisTotals.protein)}g</strong><span>protein</span></div><div><strong>{Math.round(analysisTotals.carbs)}g</strong><span>carbs</span></div><div><strong>{Math.round(analysisTotals.fat)}g</strong><span>fat</span></div><div><strong>{Math.round(analysisTotals.fiber)}g</strong><span>fiber</span></div></div>
            {analysis.range && <div className="estimate-range"><div><span>Likely calorie range</span><strong>{Math.round(analysis.range.calories.low)}–{Math.round(analysis.range.calories.high)} kcal</strong></div><small>One photo cannot reveal exact food height or hidden ingredients. The range narrows when the plate is fully visible and your recipe memory matches.</small></div>}
            {analysis.measurement && <div className={`measurement-card ${analysis.measurement.scaleConfidence}`}><Ruler size={18} /><div><strong>{analysis.measurement.referenceMode === "none" ? "No size reference used" : analysis.measurement.plateUsedAsScale ? `${analysis.measurement.plateDiameterCm} cm plate diameter applied as scale` : "Plate scale could not be applied"}</strong><span>{analysis.measurement.explanation}</span><small>{analysis.measurement.viewAngleDeg == null ? "View angle unknown" : `Approx. ${Math.round(analysis.measurement.viewAngleDeg)}° view`} · {analysis.measurement.scaleConfidence} scale confidence</small></div></div>}
            {suggestion && <div className="meal-type-card"><span className="meal-type-emoji">{mealTypeMeta[suggestion.type].emoji}</span><div><strong>{resolvedMealType === suggestion.type ? `Filed as ${suggestion.type}` : `Saving as ${resolvedMealType}, not ${suggestion.type}`} <em>{mealTypeMeta[resolvedMealType].hint}</em></strong><span>{suggestion.explanation}</span><small>{Math.round(suggestion.confidence * 100)}% · Argentine meal pattern · {analysis.provider === "openrouter" ? "food, your note and local time" : "local time and matched foods"}</small></div>{resolvedMealType === suggestion.type ? <select value={mealType} onChange={(e) => setMealType(e.target.value as MealTypeChoice)} aria-label="Meal category">{mealTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select> : <button type="button" onClick={() => setMealType(suggestion.type)}>Use {suggestion.type}</button>}</div>}
            <div className="review-title"><h3>Detected foods</h3><span>Adjust portions</span></div>
            <div className="review-items">{analysis.items.map((item, index) => <div className="review-item" key={`${item.name}-${index}`}><span className="food-emoji">{item.emoji || "🍽️"}</span><div className="review-item-copy"><strong>{item.name}</strong><p>{Math.round(item.calories)} kcal · P {item.protein.toFixed(1)} · C {item.carbs.toFixed(1)} · F {item.fat.toFixed(1)} · Fib {(item.fiber ?? 0).toFixed(1)}</p>{(item.visualEvidence || item.portionBasis) && <small><Eye size={11} /> {item.visualEvidence} {item.portionBasis && ` Portion: ${item.portionBasis}`}</small>}</div><label><input type="number" min="0" step="5" value={Math.round(item.grams)} onChange={(e) => updateAnalysisGrams(index, +e.target.value)} /><span>g</span></label><button onClick={() => setAnalysis({ ...analysis, items: analysis.items.filter((_, i) => i !== index) })}><Trash2 size={16} /></button></div>)}</div>
            {analysis.assumptions.length > 0 && <div className="assumption-card"><Info size={18} /><div><strong>Confirm these assumptions</strong><ul>{analysis.assumptions.map((assumption, index) => <li key={`${assumption}-${index}`}>{assumption}</li>)}</ul></div></div>}
            {analysis.highImpactQuestion && <button className="high-impact-question" onClick={() => setChatInput(analysis.highImpactQuestion || "")}><Sparkles size={17} /><span><strong>Best question to improve this estimate</strong><small>{analysis.highImpactQuestion}</small></span></button>}
            {analysis.appliedMemories && analysis.appliedMemories.length > 0 && <div className="memory-used"><Brain size={18} /><div><strong>Personal memory applied</strong><span>{analysis.appliedMemories.join(" · ")}</span></div></div>}
            <div className="memory-chat">
              <div className="chat-heading"><div><span className="ai-dot"><Sparkles size={15} /></span><div><strong>Refine with AI</strong><small>Corrections can become personal meal memories</small></div></div><Brain size={19} /></div>
              <div className="chat-thread">{chatMessages.map((message, index) => <div key={index} className={`chat-bubble ${message.role}`}>{message.text}</div>)}{refining && <div className="chat-bubble assistant typing"><i /><i /><i /></div>}</div>
              <div className="suggestion-chips"><button onClick={() => sendCorrection("This is homemade. Ask me what cooking details you should remember.")}>Homemade</button><button onClick={() => sendCorrection("It was cooked with sunflower oil in the oven. Remember this for similar meals.")}>Oven + sunflower oil</button><button onClick={() => sendCorrection("The portion estimate is too large. This correction is only for today's plate.")}>Smaller portion</button></div>
              <div className="chat-composer"><input placeholder="e.g. I always bake this with sunflower oil…" value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void sendCorrection(); }} /><button disabled={!chatInput.trim() || refining} onClick={() => sendCorrection()}><Send size={17} /></button></div>
              {analysis.memorySaved && <div className="memory-saved"><Check size={14} /> Saved to meal memory: {analysis.memorySaved}</div>}
            </div>
            {analysis.warnings.length > 0 && <div className="notice"><Info size={18} /><span>{analysis.warnings[0]}</span></div>}
            {error && <div className="error-banner">{error}</div>}
            <button className="primary wide" disabled={loading || !analysis.items.length} onClick={() => save(analysis.items, analysis.title, { imagePath: analysis.imagePath, source: analysis.provider, confidence: analysis.confidence })}>{loading ? <LoaderCircle className="spin" /> : <Check size={18} />} Confirm and save {Math.round(analysisTotals.calories)} kcal</button>
          </div>}

          {!analysis && mode === "search" && <div className="search-flow">
            <div className="search-box"><Search /><input autoFocus placeholder="Search chicken, rice, empanada…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
            {selected.length > 0 && <div className="selected-foods"><div className="review-title"><h3>Your plate</h3><strong>{Math.round(selectedTotals.calories)} kcal</strong></div>{selected.map((item, index) => <div className="selected-row" key={`${item.name}-${index}`}><span>{item.emoji}</span><div><strong>{item.name}</strong><small>{Math.round(item.calories)} kcal · P {item.protein.toFixed(1)} · C {item.carbs.toFixed(1)} · F {item.fat.toFixed(1)} · Fib {(item.fiber ?? 0).toFixed(1)}</small></div><label><input type="number" value={Math.round(item.grams)} onChange={(e) => updateSelectedGrams(index, +e.target.value)} /><span>g</span></label><button onClick={() => setSelected(selected.filter((_, i) => i !== index))}><X size={16} /></button></div>)}</div>}
            <div className="food-results"><p className="eyebrow">{query ? "RESULTS" : "POPULAR FOODS"}</p>{foods.map((food) => <button className="food-result" key={food.id} onClick={() => addFood(food)}><span className="food-emoji">{food.emoji}</span><div><strong>{food.name}</strong><p>{food.servingLabel} · {food.servingGrams}g</p></div><div><strong>{Math.round(food.calories * food.servingGrams / 100)}</strong><span>kcal</span></div><Plus size={18} /></button>)}</div>
            {error && <div className="error-banner">{error}</div>}
            {selected.length > 0 && <button className="primary wide sticky-save" disabled={loading} onClick={() => save(selected, selected.length === 1 ? selected[0].name : `${selected[0].name.split(",")[0]} + ${selected.length - 1} more`, { source: "search" })}><Check size={18} /> Log {Math.round(selectedTotals.calories)} kcal</button>}
          </div>}

          {!analysis && mode === "mine" && <div className="search-flow">
            <div className="search-box"><Search /><input autoFocus placeholder="Search your foods…" value={myQuery} onChange={(e) => setMyQuery(e.target.value)} /></div>
            {selected.length > 0 && <div className="selected-foods"><div className="review-title"><h3>Your plate</h3><strong>{Math.round(selectedTotals.calories)} kcal</strong></div>{selected.map((item, index) => <div className="selected-row" key={`${item.name}-${index}`}><span>{item.emoji}</span><div><strong>{item.name}</strong><small>{Math.round(item.calories)} kcal · P {item.protein.toFixed(1)} · C {item.carbs.toFixed(1)} · F {item.fat.toFixed(1)} · Fib {(item.fiber ?? 0).toFixed(1)}</small></div><label><input type="number" value={Math.round(item.grams)} onChange={(e) => updateSelectedGrams(index, +e.target.value)} /><span>g</span></label><button onClick={() => setSelected(selected.filter((_, i) => i !== index))}><X size={16} /></button></div>)}</div>}
            <div className="food-results"><p className="eyebrow">{myQuery ? "MATCHES" : `YOUR FOOD RECORD · ${myFoods.length}`}</p>
              {myFoods.map((entry) => <button className="food-result logged-food" key={entry.name} onClick={() => addLoggedFood(entry)}>
                <span className="food-emoji">🍽️</span>
                <div><strong>{entry.name}</strong><p>P {entry.protein.toFixed(1)} · C {entry.carbs.toFixed(1)} · F {entry.fat.toFixed(1)} · Fib {(entry.fiber ?? 0).toFixed(1)}</p><small>{entry.grams > 0 ? `${Math.round(entry.grams)} g · ` : ""}logged {entry.timesUsed}×{entry.timesUsed > 1 ? ` · since ${new Date(entry.firstLoggedAt).toLocaleDateString()}` : ` · ${new Date(entry.lastLoggedAt).toLocaleDateString()}`}</small></div>
                <div><strong>{Math.round(entry.calories)}</strong><span>kcal</span></div><Plus size={18} />
              </button>)}
              {!myFoods.length && <div className="empty-memory"><BookMarked /><strong>{myQuery ? "Nothing matches that" : "No foods recorded yet"}</strong><p>{myQuery ? "Try a shorter search." : "Every food you log is kept here so you can repeat it later."}</p></div>}
            </div>
            {error && <div className="error-banner">{error}</div>}
            {selected.length > 0 && <button className="primary wide sticky-save" disabled={loading} onClick={() => save(selected, selected.length === 1 ? selected[0].name : `${selected[0].name.split(",")[0]} + ${selected.length - 1} more`, { source: "repeat" })}><Check size={18} /> Log {Math.round(selectedTotals.calories)} kcal</button>}
          </div>}

          {!analysis && mode === "quick" && <div className="quick-flow">
            <div className="quick-icon"><Utensils /></div><h2>Already know the numbers?</h2><p className="muted">Add totals directly without searching for individual foods.</p>
            {quickAdds.length > 0 && <div className="quick-recents">
              <div className="review-title"><h3><History size={16} /> Add again</h3><span>Anything you have logged before</span></div>
              <div className="quick-recent-list">{quickAdds.map((entry) => <button type="button" key={entry.name} className={quick.title === entry.name ? "active" : ""} onClick={() => setQuick({ title: entry.name, calories: entry.calories, protein: entry.protein, carbs: entry.carbs, fiber: entry.fiber ?? 0, fat: entry.fat })}>
                <div><strong>{entry.name}</strong><small>{entry.grams > 0 ? `${Math.round(entry.grams)} g · ` : ""}P {Math.round(entry.protein)} · C {Math.round(entry.carbs)} · F {Math.round(entry.fat)} · Fib {Math.round(entry.fiber ?? 0)}</small></div>
                <div className="quick-recent-meta"><strong>{Math.round(entry.calories)}</strong><small>kcal{entry.timesUsed > 1 ? ` · ×${entry.timesUsed}` : ""}</small></div>
              </button>)}</div>
            </div>}
            <label className="field"><span>Meal name</span><input placeholder="Post-workout shake" value={quick.title} onChange={(e) => setQuick({ ...quick, title: e.target.value })} /></label>
            <div className="form-grid two quick-nutrients">{(["calories", "protein", "carbs", "fat", "fiber"] as const).map((key) => <label className="field" key={key}><span>{key[0].toUpperCase() + key.slice(1)} {key !== "calories" && "(g)"}</span><input type="number" min="0" value={quick[key] || ""} placeholder="0" onChange={(e) => setQuick({ ...quick, [key]: +e.target.value })} /></label>)}</div>
            {error && <div className="error-banner">{error}</div>}
            <button className="primary wide" disabled={loading || !quick.title || !quick.calories} onClick={() => save([{ name: quick.title, grams: 0, ...quick }], quick.title, { source: "quick" })}><Check size={18} /> Add to diary</button>
          </div>}
        </div>
      </div>
    </div>
  );
}

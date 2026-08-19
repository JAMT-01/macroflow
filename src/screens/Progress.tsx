import { useEffect, useMemo, useState } from "react";
import { ArrowDownRight, CalendarDays, Check, Flame, Scale, TrendingUp } from "lucide-react";
import { api } from "../api";
import type { History, Settings } from "../types";
import { ProgressPhotos } from "../components/ProgressPhotos";

function addDays(date: string, amount: number) { const next = new Date(`${date}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + amount); return next.toISOString().slice(0, 10); }

export function Progress({ settings, refresh, onSettings }: { settings: Settings; refresh: number; onSettings: (settings: Settings) => void }) {
  const [history, setHistory] = useState<History | null>(null);
  const [weight, setWeight] = useState(settings.weightKg);
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.history(30).then(setHistory); }, [refresh]);

  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => addDays(settings.today, i - 13)).map((date) => history?.nutrition.find((day) => day.date === date) ?? { date, calories: 0, protein: 0, carbs: 0, fat: 0, meals: 0 }), [history, settings.today]);
  const logged = days.filter((day) => day.meals > 0);
  const averages = logged.length ? logged.reduce((sum, day) => ({ calories: sum.calories + day.calories, protein: sum.protein + day.protein, carbs: sum.carbs + day.carbs, fat: sum.fat + day.fat }), { calories: 0, protein: 0, carbs: 0, fat: 0 }) : { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const streak = (() => { let count = 0; for (let index = days.length - 1; index >= 0; index--) { if (days[index].meals > 0) count++; else if (days[index].date !== settings.today) break; } return count; })();
  const maxCalories = Math.max(settings.calorieTarget * 1.2, ...days.map((day) => day.calories));
  const latestWeight = history?.weights.at(-1)?.weightKg ?? settings.weightKg;
  const firstWeight = history?.weights.at(0)?.weightKg ?? latestWeight;

  async function addWeight() {
    setSaving(true);
    try {
      await api.addWeight(weight);
      const [nextHistory, nextSettings] = await Promise.all([api.history(30), api.settings()]);
      setHistory(nextHistory); onSettings(nextSettings);
    } finally { setSaving(false); }
  }

  if (!history) return <div className="page-loading"><div className="skeleton heading" /><div className="skeleton hero" /></div>;
  return (
    <div className="page progress-page">
      <header className="page-header"><div><p className="eyebrow">LAST 30 DAYS</p><h1>Your progress</h1><p className="page-subtitle">Look for patterns, not perfect days.</p></div><div className="streak-pill"><Flame size={18} /> <strong>{streak}</strong> day streak</div></header>

      <div className="stat-grid">
        <div className="stat-card"><span className="stat-icon green"><CalendarDays /></span><div><p>Days tracked</p><strong>{logged.length}<small> / 14</small></strong><span>{Math.round(logged.length / 14 * 100)}% consistency</span></div></div>
        <div className="stat-card"><span className="stat-icon coral"><TrendingUp /></span><div><p>Daily average</p><strong>{logged.length ? Math.round(averages.calories / logged.length).toLocaleString() : 0}<small> kcal</small></strong><span>{Math.abs(Math.round((logged.length ? averages.calories / logged.length : 0) - settings.calorieTarget))} from target</span></div></div>
        <div className="stat-card"><span className="stat-icon blue"><Check /></span><div><p>Protein average</p><strong>{logged.length ? Math.round(averages.protein / logged.length) : 0}<small> g</small></strong><span>{settings.proteinTarget}g daily target</span></div></div>
        <div className="stat-card"><span className="stat-icon purple"><Scale /></span><div><p>Current weight</p><strong>{latestWeight.toFixed(1)}<small> kg</small></strong><span className={latestWeight <= firstWeight ? "positive" : ""}><ArrowDownRight size={14} /> {Math.abs(latestWeight - firstWeight).toFixed(1)} kg overall</span></div></div>
      </div>

      <section className="chart-card">
        <div className="chart-header"><div><p className="eyebrow">ENERGY</p><h2>Calories over time</h2></div><div className="legend"><span><i className="actual" /> Consumed</span><span><i className="target" /> Target</span></div></div>
        <div className="bar-chart"><div className="target-line" style={{ bottom: `${settings.calorieTarget / maxCalories * 100}%` }}><span>{settings.calorieTarget}</span></div>{days.map((day) => <div className="bar-column" key={day.date}><div className={`bar ${day.meals ? "filled" : ""}`} style={{ height: `${Math.max(day.meals ? 3 : 1, day.calories / maxCalories * 100)}%` }} title={`${day.date}: ${Math.round(day.calories)} kcal`}><span>{day.meals ? Math.round(day.calories) : ""}</span></div><small>{new Intl.DateTimeFormat("en", { weekday: "narrow", timeZone: "UTC" }).format(new Date(`${day.date}T12:00:00Z`))}</small></div>)}</div>
      </section>

      <div className="progress-lower">
        <section className="chart-card macro-average"><div className="chart-header"><div><p className="eyebrow">AVERAGES</p><h2>Macro balance</h2></div></div>{[
          { label: "Protein", value: logged.length ? averages.protein / logged.length : 0, target: settings.proteinTarget, color: "coral" },
          { label: "Carbohydrates", value: logged.length ? averages.carbs / logged.length : 0, target: settings.carbsTarget, color: "blue" },
          { label: "Fat", value: logged.length ? averages.fat / logged.length : 0, target: settings.fatTarget, color: "purple" }
        ].map((macro) => <div className="average-row" key={macro.label}><div><span>{macro.label}</span><strong>{Math.round(macro.value)}g <small>/ {macro.target}g</small></strong></div><div className="average-track"><span className={macro.color} style={{ width: `${Math.min(100, macro.value / macro.target * 100)}%` }} /></div></div>)}</section>
        <section className="weight-card"><div><p className="eyebrow">WEIGHT CHECK-IN</p><h2>Log today's weight</h2><p>One data point is noise. A trend is useful.</p></div><div className="weight-input"><input type="number" step="0.1" value={weight} onChange={(e) => setWeight(+e.target.value)} /><span>kg</span></div><button className="primary wide" disabled={saving || weight < 20} onClick={addWeight}>{saving ? "Saving…" : "Save check-in"}</button>{history.weights.length > 0 && <div className="weight-history">{history.weights.slice(-4).reverse().map((entry) => <span key={entry.id}><small>{new Date(entry.recordedAt).toLocaleDateString([], { month: "short", day: "numeric" })}</small><strong>{entry.weightKg.toFixed(1)} kg</strong></span>)}</div>}</section>
      </div>

      <ProgressPhotos suggestedWeight={latestWeight} />
    </div>
  );
}

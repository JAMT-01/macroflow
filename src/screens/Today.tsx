import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, Plus, Trash2 } from "lucide-react";
import { api, sumItems } from "../api";
import type { Dashboard, Meal, MealTypeChoice } from "../types";
import { mealTypeMeta } from "../mealTypes";
import { MacroRing } from "../components/MacroRing";

function addDays(date: string, amount: number) {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + amount);
  return next.toISOString().slice(0, 10);
}

function niceDate(date: string, today: string) {
  if (date === today) return "Today";
  return new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

export function Today({ date, setDate, openLog, refresh, onChanged }: { date: string; setDate: (date: string) => void; openLog: (type?: MealTypeChoice) => void; refresh: number; onChanged: () => void }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setDashboard(null); api.dashboard(date).then(setDashboard); }, [date, refresh]);
  const week = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(date, index - 3)), [date]);

  // One chronological list reads as a day. Grouping by category meant five
  // containers on screen whatever the day held, so an empty morning cost as
  // much room as a logged one; the category rides on the row as a label now.
  const meals = useMemo(
    () => (dashboard?.meals ?? []).slice().sort((a, b) => a.loggedAt.localeCompare(b.loggedAt)),
    [dashboard]
  );

  async function removeMeal(meal: Meal) {
    if (!confirm(`Delete ${meal.title}?`)) return;
    setBusy(true);
    try { await api.deleteMeal(meal.id); onChanged(); } finally { setBusy(false); }
  }

  async function repeatMeal(meal: Meal) {
    setBusy(true);
    try { await api.repeatMeal(meal.id); setDate(dashboard?.settings.today ?? date); onChanged(); } finally { setBusy(false); }
  }

  if (!dashboard) return <div className="page-loading"><div className="skeleton heading" /><div className="skeleton hero" /><div className="skeleton rows" /></div>;
  const settings = dashboard.settings;
  const caloriesLeft = Math.round(settings.calorieTarget - dashboard.totals.calories);
  const calorieRatio = Math.min(1, dashboard.totals.calories / settings.calorieTarget);

  return (
    <div className="page today-page">
      <header className="page-header">
        <div><p className="eyebrow">{niceDate(date, settings.today)} · {settings.localTime}</p><h1>{date === settings.today ? `Good ${settings.greeting}, ${settings.name}` : "Your food diary"}</h1></div>
        <button className="avatar" aria-label="Profile">{settings.name.slice(0, 1).toUpperCase()}</button>
      </header>

      <div className="week-picker">
        <button className="week-arrow" onClick={() => setDate(addDays(date, -7))}><ChevronLeft size={18} /></button>
        {week.map((day) => {
          return <button key={day} className={day === date ? "active" : ""} onClick={() => setDate(day)}><span>{new Intl.DateTimeFormat("en", { weekday: "narrow", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`))}</span><strong>{Number(day.slice(-2))}</strong>{day === settings.today && <i />}</button>;
        })}
        <button className="week-arrow" onClick={() => setDate(addDays(date, 7))}><ChevronRight size={18} /></button>
      </div>

      <section className="nutrition-overview">
        <div className="calorie-card">
          <div className="calorie-copy"><strong>{Math.abs(caloriesLeft).toLocaleString()}</strong><h2>{caloriesLeft >= 0 ? "Calories left" : "Calories over"}</h2><p>{Math.round(dashboard.totals.calories).toLocaleString()} of {settings.calorieTarget.toLocaleString()} kcal</p></div>
          <div className="calorie-ring" style={{ "--progress": `${calorieRatio * 360}deg` } as React.CSSProperties}><div><small>{Math.round(calorieRatio * 100)}%</small></div></div>
        </div>
        <div className="macro-grid">
          {[
            { label: "Protein", value: dashboard.totals.protein, target: settings.proteinTarget, color: "var(--accent)", className: "protein" },
            { label: "Carbs", value: dashboard.totals.carbs, target: settings.carbsTarget, color: "var(--gold)", className: "carbs" },
            { label: "Fat", value: dashboard.totals.fat, target: settings.fatTarget, color: "var(--blue)", className: "fat" },
            { label: "Fiber", value: dashboard.totals.fiber, target: settings.fiberTarget, color: "var(--sage)", className: "fiber" }
          ].map((macro) => <div className={`macro-card ${macro.className}`} key={macro.label}><MacroRing value={macro.value} target={macro.target} color={macro.color} size={54} stroke={6} /><div><span>{macro.label}</span><strong>{Math.round(macro.value)}<small> / {macro.target}g</small></strong></div></div>)}
        </div>
      </section>

      <section className="diary-section">
        <div className="section-title"><h2>Meals</h2><span>{meals.length ? `${meals.length} logged` : ""}</span></div>
        {meals.length ? (
          <div className="meal-list">
            {meals.map((meal) => {
              const total = sumItems(meal.items);
              const meta = mealTypeMeta[meal.mealType];
              return <div className="meal-row" key={meal.id}>
                {meal.imagePath ? <img src={meal.imagePath} alt="" /> : <div className="meal-placeholder">{meta.emoji}</div>}
                <div className="meal-info">
                  <strong>{meal.title} <em className="meal-tag">{meal.mealType.toLowerCase()}</em></strong>
                  <p>{meal.items.map((item) => item.name.split(",")[0]).join(" · ")}</p>
                  <span>{new Date(meal.loggedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: settings.timezone })}{meal.source === "openrouter" && " · AI estimate"}</span>
                </div>
                <div className="meal-macros"><strong>{Math.round(total.calories)}</strong><span>kcal</span></div>
                <div className="row-actions"><button title="Log again" disabled={busy} onClick={() => repeatMeal(meal)}><Copy size={16} /></button><button title="Delete" disabled={busy} onClick={() => removeMeal(meal)}><Trash2 size={16} /></button></div>
              </div>;
            })}
            <button className="meal-add" onClick={() => openLog()}><Plus size={17} /> Add a meal</button>
          </div>
        ) : (
          <button className="meal-empty" onClick={() => openLog()}><Plus size={18} /> Nothing logged yet — add your first meal</button>
        )}
      </section>
    </div>
  );
}

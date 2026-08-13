import { useEffect, useMemo, useState } from "react";
import { Camera, ChevronLeft, ChevronRight, Copy, Plus, Sparkles, Trash2 } from "lucide-react";
import { api, sumItems } from "../api";
import type { Dashboard, Meal, MealTypeChoice } from "../types";
import { mealTypeMeta, mealTypes } from "../mealTypes";
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
        <div><p className="eyebrow">{niceDate(date, settings.today)} · {settings.localTime} {settings.timezone}</p><h1>{date === settings.today ? `Good ${settings.greeting}, ${settings.name}` : "Your food diary"}</h1></div>
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
          <div className="calorie-copy"><span className="card-kicker">DAILY ENERGY</span><strong>{Math.abs(caloriesLeft).toLocaleString()}</strong><h2>{caloriesLeft >= 0 ? "Calories left" : "Calories over"}</h2><p>{Math.round(dashboard.totals.calories).toLocaleString()} of {settings.calorieTarget.toLocaleString()} kcal</p></div>
          <div className="calorie-ring" style={{ "--progress": `${calorieRatio * 360}deg` } as React.CSSProperties}><div><Sparkles size={20} /><small>{Math.round(calorieRatio * 100)}%</small></div></div>
        </div>
        <div className="macro-grid">
          {[
            { label: "Protein", value: dashboard.totals.protein, target: settings.proteinTarget, color: "#f26d5b", className: "protein" },
            { label: "Carbs", value: dashboard.totals.carbs, target: settings.carbsTarget, color: "#5c8df6", className: "carbs" },
            { label: "Fat", value: dashboard.totals.fat, target: settings.fatTarget, color: "#9c6ade", className: "fat" }
          ].map((macro) => <div className={`macro-card ${macro.className}`} key={macro.label}><MacroRing value={macro.value} target={macro.target} color={macro.color} size={54} stroke={6} /><div><span>{macro.label}</span><strong>{Math.round(macro.value)}<small> / {macro.target}g</small></strong><p>{Math.max(0, Math.round(macro.target - macro.value))}g left</p></div></div>)}
        </div>
      </section>

      <button className="scan-hero" onClick={() => openLog()}>
        <span className="scan-icon"><Camera /></span>
        <span><small>PHOTO → MEMORY → CONFIRM</small><strong>Snap or describe your meal</strong><em>Vision estimates it and files it as desayuno, almuerzo, merienda, cena or antojo</em></span>
        <span className="scan-arrow"><ChevronRight /></span>
      </button>

      <section className="diary-section">
        <div className="section-title"><div><p className="eyebrow">YOUR DIARY</p><h2>Meals</h2></div><span>{dashboard.meals.length} logged</span></div>
        <div className="meal-groups">
          {mealTypes.map((type) => {
            const meals = dashboard.meals.filter((meal) => meal.mealType === type);
            const totals = sumItems(meals.flatMap((meal) => meal.items));
            return (
              <article className="meal-group" key={type}>
                <header><div className="meal-label"><span>{mealTypeMeta[type].emoji}</span><div><h3>{type} <em>{mealTypeMeta[type].hint}</em></h3><p>{meals.length ? `${Math.round(totals.calories)} kcal · ${Math.round(totals.protein)}g protein` : "Nothing logged yet"}</p></div></div><button className="icon-button add" onClick={() => openLog(type)}><Plus size={19} /></button></header>
                {meals.map((meal) => {
                  const total = sumItems(meal.items);
                  return <div className="meal-row" key={meal.id}>
                    {meal.imagePath ? <img src={meal.imagePath} alt="" /> : <div className="meal-placeholder">{mealTypeMeta[type].emoji}</div>}
                    <div className="meal-info"><strong>{meal.title}</strong><p>{meal.items.map((item) => item.name.split(",")[0]).join(" · ")}</p><span>{new Date(meal.loggedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: settings.timezone })}{meal.source === "openrouter" && " · AI estimate"}</span></div>
                    <div className="meal-macros"><strong>{Math.round(total.calories)}</strong><span>kcal</span></div>
                    <div className="row-actions"><button title="Log again" disabled={busy} onClick={() => repeatMeal(meal)}><Copy size={16} /></button><button title="Delete" disabled={busy} onClick={() => removeMeal(meal)}><Trash2 size={16} /></button></div>
                  </div>;
                })}
                {!meals.length && <button className="empty-meal" onClick={() => openLog(type)}><Plus size={17} /> Add {type.toLowerCase()}</button>}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

import { useMemo, useState } from "react";
import { ArrowRight, Check, ShieldCheck, Sparkles } from "lucide-react";
import { api } from "../api";
import type { Settings } from "../types";

type Form = { name: string; age: number; sex: string; weightKg: number; heightCm: number; activity: string; goal: string };

export function Onboarding({ initial, onComplete }: { initial: Settings; onComplete: (settings: Settings) => void }) {
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Form>({
    name: initial.name === "You" ? "" : initial.name,
    age: initial.age,
    sex: initial.sex,
    weightKg: initial.weightKg,
    heightCm: initial.heightCm,
    activity: initial.activity,
    goal: initial.goal
  });
  const targets = useMemo(() => {
    const base = 10 * form.weightKg + 6.25 * form.heightCm - 5 * form.age + (form.sex === "male" ? 5 : -161);
    const multiplier: Record<string, number> = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725 };
    const adjustment: Record<string, number> = { lose: -350, maintain: 0, gain: 300 };
    const calories = Math.round((base * (multiplier[form.activity] || 1.55) + (adjustment[form.goal] || 0)) / 10) * 10;
    const protein = Math.round(form.weightKg * (form.goal === "gain" ? 2 : 1.8));
    const fat = Math.round(form.weightKg * 0.8);
    const carbs = Math.max(80, Math.round((calories - protein * 4 - fat * 9) / 4));
    return { calories, protein, fat, carbs };
  }, [form]);

  async function finish() {
    setSaving(true);
    try {
      const settings = await api.updateSettings({
        ...form,
        onboardingComplete: true,
        calorieTarget: targets.calories,
        proteinTarget: targets.protein,
        carbsTarget: targets.carbs,
        fatTarget: targets.fat
      });
      await api.addWeight(form.weightKg);
      onComplete(settings);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="onboarding">
      <div className="onboarding-art">
        <div className="orb orb-one" /><div className="orb orb-two" />
        <div className="onboarding-brand"><span><Sparkles /></span> Macroflow</div>
        <div className="art-copy">
          <p className="eyebrow">PRIVATE BY DEFAULT</p>
          <h1>Nutrition tracking,<br /><em>without the friction.</em></h1>
          <p>Your meals and history live on your server. AI only helps you log faster.</p>
          <div className="trust-list"><span><Check /> Local SQLite database</span><span><Check /> Editable estimates</span><span><Check /> No subscriptions</span></div>
        </div>
      </div>
      <div className="onboarding-panel">
        <div className="step-dots">{[0, 1, 2].map((item) => <span key={item} className={step >= item ? "active" : ""} />)}</div>
        {step === 0 && (
          <div className="onboarding-step">
            <div className="step-icon"><Sparkles /></div>
            <p className="eyebrow">LET'S SET YOU UP</p>
            <h2>What should we call you?</h2>
            <p className="muted">This is a single-user, local profile. You can change everything later.</p>
            <label className="field"><span>Your name</span><input autoFocus placeholder="Agustin" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
            <button className="primary wide" disabled={!form.name.trim()} onClick={() => setStep(1)}>Continue <ArrowRight size={18} /></button>
          </div>
        )}
        {step === 1 && (
          <div className="onboarding-step">
            <p className="eyebrow">YOUR BASELINE</p><h2>A few useful details</h2><p className="muted">Used only to suggest a starting target—not medical advice.</p>
            <div className="form-grid two">
              <label className="field"><span>Age</span><input type="number" value={form.age} onChange={(e) => setForm({ ...form, age: +e.target.value })} /></label>
              <label className="field"><span>Sex for calculation</span><select value={form.sex} onChange={(e) => setForm({ ...form, sex: e.target.value })}><option value="male">Male</option><option value="female">Female</option></select></label>
              <label className="field"><span>Weight (kg)</span><input type="number" step="0.1" value={form.weightKg} onChange={(e) => setForm({ ...form, weightKg: +e.target.value })} /></label>
              <label className="field"><span>Height (cm)</span><input type="number" value={form.heightCm} onChange={(e) => setForm({ ...form, heightCm: +e.target.value })} /></label>
            </div>
            <label className="field"><span>Typical activity</span><select value={form.activity} onChange={(e) => setForm({ ...form, activity: e.target.value })}><option value="sedentary">Mostly seated</option><option value="light">Light — 1–3 workouts/week</option><option value="moderate">Moderate — 3–5 workouts/week</option><option value="active">Very active — 6+ workouts/week</option></select></label>
            <div className="button-row"><button className="ghost" onClick={() => setStep(0)}>Back</button><button className="primary" onClick={() => setStep(2)}>Continue <ArrowRight size={18} /></button></div>
          </div>
        )}
        {step === 2 && (
          <div className="onboarding-step">
            <p className="eyebrow">YOUR DIRECTION</p><h2>Choose a starting goal</h2>
            <div className="goal-options">
              {[{ id: "lose", title: "Lose weight", note: "A gentle calorie deficit" }, { id: "maintain", title: "Maintain", note: "Support your current weight" }, { id: "gain", title: "Build muscle", note: "A controlled calorie surplus" }].map((goal) => (
                <button key={goal.id} className={form.goal === goal.id ? "selected" : ""} onClick={() => setForm({ ...form, goal: goal.id })}><span>{goal.title}<small>{goal.note}</small></span>{form.goal === goal.id && <Check size={19} />}</button>
              ))}
            </div>
            <div className="target-preview"><div><strong>{targets.calories.toLocaleString()}</strong><span>kcal</span></div><div><strong>{targets.protein}g</strong><span>protein</span></div><div><strong>{targets.carbs}g</strong><span>carbs</span></div><div><strong>{targets.fat}g</strong><span>fat</span></div></div>
            <p className="fine-print"><ShieldCheck size={15} /> This is an editable estimate based on Mifflin–St Jeor.</p>
            <div className="button-row"><button className="ghost" onClick={() => setStep(1)}>Back</button><button className="primary" disabled={saving} onClick={finish}>{saving ? "Creating…" : "Start tracking"} <ArrowRight size={18} /></button></div>
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Bell, Bot, Brain, Check, Database, Download, ExternalLink, KeyRound, Ruler, Save, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../api";
import type { MealMemory, Reminder, Settings } from "../types";

export function SettingsScreen({ settings, onSettings }: { settings: Settings; onSettings: (settings: Settings) => void }) {
  const [goals, setGoals] = useState({ calorieTarget: settings.calorieTarget, proteinTarget: settings.proteinTarget, carbsTarget: settings.carbsTarget, fatTarget: settings.fatTarget, fiberTarget: settings.fiberTarget });
  const [model, setModel] = useState(settings.openrouterModel);
  const [openrouterKey, setOpenrouterKey] = useState("");
  const [plateDiameterCm, setPlateDiameterCm] = useState(settings.plateDiameterCm);
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState(settings.telegramChatId);
  const [timezone, setTimezone] = useState(settings.timezone);
  const [reminders, setReminders] = useState<Reminder[]>(settings.reminders);
  const [memories, setMemories] = useState<MealMemory[]>([]);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.memories().then(setMemories); }, []);

  async function save(data: Record<string, unknown>, message: string) {
    setSaving(true); setStatus("");
    try { const next = await api.updateSettings(data); onSettings(next); setStatus(message); return true; }
    catch (error) { setStatus(error instanceof Error ? error.message : "Could not save"); return false; }
    finally { setSaving(false); }
  }

  async function saveOpenRouter() {
    const data: Record<string, unknown> = { openrouterModel: model, plateDiameterCm };
    if (openrouterKey.trim()) data.openrouterApiKey = openrouterKey.trim();
    if (await save(data, "OpenRouter settings saved")) setOpenrouterKey("");
  }

  async function saveTelegram() {
    const data: Record<string, unknown> = { telegramChatId: chatId, reminders, timezone };
    if (token.trim()) data.telegramBotToken = token.trim();
    await save(data, "Telegram settings saved");
    setToken("");
  }

  async function testTelegram() {
    setStatus("Sending test…");
    try { await api.testTelegram(); setStatus("Test message sent"); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Test failed"); }
  }

  async function removeMemory(id: string) {
    await api.deleteMemory(id);
    setMemories((current) => current.filter((memory) => memory.id !== id));
  }

  return (
    <div className="page settings-page">
      <header className="page-header"><div><p className="eyebrow">PERSONALIZE</p><h1>Settings</h1><p className="page-subtitle">Your data stays on this server.</p></div>{status && <div className="saved-toast"><Check size={16} /> {status}</div>}</header>

      <div className="settings-layout">
        <div className="settings-main">
          <section className="settings-card"><div className="settings-heading"><span className="settings-icon green"><Save /></span><div><h2>Daily targets</h2><p>Adjust the numbers you want to aim for.</p></div></div><div className="form-grid five">{(["calorieTarget", "proteinTarget", "carbsTarget", "fatTarget", "fiberTarget"] as const).map((key) => <label className="field" key={key}><span>{key === "calorieTarget" ? "Calories" : key.replace("Target", "")[0].toUpperCase() + key.replace("Target", "").slice(1)}</span><div className="unit-input"><input type="number" value={goals[key]} onChange={(e) => setGoals({ ...goals, [key]: +e.target.value })} /><em>{key === "calorieTarget" ? "kcal" : "g"}</em></div></label>)}</div><div className="settings-actions"><button className="primary" disabled={saving} onClick={() => save(goals, "Targets updated")}><Save size={17} /> Save targets</button></div></section>

          <section className="settings-card"><div className="settings-heading"><span className="settings-icon purple"><Brain /></span><div><h2>OpenRouter intelligence</h2><p>Vision analysis and chat-based meal correction.</p></div><span className={`status-badge ${settings.openrouterConfigured ? "online" : "offline"}`}><i />{settings.openrouterConfigured ? "Configured" : "Needs API key"}</span></div>
            {!settings.openrouterConfigured && <div className="setup-callout"><KeyRound /><div><strong>Paste your API key once</strong><p>It is stored only in the server database, never returned by the API, and never included in exports.</p><a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">Create OpenRouter key <ExternalLink size={14} /></a></div></div>}
            <div className="form-grid two"><label className="field secret-field"><span>OpenRouter API key <em>server only</em></span><input type="password" autoComplete="off" spellCheck={false} placeholder={settings.openrouterConfigured ? "Key already configured — enter a new one to replace" : "sk-or-v1-…"} value={openrouterKey} onChange={(e) => setOpenrouterKey(e.target.value)} /><small>{settings.openrouterKeySource === "environment" ? "Currently supplied by the server environment." : settings.openrouterKeySource === "saved" ? "Saved privately in this server's database." : "The browser can set it, but can never read it back."}</small></label><label className="field"><span>Vision model</span><input value={model} onChange={(e) => setModel(e.target.value)} disabled={Boolean(import.meta.env.VITE_OPENROUTER_MODEL_LOCKED)} /><small>Best pilot balance: <code>google/gemini-3.6-flash</code></small></label><label className="field"><span>Flat round plate · diameter</span><div className="unit-input"><input type="number" min="15" max="40" step="0.5" value={plateDiameterCm} onChange={(e) => setPlateDiameterCm(+e.target.value)} /><em>cm</em></div><small><Ruler size={12} /> Measure straight across the whole plate, rim to rim. A 25 cm plate is 25 cm across — not 25 × 25. Used only when the entire rim is visible, and you can switch it off per photo when you eat off something else.</small></label></div>
            <div className="settings-actions"><button className="primary" disabled={saving || (!settings.openrouterConfigured && !openrouterKey.trim())} onClick={saveOpenRouter}><Save size={17} /> Save OpenRouter</button></div>
          </section>

          <section className="settings-card"><div className="settings-heading"><span className="settings-icon coral"><Bot /></span><div><h2>Telegram companion</h2><p>Reminders, daily totals and quick text logging.</p></div><span className={`status-badge ${settings.telegramTokenConfigured && settings.telegramChatId ? "online" : "offline"}`}><i />{settings.telegramTokenConfigured ? settings.telegramChatId ? "Connected" : "Awaiting /start" : "Not configured"}</span></div>
            <div className="telegram-steps"><span><b>1</b>Create a bot with @BotFather</span><span><b>2</b>Paste its token below</span><span><b>3</b>Send your bot <code>/start</code></span></div>
            <div className="form-grid two"><label className="field"><span>Bot token</span><input type="password" placeholder={settings.telegramTokenConfigured ? "Token already saved — enter to replace" : "123456:ABC…"} value={token} onChange={(e) => setToken(e.target.value)} /></label><label className="field"><span>Chat ID <em>auto-filled after /start</em></span><input placeholder="Send /start, then refresh" value={chatId} onChange={(e) => setChatId(e.target.value)} /></label></div>
            <label className="field"><span>Diary timezone</span><input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/Buenos_Aires" /><small>This defines “today” for the diary, averages, Telegram, and midnight boundaries.</small></label>
            <div className="reminder-list"><div className="review-title"><h3><Bell size={17} /> Reminder schedule</h3><span>{timezone}</span></div>{reminders.map((reminder, index) => <div className="reminder-row" key={reminder.id}><label className="switch"><input type="checkbox" checked={reminder.enabled} onChange={(e) => setReminders(reminders.map((item, i) => i === index ? { ...item, enabled: e.target.checked } : item))} /><span /></label><strong>{reminder.label}</strong><input type="time" value={reminder.time} onChange={(e) => setReminders(reminders.map((item, i) => i === index ? { ...item, time: e.target.value } : item))} /></div>)}</div>
            <div className="settings-actions"><button className="primary" disabled={saving} onClick={saveTelegram}><Save size={17} /> Save Telegram</button><button className="secondary" disabled={!settings.telegramTokenConfigured} onClick={testTelegram}>Send test</button></div>
          </section>

          <section className="settings-card"><div className="settings-heading"><span className="settings-icon blue"><Brain /></span><div><h2>Personal meal memory</h2><p>Facts learned from your correction chats and reused on similar meals.</p></div><span className="count-badge">{memories.length}</span></div>
            {memories.length ? <div className="memory-list">{memories.map((memory) => <div className="memory-row" key={memory.id}><span><Brain size={17} /></span><div><strong>{memory.subject}</strong><p>{memory.note}</p><small>Used {memory.timesUsed} times · Updated {new Date(memory.updatedAt).toLocaleDateString()}</small></div><button title="Forget this" onClick={() => removeMemory(memory.id)}><Trash2 size={17} /></button></div>)}</div> : <div className="empty-memory"><Brain /><strong>Nothing learned yet</strong><p>Correct an AI meal estimate and tell it what it should remember.</p></div>}
          </section>
        </div>

        <aside className="settings-side"><section className="privacy-card"><ShieldCheck /><h3>Local-first by design</h3><p>Meals, targets, weight, memories and Telegram settings live in your local SQLite database.</p><ul><li>Images stay in <code>data/uploads</code></li><li>Only analysis requests go to OpenRouter</li><li>API keys remain server-side</li></ul></section><section className="export-card"><Database /><h3>Your data is yours</h3><p>Download a complete JSON copy at any time.</p><a className="secondary wide" href="/api/export" download><Download size={17} /> Export all data</a></section></aside>
      </div>
    </div>
  );
}

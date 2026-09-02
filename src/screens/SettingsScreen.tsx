import { useEffect, useState } from "react";
import { Bell, Bot, Brain, Check, Database, Download, ExternalLink, KeyRound, LogOut, Ruler, Save, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../api";
import type { MealMemory, Reminder, Settings, TelegramStatus } from "../types";

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
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null);
  const [registering, setRegistering] = useState(false);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.memories().then(setMemories); }, []);
  // Only worth asking Telegram about once a token exists; the call goes out to
  // their API and would just error otherwise.
  useEffect(() => { if (settings.telegramTokenConfigured) refreshTelegram(); }, [settings.telegramTokenConfigured]);

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

  const refreshTelegram = () => api.telegramStatus().then(setTelegram).catch(() => setTelegram(null));

  /*
   * "Connected" used to mean nothing more than a saved token and chat id, which
   * is how this deployment sat with a dead webhook for weeks. Delivery is what
   * decides it now: the secret has to exist, and Telegram has to be pointing at
   * this app without a standing error.
   */
  const telegramHealthy = Boolean(
    settings.telegramTokenConfigured && settings.telegramChatId &&
    telegram?.secretConfigured && telegram.webhook?.url === telegram.expectedUrl && !telegram.webhook?.lastError
  );
  const telegramLabel = !settings.telegramTokenConfigured ? "Not configured"
    : !settings.telegramChatId ? "Awaiting /start"
    : !telegram ? "Checking…"
    : !telegram.secretConfigured ? "Webhook secret missing"
    : telegram.webhook?.url !== telegram.expectedUrl ? "Webhook not registered"
    : telegram.webhook?.lastError ? "Delivery failing"
    : "Connected";

  async function registerWebhook() {
    setRegistering(true);
    try {
      await api.registerTelegramWebhook();
      setStatus("Webhook registered");
      await refreshTelegram();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not register the webhook");
    } finally { setRegistering(false); }
  }

  async function removeMemory(id: string) {
    await api.deleteMemory(id);
    setMemories((current) => current.filter((memory) => memory.id !== id));
  }

  return (
    <div className="page settings-page">
      <header className="page-header"><div><h1>Settings</h1><p className="page-subtitle">Your data stays in your own Cloudflare account.</p></div>{status && <div className="saved-toast"><Check size={16} /> {status}</div>}</header>

      <div className="settings-layout">
        <div className="settings-main">
          <section className="settings-card"><div className="settings-heading"><span className="settings-icon green"><Save /></span><div><h2>Daily targets</h2><p>Adjust the numbers you want to aim for.</p></div></div><div className="form-grid five">{(["calorieTarget", "proteinTarget", "carbsTarget", "fatTarget", "fiberTarget"] as const).map((key) => <label className="field" key={key}><span>{key === "calorieTarget" ? "Calories" : key.replace("Target", "")[0].toUpperCase() + key.replace("Target", "").slice(1)}</span><div className="unit-input"><input type="number" value={goals[key]} onChange={(e) => setGoals({ ...goals, [key]: +e.target.value })} /><em>{key === "calorieTarget" ? "kcal" : "g"}</em></div></label>)}</div><div className="settings-actions"><button className="primary" disabled={saving} onClick={() => save(goals, "Targets updated")}><Save size={17} /> Save targets</button></div></section>

          <section className="settings-card"><div className="settings-heading"><span className="settings-icon purple"><Brain /></span><div><h2>OpenRouter intelligence</h2><p>Vision analysis and chat-based meal correction.</p></div><span className={`status-badge ${settings.openrouterConfigured ? "online" : "offline"}`}><i />{settings.openrouterConfigured ? "Configured" : "Needs API key"}</span></div>
            {!settings.openrouterConfigured && <div className="setup-callout"><KeyRound /><div><strong>Paste your API key once</strong><p>It is stored only in the server database, never returned by the API, and never included in exports.</p><a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">Create OpenRouter key <ExternalLink size={14} /></a></div></div>}
            <div className="form-grid two"><label className="field secret-field"><span>OpenRouter API key <em>server only</em></span><input type="password" autoComplete="off" spellCheck={false} placeholder={settings.openrouterConfigured ? "Key already configured — enter a new one to replace" : "sk-or-v1-…"} value={openrouterKey} onChange={(e) => setOpenrouterKey(e.target.value)} /><small>{settings.openrouterKeySource === "environment" ? "Currently supplied by the server environment." : settings.openrouterKeySource === "saved" ? "Saved privately in this server's database." : "The browser can set it, but can never read it back."}</small></label><label className="field"><span>Vision model</span><input value={model} onChange={(e) => setModel(e.target.value)} disabled={Boolean(import.meta.env.VITE_OPENROUTER_MODEL_LOCKED)} /><small>Best pilot balance: <code>google/gemini-3.6-flash</code></small></label><label className="field"><span>Flat round plate · diameter</span><div className="unit-input"><input type="number" min="15" max="40" step="0.5" value={plateDiameterCm} onChange={(e) => setPlateDiameterCm(+e.target.value)} /><em>cm</em></div><small><Ruler size={12} /> Measure straight across the whole plate, rim to rim. A 25 cm plate is 25 cm across — not 25 × 25. Used only when the entire rim is visible, and you can switch it off per photo when you eat off something else.</small></label></div>
            <div className="settings-actions"><button className="primary" disabled={saving || (!settings.openrouterConfigured && !openrouterKey.trim())} onClick={saveOpenRouter}><Save size={17} /> Save OpenRouter</button></div>
          </section>

          <section className="settings-card"><div className="settings-heading"><span className="settings-icon coral"><Bot /></span><div><h2>Telegram companion</h2><p>Reminders, daily totals and quick text logging.</p></div><span className={`status-badge ${telegramHealthy ? "online" : "offline"}`}><i />{telegramLabel}</span></div>
            <div className="telegram-steps"><span><b>1</b>Create a bot with @BotFather</span><span><b>2</b>Paste its token below</span><span><b>3</b>Send your bot <code>/start</code></span></div>
            <div className="form-grid two"><label className="field"><span>Bot token</span><input type="password" placeholder={settings.telegramTokenConfigured ? "Token already saved — enter to replace" : "123456:ABC…"} value={token} onChange={(e) => setToken(e.target.value)} /></label><label className="field"><span>Chat ID <em>auto-filled after /start</em></span><input placeholder="Send /start, then refresh" value={chatId} onChange={(e) => setChatId(e.target.value)} /></label></div>
            <label className="field"><span>Diary timezone</span><input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/Buenos_Aires" /><small>This defines “today” for the diary, averages, Telegram, and midnight boundaries.</small></label>
            <div className="reminder-list"><div className="review-title"><h3><Bell size={17} /> Reminder schedule</h3><span>{timezone}</span></div>{reminders.map((reminder, index) => <div className="reminder-row" key={reminder.id}><label className="switch"><input type="checkbox" checked={reminder.enabled} onChange={(e) => setReminders(reminders.map((item, i) => i === index ? { ...item, enabled: e.target.checked } : item))} /><span /></label><strong>{reminder.label}</strong><input type="time" value={reminder.time} onChange={(e) => setReminders(reminders.map((item, i) => i === index ? { ...item, time: e.target.value } : item))} /></div>)}</div>
            {settings.telegramTokenConfigured && telegram && (
              <div className={`telegram-health${telegram.secretConfigured && telegram.webhook?.url === telegram.expectedUrl && !telegram.webhook?.lastError ? " ok" : " warn"}`}>
                <ul>
                  <li>
                    <b>Webhook secret</b>
                    {telegram.secretConfigured
                      ? <span>Set</span>
                      : <span>Missing — every update Telegram sends is rejected with a 503. Set <code>TELEGRAM_WEBHOOK_SECRET</code> as a Worker secret.</span>}
                  </li>
                  <li>
                    <b>Registered URL</b>
                    {!telegram.webhook?.url
                      ? <span>Telegram has no webhook for this bot yet.</span>
                      : telegram.webhook.url === telegram.expectedUrl
                        ? <span>Correct</span>
                        : <span>Points at <code>{telegram.webhook.url}</code>, but this app is at <code>{telegram.expectedUrl}</code>. Re-register.</span>}
                  </li>
                  {telegram.webhook?.lastError && (
                    <li><b>Last error</b><span>{telegram.webhook.lastError}{telegram.webhook.lastErrorAt ? ` (${new Date(telegram.webhook.lastErrorAt).toLocaleString()})` : ""}</span></li>
                  )}
                  {Boolean(telegram.webhook?.pendingUpdates) && (
                    <li><b>Queued</b><span>{telegram.webhook?.pendingUpdates} update(s) waiting — Telegram is retrying because delivery is failing.</span></li>
                  )}
                  {telegram.error && <li><b>Telegram API</b><span>{telegram.error}</span></li>}
                </ul>
              </div>
            )}
            <div className="settings-actions"><button className="primary" disabled={saving} onClick={saveTelegram}><Save size={17} /> Save Telegram</button><button className="secondary" disabled={!settings.telegramTokenConfigured || registering} onClick={registerWebhook}>{registering ? "Registering…" : "Register webhook"}</button><button className="secondary" disabled={!settings.telegramTokenConfigured} onClick={testTelegram}>Send test</button></div>
          </section>

          <section className="settings-card"><div className="settings-heading"><span className="settings-icon blue"><Brain /></span><div><h2>Personal meal memory</h2><p>Facts learned from your correction chats and reused on similar meals.</p></div><span className="count-badge">{memories.length}</span></div>
            {memories.length ? <div className="memory-list">{memories.map((memory) => <div className="memory-row" key={memory.id}><span><Brain size={17} /></span><div><strong>{memory.subject}</strong><p>{memory.note}</p><small>Used {memory.timesUsed} times · Updated {new Date(memory.updatedAt).toLocaleDateString()}</small></div><button title="Forget this" onClick={() => removeMemory(memory.id)}><Trash2 size={17} /></button></div>)}</div> : <div className="empty-memory"><Brain /><strong>Nothing learned yet</strong><p>Correct an AI meal estimate and tell it what it should remember.</p></div>}
          </section>
        </div>

        <aside className="settings-side"><section className="privacy-card"><ShieldCheck /><h3>Private by design</h3><p>Meals, targets, weight, memories and Telegram settings live in your own Cloudflare account, behind this passphrase.</p><ul><li>Photos stay in your KV namespace</li><li>Only analysis requests go to OpenRouter</li><li>API keys stay server-side as Worker secrets</li></ul><button className="secondary wide sign-out" onClick={async () => { await api.logout(); location.reload(); }}><LogOut size={16} /> Sign out</button></section><section className="export-card"><Database /><h3>Your data is yours</h3><p>Download a complete JSON copy at any time.</p><a className="secondary wide" href="/api/export" download><Download size={17} /> Export all data</a></section></aside>
      </div>
    </div>
  );
}

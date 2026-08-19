import { BarChart3, Camera, Home, Images, Settings as SettingsIcon, Sparkles } from "lucide-react";

export type Tab = "today" | "progress" | "photos" | "settings";

export function Layout({ tab, setTab, onScan, children }: { tab: Tab; setTab: (tab: Tab) => void; onScan: () => void; children: React.ReactNode }) {
  const nav = [
    { id: "today" as const, label: "Today", icon: Home },
    { id: "progress" as const, label: "Progress", icon: BarChart3 },
    { id: "photos" as const, label: "Photos", icon: Images },
    { id: "settings" as const, label: "Settings", icon: SettingsIcon }
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setTab("today")}>
          <span className="brand-mark"><Sparkles size={19} /></span>
          <span>Macroflow</span>
        </button>
        <nav className="side-nav">
          {nav.map(({ id, label, icon: Icon }) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              <Icon size={20} strokeWidth={2.2} /> {label}
            </button>
          ))}
        </nav>
        <button className="sidebar-scan" onClick={onScan}>
          <span><Camera size={21} /></span>
          <div><strong>Scan a meal</strong><small>Photo or describe</small></div>
        </button>
        <div className="local-pill"><span /> Private local storage</div>
      </aside>
      <main className="main-content">{children}</main>
      <nav className="bottom-nav">
        <button className={tab === "today" ? "active" : ""} onClick={() => setTab("today")}><Home size={21} /><span>Today</span></button>
        <button className={tab === "progress" ? "active" : ""} onClick={() => setTab("progress")}><BarChart3 size={21} /><span>Progress</span></button>
        <button className="scan-fab" onClick={onScan} aria-label="Scan meal"><span className="scan-fab-icon"><Camera size={24} /></span><small>Scan</small></button>
        <button className={tab === "photos" ? "active" : ""} onClick={() => setTab("photos")}><Images size={21} /><span>Photos</span></button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}><SettingsIcon size={21} /><span>Settings</span></button>
      </nav>
    </div>
  );
}

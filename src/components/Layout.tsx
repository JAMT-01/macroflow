import { CarrotMark } from "./CarrotMark";
import { BarChart3, Camera, Home, Images, Plus, Settings as SettingsIcon } from "lucide-react";

export type Tab = "today" | "progress" | "photos" | "settings";

const nav = [
  { id: "today" as const, label: "Today", icon: Home },
  { id: "progress" as const, label: "Progress", icon: BarChart3 },
  { id: "photos" as const, label: "Photos", icon: Images },
  { id: "settings" as const, label: "Settings", icon: SettingsIcon }
];

export function Layout({ tab, setTab, onScan, children }: { tab: Tab; setTab: (tab: Tab) => void; onScan: () => void; children: React.ReactNode }) {
  // The pill behind the active tab slides between cells, so the bar needs to know
  // which cell is lit. One custom property is cheaper than measuring the DOM.
  const activeIndex = Math.max(0, nav.findIndex((item) => item.id === tab));
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setTab("today")}>
          <span className="brand-mark"><CarrotMark height={23} /></span>
          <span>Jamtytrack</span>
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
      {/* Floating bar: the four destinations ride in one glass pill, and capture
          sits outside it as its own button — the action is not a destination. */}
      <div className="mobile-bar">
        <nav className="bottom-nav" style={{ ["--nav-index" as string]: activeIndex }}>
          <span className="nav-pill" aria-hidden="true" />
          {nav.map(({ id, label, icon: Icon }) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              <Icon size={21} strokeWidth={tab === id ? 2.3 : 1.9} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <button className="scan-fab" onClick={onScan} aria-label="Log a meal"><Plus size={27} strokeWidth={2.6} /></button>
      </div>
    </div>
  );
}

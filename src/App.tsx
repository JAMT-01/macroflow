import { useEffect, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { api } from "./api";
import type { MealTypeChoice, Settings } from "./types";
import { Layout, type Tab } from "./components/Layout";
import { Onboarding } from "./screens/Onboarding";
import { Today } from "./screens/Today";
import { Progress } from "./screens/Progress";
import { Photos } from "./screens/Photos";
import { SettingsScreen } from "./screens/SettingsScreen";
import { LogModal } from "./components/LogModal";

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadingError, setLoadingError] = useState("");
  const [tab, setTab] = useState<Tab>("today");
  const [selectedDate, setSelectedDate] = useState("");
  const [logState, setLogState] = useState<{ open: boolean; mealType: MealTypeChoice }>({ open: false, mealType: "Auto" });
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    api.settings().then((next) => { setSettings(next); setSelectedDate(next.today); }).catch((error: Error) => setLoadingError(error.message));
  }, []);

  if (loadingError) return (
    <div className="fatal-state"><div className="brand-mark">!</div><h1>Jamtytrack server is offline</h1><p>{loadingError}</p><button className="primary" onClick={() => location.reload()}><RefreshCw size={17} /> Try again</button></div>
  );
  if (!settings) return <div className="loading-screen"><LoaderCircle className="spin" /><span>Opening your diary…</span></div>;
  if (!settings.onboardingComplete) return <Onboarding initial={settings} onComplete={setSettings} />;

  const openLog = (mealType: MealTypeChoice = "Auto") => setLogState({ open: true, mealType });
  const changed = () => setRefresh((value) => value + 1);
  const navigate = (nextTab: Tab) => { if (nextTab === "today") setSelectedDate(settings.today); setTab(nextTab); };

  return (
    <Layout tab={tab} setTab={navigate} onScan={() => openLog()}>
      {tab === "today" && <Today date={selectedDate} setDate={setSelectedDate} openLog={openLog} refresh={refresh} onChanged={changed} />}
      {tab === "progress" && <Progress settings={settings} refresh={refresh} onSettings={setSettings} />}
      {tab === "photos" && <Photos settings={settings} />}
      {tab === "settings" && <SettingsScreen settings={settings} onSettings={setSettings} />}
      {logState.open && <LogModal defaultMealType={logState.mealType} date={selectedDate} settings={settings} onClose={() => setLogState({ ...logState, open: false })} onSaved={() => { changed(); setLogState({ ...logState, open: false }); }} />}
    </Layout>
  );
}

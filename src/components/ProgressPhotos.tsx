import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Images, Lock, LoaderCircle, Trash2 } from "lucide-react";
import { api } from "../api";
import { PhotoLock } from "./PhotoLock";
import { prepareProgressPhoto } from "../imageCapture";
import type { ProgressPhoto, ProgressPose } from "../types";

const POSES: ProgressPose[] = ["front", "side", "back"];
const POSE_LABEL: Record<ProgressPose, string> = { front: "Front", side: "Side", back: "Back" };

function niceDate(takenDate: string) {
  const [year, month, day] = takenDate.split("-").map(Number);
  return new Intl.DateTimeFormat([], { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day, 12)));
}

export function ProgressPhotos({ suggestedWeight }: { suggestedWeight: number }) {
  const [unlockMinutes, setUnlockMinutes] = useState(15);
  const [separateSecret, setSeparateSecret] = useState(false);
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [photos, setPhotos] = useState<ProgressPhoto[] | null>(null);
  const [pose, setPose] = useState<ProgressPose>("front");
  const [comparePose, setComparePose] = useState<ProgressPose>("front");
  const [view, setView] = useState<"timeline" | "compare">("timeline");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Two inputs rather than one: iOS treats `capture` as "camera only", so a
  // single control cannot offer both. Desktop ignores `capture` and shows a file
  // picker for either button, which is the sensible behaviour there anyway.
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);

  useEffect(() => { api.progressState().then((state) => { setUnlocked(state.unlocked); setUnlockMinutes(state.unlockMinutes); setSeparateSecret(state.separateSecret); }).catch(() => setUnlocked(false)); }, []);
  useEffect(() => {
    if (!unlocked) { setPhotos(null); return; }
    api.progressPhotos().then(setPhotos).catch(() => setPhotos([]));
  }, [unlocked]);

  async function unlock(code: string) {
    setUnlocking(true); setError("");
    try {
      await api.unlockPhotos(code);
      setUnlocked(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unlock");
    } finally { setUnlocking(false); }
  }

  async function lock() {
    await api.lockPhotos().catch(() => undefined);
    setPhotos(null);
    setUnlocked(false);
  }

  // The unlock expires server-side; a stale tab should show the prompt again
  // rather than a grid of images that will 403 on their next fetch.
  function handleLockedOut() {
    setPhotos(null);
    setUnlocked(false);
    setError("That unlock expired. Enter your passphrase again.");
  }

  async function addPhoto(file: File | undefined) {
    if (!file) return;
    setSaving(true); setError("");
    try {
      const prepared = await prepareProgressPhoto(file);
      const saved = await api.addProgressPhoto(prepared, pose, suggestedWeight);
      setPhotos((current) => [saved, ...(current ?? [])]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not save that photo";
      if (message.includes("locked")) handleLockedOut(); else setError(message);
    } finally {
      setSaving(false);
      // Cleared so picking the same file twice still fires a change event.
      if (cameraInput.current) cameraInput.current.value = "";
      if (galleryInput.current) galleryInput.current.value = "";
    }
  }

  async function removePhoto(photo: ProgressPhoto) {
    if (!confirm(`Delete this ${POSE_LABEL[photo.pose].toLowerCase()} photo from ${niceDate(photo.takenDate)}?`)) return;
    const previous = photos;
    setPhotos((current) => (current ?? []).filter((item) => item.id !== photo.id));
    try { await api.deleteProgressPhoto(photo.id); }
    catch { setPhotos(previous ?? []); setError("Could not delete that photo"); }
  }

  // Grouped by the local capture date so a front/side/back set from one session
  // reads as a single row rather than three unrelated entries.
  const byDate = useMemo(() => {
    const groups = new Map<string, ProgressPhoto[]>();
    for (const photo of photos ?? []) {
      groups.set(photo.takenDate, [...(groups.get(photo.takenDate) ?? []), photo]);
    }
    return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [photos]);

  const forCompare = useMemo(() => (photos ?? []).filter((photo) => photo.pose === comparePose), [photos, comparePose]);
  const oldest = forCompare.at(-1);
  const newest = forCompare.length > 1 ? forCompare[0] : undefined;

  if (unlocked === null) return <section className="chart-card"><div className="chart-header"><div><p className="eyebrow">BODY</p><h2>Progress photos</h2></div></div><div className="skeleton rows" /></section>;

  if (!unlocked) return (
    <section className="chart-card photos-card locked">
      <PhotoLock
        separateSecret={separateSecret}
        unlockMinutes={unlockMinutes}
        unlocking={unlocking}
        error={error}
        onSubmit={unlock}
        onDismissError={() => setError("")}
      />
    </section>
  );

  if (!photos) return <section className="chart-card"><div className="chart-header"><div><p className="eyebrow">BODY</p><h2>Progress photos</h2></div></div><div className="skeleton rows" /></section>;

  return (
    <section className="chart-card photos-card">
      <div className="chart-header">
        <div><p className="eyebrow">BODY</p><h2>Progress photos</h2></div>
        <div className="photo-views">
          {photos.length > 0 && <>
            <button className={view === "timeline" ? "active" : ""} onClick={() => setView("timeline")}>Timeline</button>
            <button className={view === "compare" ? "active" : ""} onClick={() => setView("compare")}>Compare</button>
          </>}
          <button className="lock-now" onClick={lock} title="Hide these again"><Lock size={13} /> Lock</button>
        </div>
      </div>

      <div className="photo-capture">
        <div className="pose-row">{POSES.map((option) => (
          <button key={option} className={pose === option ? "active" : ""} onClick={() => setPose(option)}>{POSE_LABEL[option]}</button>
        ))}</div>
        <input ref={cameraInput} hidden type="file" accept="image/*" capture="environment" onChange={(e) => addPhoto(e.target.files?.[0])} />
        <input ref={galleryInput} hidden type="file" accept="image/*" onChange={(e) => addPhoto(e.target.files?.[0])} />
        <div className="photo-sources">
          {saving ? <span className="photo-saving"><LoaderCircle className="spin" size={16} /> Saving {POSE_LABEL[pose].toLowerCase()} photo…</span> : <>
            <button className="secondary" onClick={() => cameraInput.current?.click()}><Camera size={16} /> Camera</button>
            <button className="secondary" onClick={() => galleryInput.current?.click()}><Images size={16} /> Gallery</button>
          </>}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}

      {photos.length === 0 && <div className="empty-memory"><Camera /><strong>No photos yet</strong><p>Same pose, same spot, same light. The comparison is what makes it useful — a single photo tells you nothing.</p></div>}

      {view === "timeline" && byDate.map(([date, shots]) => (
        <div className="photo-day" key={date}>
          <div className="photo-day-head"><strong>{niceDate(date)}</strong>{shots[0].weightKg != null && <span>{shots[0].weightKg.toFixed(1)} kg</span>}</div>
          <div className="photo-row">{shots.map((photo) => (
            <figure key={photo.id}>
              <img src={photo.imagePath} alt={`${POSE_LABEL[photo.pose]} on ${niceDate(photo.takenDate)}`} loading="lazy" />
              <figcaption>{POSE_LABEL[photo.pose]}</figcaption>
              <button className="photo-delete" aria-label="Delete photo" onClick={() => removePhoto(photo)}><Trash2 size={14} /></button>
            </figure>
          ))}</div>
        </div>
      ))}

      {view === "compare" && <div className="photo-compare">
        <div className="pose-row">{POSES.map((option) => (
          <button key={option} className={comparePose === option ? "active" : ""} onClick={() => setComparePose(option)}>{POSE_LABEL[option]}</button>
        ))}</div>
        {!newest || !oldest ? (
          <p className="photo-hint">Two {POSE_LABEL[comparePose].toLowerCase()} photos are needed before there is anything to compare.</p>
        ) : (
          <div className="photo-row compare">
            {[oldest, newest].map((photo, index) => (
              <figure key={photo.id}>
                <img src={photo.imagePath} alt={`${POSE_LABEL[photo.pose]} on ${niceDate(photo.takenDate)}`} loading="lazy" />
                <figcaption>{index === 0 ? "First" : "Latest"} · {niceDate(photo.takenDate)}{photo.weightKg != null ? ` · ${photo.weightKg.toFixed(1)} kg` : ""}</figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>}
    </section>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, ImagePlus, LoaderCircle, Trash2 } from "lucide-react";
import { api } from "../api";
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
  const [photos, setPhotos] = useState<ProgressPhoto[] | null>(null);
  const [pose, setPose] = useState<ProgressPose>("front");
  const [comparePose, setComparePose] = useState<ProgressPose>("front");
  const [view, setView] = useState<"timeline" | "compare">("timeline");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => { api.progressPhotos().then(setPhotos).catch(() => setPhotos([])); }, []);

  async function addPhoto(file: File | undefined) {
    if (!file) return;
    setSaving(true); setError("");
    try {
      const prepared = await prepareProgressPhoto(file);
      const saved = await api.addProgressPhoto(prepared, pose, suggestedWeight);
      setPhotos((current) => [saved, ...(current ?? [])]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that photo");
    } finally {
      setSaving(false);
      if (fileInput.current) fileInput.current.value = "";
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

  if (!photos) return <section className="chart-card"><div className="chart-header"><div><p className="eyebrow">BODY</p><h2>Progress photos</h2></div></div><div className="skeleton rows" /></section>;

  return (
    <section className="chart-card photos-card">
      <div className="chart-header">
        <div><p className="eyebrow">BODY</p><h2>Progress photos</h2></div>
        {photos.length > 0 && <div className="photo-views">
          <button className={view === "timeline" ? "active" : ""} onClick={() => setView("timeline")}>Timeline</button>
          <button className={view === "compare" ? "active" : ""} onClick={() => setView("compare")}>Compare</button>
        </div>}
      </div>

      <div className="photo-capture">
        <div className="pose-row">{POSES.map((option) => (
          <button key={option} className={pose === option ? "active" : ""} onClick={() => setPose(option)}>{POSE_LABEL[option]}</button>
        ))}</div>
        <input ref={fileInput} hidden type="file" accept="image/*" capture="environment" onChange={(e) => addPhoto(e.target.files?.[0])} />
        <button className="secondary" disabled={saving} onClick={() => fileInput.current?.click()}>
          {saving ? <><LoaderCircle className="spin" size={17} /> Saving…</> : <><ImagePlus size={17} /> Add {POSE_LABEL[pose].toLowerCase()} photo</>}
        </button>
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

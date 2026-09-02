import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Images, Lock, LoaderCircle, Trash2 } from "lucide-react";
import { api } from "../api";
import { PhotoLock } from "./PhotoLock";
import { PhotoViewer } from "./PhotoViewer";
import {
  encryptForUpload, forgetMasterKey, loadPhotoUrl, releasePhotoUrl, setUpEncryption,
  unlockWithPassphrase, unlockWithRecoveryKey
} from "../photoSession";
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
  const [unlockMinutes, setUnlockMinutes] = useState(3);
  const [separateSecret, setSeparateSecret] = useState(false);
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [encryption, setEncryption] = useState<{ configured: boolean; salt: string | null }>({ configured: true, salt: null });
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  // Which photo is open full size, by id. An id rather than the object so the
  // viewer follows the row through a refresh instead of pinning a stale copy.
  const [viewingId, setViewingId] = useState<string | null>(null);
  // Decrypted photos exist only as blob URLs, keyed by photo id.
  const [urls, setUrls] = useState<Record<string, string>>({});
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
  // Every blob URL handed out, so they can be revoked together on lock. A ref
  // rather than state because revoking must not depend on a re-render happening.
  const blobUrls = useRef<string[]>([]);

  useEffect(() => { api.progressState().then((state) => { setUnlocked(state.unlocked); setExpiresAt(state.expiresAt); setUnlockMinutes(state.unlockMinutes); setSeparateSecret(state.separateSecret); setEncryption(state.encryption); }).catch(() => setUnlocked(false)); }, []);
  useEffect(() => {
    if (!unlocked) { setPhotos(null); return; }
    api.progressPhotos().then(setPhotos).catch(() => setPhotos([]));
  }, [unlocked]);

  /**
   * Drops every trace of the decrypted photos: the master key, the blob URLs
   * holding plaintext bytes, and the rows themselves. Revoking matters — a live
   * blob URL keeps its decrypted bytes reachable for as long as the page lives,
   * which would outlast the lock it is supposed to obey.
   */
  function sealUp() {
    setViewingId(null);
    forgetMasterKey();
    for (const url of blobUrls.current) releasePhotoUrl(url);
    blobUrls.current = [];
    setUrls({});
    setPhotos(null);
    setUnlocked(false);
    setExpiresAt(null);
  }

  /**
   * Close the gallery the moment the unlock lapses.
   *
   * The cookie expiring server-side only makes the *next* request fail — photos
   * already painted stay on screen indefinitely, which is exactly the case the
   * short window exists to prevent. The timer closes the view on time, and the
   * visibility check re-tests on return because a backgrounded tab's timers are
   * throttled and may not have fired at all.
   */
  useEffect(() => {
    if (!unlocked || expiresAt === null) return;
    const close = () => { sealUp(); setError("Photos locked again. Enter your passphrase to reopen them."); };
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) { close(); return; }
    const timer = setTimeout(close, remaining);
    const onVisible = () => { if (document.visibilityState === "visible" && Date.now() >= expiresAt) close(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [unlocked, expiresAt]);

  async function unlock(code: string) {
    setUnlocking(true); setError("");
    try {
      if (!encryption.configured) {
        // First run: generate the keys, then show the recovery key before the
        // gallery. `setUnlocked` waits until that has been acknowledged.
        const created = await setUpEncryption(code);
        setRecoveryKey(created.recoveryKey);
        setExpiresAt(created.expiresAt);
        setEncryption(await api.progressState().then((state) => state.encryption));
      } else if (encryption.salt) {
        const state = await unlockWithPassphrase(code, encryption.salt);
        setExpiresAt(state.expiresAt);
        setUnlocked(true);
      } else {
        const state = await api.unlockPhotos(code);
        setExpiresAt(state.expiresAt);
        setUnlocked(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unlock");
    } finally { setUnlocking(false); }
  }

  async function recover(key: string) {
    setUnlocking(true); setError("");
    try {
      const state = await unlockWithRecoveryKey(key);
      setExpiresAt(state.expiresAt);
      setUnlocked(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That recovery key did not work");
    } finally { setUnlocking(false); }
  }

  async function lock() {
    await api.lockPhotos().catch(() => undefined);
    sealUp();
  }

  // The unlock expires server-side; a stale tab should show the prompt again
  // rather than a grid of images that will 403 on their next fetch.
  function handleLockedOut() {
    sealUp();
    setError("That unlock expired. Enter your passphrase again.");
  }

  /**
   * Turns each row into something an <img> can show. Encrypted photos are
   * fetched and decrypted here; anything from before encryption was switched on
   * is served as-is, which is what the per-row flag distinguishes.
   */
  useEffect(() => {
    if (!photos) return;
    let live = true;
    (async () => {
      for (const photo of photos) {
        if (!live) break;
        if (urls[photo.id]) continue;
        try {
          const url = await loadPhotoUrl(photo.imagePath, photo.encrypted);
          if (!live) { releasePhotoUrl(url); break; }
          if (url.startsWith("blob:")) blobUrls.current.push(url);
          setUrls((current) => ({ ...current, [photo.id]: url }));
        } catch (err) {
          if (err instanceof Error && err.message === "locked") { handleLockedOut(); break; }
          setError("Could not decrypt one of the photos.");
        }
      }
    })();
    // Only stops the loop. Revoking here would kill the URLs of photos already
    // on screen every time the list changes — adding one photo would blank the
    // rest. sealUp owns revocation, because that is when the bytes should go.
    return () => { live = false; };
  }, [photos]);

  // Last resort: leaving the screen should not strand decrypted bytes.
  useEffect(() => () => { for (const url of blobUrls.current) releasePhotoUrl(url); blobUrls.current = []; }, []);

  async function addPhoto(file: File | undefined) {
    if (!file) return;
    setSaving(true); setError("");
    try {
      const prepared = await prepareProgressPhoto(file);
      // Encrypted before it ever leaves the browser, so the upload the Worker
      // sees is opaque bytes.
      const encrypt = encryption.configured;
      const payload = encrypt ? await encryptForUpload(prepared) : prepared;
      const saved = await api.addProgressPhoto(payload, pose, suggestedWeight, undefined, encrypt);
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

  // Resolved from the live list, so a deleted photo closes the viewer rather
  // than leaving it showing a row that no longer exists.
  const viewing = (photos ?? []).find((photo) => photo.id === viewingId) ?? null;
  const viewingIndex = viewing ? (photos ?? []).indexOf(viewing) : -1;

  // Wraps at both ends: with a handful of photos, stopping dead at the last one
  // is more annoying than looping.
  function step(direction: 1 | -1) {
    if (!photos || photos.length === 0 || viewingIndex < 0) return;
    setViewingId(photos[(viewingIndex + direction + photos.length) % photos.length].id);
  }

  const forCompare = useMemo(() => (photos ?? []).filter((photo) => photo.pose === comparePose), [photos, comparePose]);
  const oldest = forCompare.at(-1);
  const newest = forCompare.length > 1 ? forCompare[0] : undefined;

  if (unlocked === null) return <section className="chart-card"><div className="chart-header"><div><h2>Progress photos</h2></div></div><div className="skeleton rows" /></section>;

  if (!unlocked) return (
    <section className="chart-card photos-card locked">
      <PhotoLock
        separateSecret={separateSecret}
        unlockMinutes={unlockMinutes}
        unlocking={unlocking}
        error={error}
        needsSetup={!encryption.configured}
        recoveryKey={recoveryKey}
        onSubmit={unlock}
        onRecover={recover}
        onDismissError={() => setError("")}
        onRecoveryKeySaved={() => { setRecoveryKey(null); setUnlocked(true); }}
      />
    </section>
  );

  if (!photos) return <section className="chart-card"><div className="chart-header"><div><h2>Progress photos</h2></div></div><div className="skeleton rows" /></section>;

  return (
    <section className="chart-card photos-card">
      <div className="chart-header">
        <div><h2>Progress photos</h2></div>
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
              <button className="photo-open" onClick={() => setViewingId(photo.id)}
                      aria-label={`Open ${POSE_LABEL[photo.pose].toLowerCase()} photo from ${niceDate(photo.takenDate)}`}>
                <img src={urls[photo.id]} alt={`${POSE_LABEL[photo.pose]} on ${niceDate(photo.takenDate)}`} loading="lazy" />
              </button>
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
                <button className="photo-open" onClick={() => setViewingId(photo.id)}
                        aria-label={`Open ${POSE_LABEL[photo.pose].toLowerCase()} photo from ${niceDate(photo.takenDate)}`}>
                  <img src={urls[photo.id]} alt={`${POSE_LABEL[photo.pose]} on ${niceDate(photo.takenDate)}`} loading="lazy" />
                </button>
                <figcaption>{index === 0 ? "First" : "Latest"} · {niceDate(photo.takenDate)}{photo.weightKg != null ? ` · ${photo.weightKg.toFixed(1)} kg` : ""}</figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>}

      {viewing && (
        <PhotoViewer
          photo={viewing}
          url={urls[viewing.id]}
          index={viewingIndex}
          total={photos.length}
          onPrevious={() => step(-1)}
          onNext={() => step(1)}
          onDelete={(photo) => { setViewingId(null); removePhoto(photo); }}
          onClose={() => setViewingId(null)}
        />
      )}
    </section>
  );
}

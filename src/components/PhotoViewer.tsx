import { useEffect } from "react";
import { ChevronLeft, ChevronRight, Trash2, X } from "lucide-react";
import type { ProgressPhoto, ProgressPose } from "../types";

const POSE_LABEL: Record<ProgressPose, string> = { front: "Front", side: "Side", back: "Back" };

function niceDate(takenDate: string) {
  const [year, month, day] = takenDate.split("-").map(Number);
  return new Intl.DateTimeFormat([], { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day, 12)));
}

/**
 * One photo, full size.
 *
 * It renders from the same decrypted blob URLs the grid uses rather than
 * fetching again: a second fetch would mean a second decrypt, and — more to the
 * point — a second copy of the plaintext to keep track of and revoke. The
 * parent owns those URLs and revokes them on lock, so the viewer holds nothing
 * of its own.
 */
export function PhotoViewer({ photo, url, index, total, onPrevious, onNext, onDelete, onClose }: {
  photo: ProgressPhoto;
  url: string | undefined;
  index: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
  onDelete: (photo: ProgressPhoto) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft") onPrevious();
      else if (event.key === "ArrowRight") onNext();
    }
    window.addEventListener("keydown", onKey);
    // The page behind must not scroll while this is over it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = previousOverflow; };
  }, [onClose, onPrevious, onNext]);

  return (
    <div className="photo-viewer" role="dialog" aria-modal="true" aria-label={`${POSE_LABEL[photo.pose]} photo from ${niceDate(photo.takenDate)}`}
         onClick={onClose}>
      <header onClick={(event) => event.stopPropagation()}>
        <div>
          <strong>{niceDate(photo.takenDate)}</strong>
          <span>{POSE_LABEL[photo.pose]}{photo.weightKg != null ? ` · ${photo.weightKg.toFixed(1)} kg` : ""}{total > 1 ? ` · ${index + 1} of ${total}` : ""}</span>
        </div>
        <div className="photo-viewer-actions">
          <button onClick={() => onDelete(photo)} aria-label="Delete this photo"><Trash2 size={17} /></button>
          <button onClick={onClose} aria-label="Close"><X size={19} /></button>
        </div>
      </header>

      <figure onClick={(event) => event.stopPropagation()}>
        {url
          ? <img src={url} alt={`${POSE_LABEL[photo.pose]} on ${niceDate(photo.takenDate)}`} />
          : <p className="photo-viewer-pending">Decrypting…</p>}
      </figure>

      {total > 1 && <>
        <button className="photo-viewer-step prev" onClick={(event) => { event.stopPropagation(); onPrevious(); }} aria-label="Previous photo"><ChevronLeft size={22} /></button>
        <button className="photo-viewer-step next" onClick={(event) => { event.stopPropagation(); onNext(); }} aria-label="Next photo"><ChevronRight size={22} /></button>
      </>}
    </div>
  );
}

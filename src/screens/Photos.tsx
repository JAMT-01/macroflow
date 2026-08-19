import { ProgressPhotos } from "../components/ProgressPhotos";
import type { Settings } from "../types";

/**
 * Progress photos as a destination of their own.
 *
 * Deliberately thin: `ProgressPhotos` already branches between the lock screen
 * and the gallery, and each branch carries its own heading, so a page header
 * here would only repeat whichever one is showing. The weight comes from
 * settings rather than a fresh `/api/history` call — the server updates it on
 * every check-in, and this screen is locked more often than not, so paying for
 * a 30-day fetch to prefill one number would usually be wasted.
 */
export function Photos({ settings }: { settings: Settings }) {
  return (
    <div className="page photos-page">
      <ProgressPhotos suggestedWeight={settings.weightKg} />
    </div>
  );
}

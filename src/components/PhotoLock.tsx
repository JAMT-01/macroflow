import { useEffect, useState } from "react";
import { Delete, Keyboard, LoaderCircle, Lock, Unlock } from "lucide-react";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * The gate in front of the body photos, as a screen of its own rather than a
 * field tucked into the Progress card.
 *
 * The keypad is the default because the photo passphrase is expected to be a
 * short numeric code, but it cannot be the only option: `PHOTO_PASSPHRASE`
 * falls back to `APP_PASSWORD` when unset (worker/auth.ts), and that one is a
 * worded passphrase no number pad can enter. `separateSecret` tells us which
 * case we are in, so the keyboard is the starting mode when the two secrets are
 * shared, and is always reachable from the pad.
 */
export function PhotoLock({ separateSecret, unlockMinutes, unlocking, error, onSubmit, onDismissError }: {
  separateSecret: boolean;
  unlockMinutes: number;
  unlocking: boolean;
  error: string;
  onSubmit: (code: string) => void;
  onDismissError: () => void;
}) {
  const [code, setCode] = useState("");
  const [typed, setTyped] = useState(!separateSecret);

  // A rejected code clears itself: leaving it on screen invites a second submit
  // of the same wrong digits, and each one spends a slot in the 8-per-15-minutes
  // budget that worker/auth.ts enforces.
  useEffect(() => { if (error) setCode(""); }, [error]);

  function press(key: string) {
    onDismissError();
    setCode((current) => (current.length >= 24 ? current : current + key));
  }

  function submit() {
    if (!code || unlocking) return;
    onSubmit(code);
  }

  // Desktop and any paired keyboard drive the pad directly; without this the
  // numbers on screen would be the only way in on a laptop.
  useEffect(() => {
    if (typed) return;
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^[0-9]$/.test(event.key)) { event.preventDefault(); press(event.key); }
      else if (event.key === "Backspace") { event.preventDefault(); onDismissError(); setCode((c) => c.slice(0, -1)); }
      else if (event.key === "Enter") { event.preventDefault(); submit(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [typed, code, unlocking]);

  const label = separateSecret ? "photo passphrase" : "passphrase";

  return (
    <section className="photo-lock" aria-label="Progress photos, locked">
      <div className="photo-lock-crest"><Lock size={22} /></div>
      <h2>Progress photos</h2>
      <p className="photo-lock-sub">
        Locked separately from the rest of the app. Enter your {label} to open them; they close again
        after {unlockMinutes} minutes, when you close the browser, or whenever you tap Lock.
      </p>

      {typed ? (
        <form className="photo-lock-typed" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            aria-label={separateSecret ? "Photo passphrase" : "Passphrase"}
            placeholder={separateSecret ? "Photo passphrase" : "Passphrase"}
            value={code}
            onChange={(e) => { onDismissError(); setCode(e.target.value); }}
          />
          {error && <p className="photo-lock-error" role="alert">{error}</p>}
          <button className="primary wide" disabled={unlocking || !code}>
            {unlocking ? <LoaderCircle className="spin" size={16} /> : <Unlock size={16} />} Unlock
          </button>
          {separateSecret && (
            <button type="button" className="photo-lock-swap" onClick={() => { setCode(""); setTyped(false); onDismissError(); }}>
              Use the number pad
            </button>
          )}
        </form>
      ) : (
        <>
          <div className={`photo-lock-display${error ? " wrong" : ""}`} role="status" aria-live="polite"
               aria-label={code.length ? `${code.length} digits entered` : "No digits entered"}>
            {code.length === 0
              ? <span className="photo-lock-placeholder">Enter your code</span>
              : [...code].map((_, index) => <i key={index} />)}
          </div>

          <p className={`photo-lock-error${error ? "" : " hidden"}`} role="alert">{error || " "}</p>

          <div className="photo-lock-pad">
            {KEYS.map((key) => (
              <button key={key} type="button" onClick={() => press(key)} disabled={unlocking}>{key}</button>
            ))}
            <button type="button" className="pad-soft" onClick={() => { setCode(""); setTyped(true); onDismissError(); }}
                    aria-label="Type a passphrase instead"><Keyboard size={19} /></button>
            <button type="button" onClick={() => press("0")} disabled={unlocking}>0</button>
            <button type="button" className="pad-soft" onClick={() => { onDismissError(); setCode((c) => c.slice(0, -1)); }}
                    disabled={unlocking || !code} aria-label="Delete last digit"><Delete size={19} /></button>
          </div>

          <button className="primary wide photo-lock-go" onClick={submit} disabled={unlocking || !code}>
            {unlocking ? <LoaderCircle className="spin" size={16} /> : <Unlock size={16} />} Unlock
          </button>
        </>
      )}
    </section>
  );
}

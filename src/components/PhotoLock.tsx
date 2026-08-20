import { useEffect, useState } from "react";
import { Delete, Keyboard, KeyRound, LoaderCircle, Lock, ShieldCheck, Unlock } from "lucide-react";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

type Stage = "enter" | "confirm" | "recoveryKey" | "recover";

/**
 * The gate in front of the body photos, as a screen of its own rather than a
 * field tucked into the Progress card.
 *
 * The keypad is the default because the photo passphrase is expected to be a
 * short numeric code, but it cannot be the only option: the passphrase may be a
 * worded one, and the recovery key is 43 characters. `separateSecret` picks the
 * starting mode, and the keyboard is always reachable from the pad.
 *
 * When encryption has not been set up yet this doubles as the setup flow, which
 * is why the code is entered twice: a typo here would not lock you out — the
 * recovery key still works — but it would mean the passphrase you believe you
 * chose is not the one that opens the photos.
 */
export function PhotoLock({
  separateSecret, unlockMinutes, unlocking, error, needsSetup, recoveryKey,
  onSubmit, onRecover, onDismissError, onRecoveryKeySaved
}: {
  separateSecret: boolean;
  unlockMinutes: number;
  unlocking: boolean;
  error: string;
  needsSetup: boolean;
  recoveryKey: string | null;
  onSubmit: (code: string) => void;
  onRecover: (recoveryKey: string) => void;
  onDismissError: () => void;
  onRecoveryKeySaved: () => void;
}) {
  const [code, setCode] = useState("");
  const [firstCode, setFirstCode] = useState("");
  const [stage, setStage] = useState<Stage>("enter");
  const [typed, setTyped] = useState(!separateSecret);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  // Local, because a mismatch between the two setup entries never reaches the
  // server and so has no business travelling through the parent's error slot.
  const [mismatch, setMismatch] = useState("");

  useEffect(() => { if (recoveryKey) setStage("recoveryKey"); }, [recoveryKey]);

  // A rejected code clears itself: leaving it on screen invites a second submit
  // of the same wrong digits, and each one spends a slot in the 8-per-15-minutes
  // budget that worker/auth.ts enforces.
  useEffect(() => { if (error) setCode(""); }, [error]);

  const shownError = error || mismatch;

  function press(key: string) {
    onDismissError(); setMismatch("");
    setCode((current) => (current.length >= 64 ? current : current + key));
  }

  function submit() {
    if (!code || unlocking) return;
    if (stage === "recover") { onRecover(code); return; }
    if (!needsSetup) { onSubmit(code); return; }
    if (stage === "enter") { setFirstCode(code); setCode(""); setMismatch(""); setStage("confirm"); return; }
    if (code !== firstCode) {
      setCode(""); setFirstCode(""); setStage("enter");
      setMismatch("Those did not match. Choose your code again.");
      return;
    }
    onSubmit(code);
  }

  // Desktop and any paired keyboard drive the pad directly; without this the
  // numbers on screen would be the only way in on a laptop.
  useEffect(() => {
    if (typed || stage === "recoveryKey") return;
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^[0-9]$/.test(event.key)) { event.preventDefault(); press(event.key); }
      else if (event.key === "Backspace") { event.preventDefault(); onDismissError(); setMismatch(""); setCode((c) => c.slice(0, -1)); }
      else if (event.key === "Enter") { event.preventDefault(); submit(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [typed, code, unlocking, stage, needsSetup, firstCode]);

  const label = separateSecret ? "photo passphrase" : "passphrase";

  if (stage === "recoveryKey" && recoveryKey) return (
    <section className="photo-lock" aria-label="Save your recovery key">
      <div className="photo-lock-crest"><ShieldCheck size={22} /></div>
      <h2>Save your recovery key</h2>
      <p className="photo-lock-sub">
        Your photos are encrypted now. This key is the only way back in if you forget the passphrase —
        it is shown once, and nobody, including this app, can produce it again.
      </p>
      <output className="recovery-key">{recoveryKey.replace(/(.{8})/g, "$1 ").trim()}</output>
      <button className="secondary wide" onClick={() => navigator.clipboard?.writeText(recoveryKey).catch(() => undefined)}>
        Copy to clipboard
      </button>
      <label className="recovery-confirm">
        <input type="checkbox" checked={savedConfirmed} onChange={(e) => setSavedConfirmed(e.target.checked)} />
        <span>I have saved it in my password manager</span>
      </label>
      <button className="primary wide photo-lock-go" disabled={!savedConfirmed} onClick={onRecoveryKeySaved}>
        <Unlock size={16} /> Open my photos
      </button>
    </section>
  );

  const heading = stage === "recover" ? "Use your recovery key"
    : needsSetup ? (stage === "confirm" ? "Confirm your code" : "Protect your photos")
    : "Progress photos";

  const blurb = stage === "recover"
    ? "Paste the recovery key you saved when encryption was set up."
    : needsSetup
      ? (stage === "confirm"
        ? "Enter it once more. If the two do not match you will be asked to start again."
        : "Choose a code. Your photos get encrypted in this browser before they are uploaded, so nobody who reaches the storage — including Cloudflare — can see them.")
      : `Locked separately from the rest of the app. Enter your ${label} to open them; they close again after ${unlockMinutes} minutes, when you close the browser, or whenever you tap Lock.`;

  const showKeyboard = typed || stage === "recover";

  return (
    <section className="photo-lock" aria-label={needsSetup ? "Set up photo encryption" : "Progress photos, locked"}>
      <div className="photo-lock-crest">{needsSetup ? <ShieldCheck size={22} /> : <Lock size={22} />}</div>
      <h2>{heading}</h2>
      <p className="photo-lock-sub">{blurb}</p>

      {showKeyboard ? (
        <form className="photo-lock-typed" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <input
            type={stage === "recover" ? "text" : "password"}
            autoComplete={stage === "recover" ? "off" : "current-password"}
            autoFocus
            spellCheck={false}
            aria-label={stage === "recover" ? "Recovery key" : separateSecret ? "Photo passphrase" : "Passphrase"}
            placeholder={stage === "recover" ? "Recovery key" : separateSecret ? "Photo passphrase" : "Passphrase"}
            value={code}
            onChange={(e) => { onDismissError(); setMismatch(""); setCode(e.target.value); }}
          />
          {shownError && <p className="photo-lock-error" role="alert">{shownError}</p>}
          <button className="primary wide" disabled={unlocking || !code}>
            {unlocking ? <LoaderCircle className="spin" size={16} /> : <Unlock size={16} />}
            {needsSetup ? (stage === "confirm" ? " Confirm" : " Continue") : " Unlock"}
          </button>
          {stage === "recover"
            ? <button type="button" className="photo-lock-swap" onClick={() => { setCode(""); setStage("enter"); setTyped(!separateSecret); onDismissError(); }}>Back to the passphrase</button>
            : separateSecret && <button type="button" className="photo-lock-swap" onClick={() => { setCode(""); setTyped(false); onDismissError(); setMismatch(""); }}>Use the number pad</button>}
        </form>
      ) : (
        <>
          <div className={`photo-lock-display${shownError ? " wrong" : ""}`} role="status" aria-live="polite"
               aria-label={code.length ? `${code.length} digits entered` : "No digits entered"}>
            {code.length === 0
              ? <span className="photo-lock-placeholder">{needsSetup ? "Choose a code" : "Enter your code"}</span>
              : [...code].map((_, index) => <i key={index} />)}
          </div>

          <p className={`photo-lock-error${shownError ? "" : " hidden"}`} role="alert">{shownError || " "}</p>

          <div className="photo-lock-pad">
            {KEYS.map((key) => (
              <button key={key} type="button" onClick={() => press(key)} disabled={unlocking}>{key}</button>
            ))}
            <button type="button" className="pad-soft" onClick={() => { setCode(""); setTyped(true); onDismissError(); setMismatch(""); }}
                    aria-label="Type a passphrase instead"><Keyboard size={19} /></button>
            <button type="button" onClick={() => press("0")} disabled={unlocking}>0</button>
            <button type="button" className="pad-soft" onClick={() => { onDismissError(); setMismatch(""); setCode((c) => c.slice(0, -1)); }}
                    disabled={unlocking || !code} aria-label="Delete last digit"><Delete size={19} /></button>
          </div>

          <button className="primary wide photo-lock-go" onClick={submit} disabled={unlocking || !code}>
            {unlocking ? <LoaderCircle className="spin" size={16} /> : <Unlock size={16} />}
            {needsSetup ? (stage === "confirm" ? " Confirm" : " Continue") : " Unlock"}
          </button>
        </>
      )}

      {!needsSetup && stage !== "recover" && (
        <button type="button" className="photo-lock-swap" onClick={() => { setCode(""); setStage("recover"); onDismissError(); }}>
          <KeyRound size={13} /> Forgotten it? Use your recovery key
        </button>
      )}
    </section>
  );
}

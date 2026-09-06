import { useRef, useState } from "react";
import { Button, Notice, Field } from "./ui";

// Tesseract runs in the browser, loaded on demand.
//
// A paper inspection report photographed at the pit head shouldn't have
// to be retyped at a desk hours later -- that gap is where field records
// get lost or invented. Doing the recognition client-side means the photo
// never leaves the device, which matters for something that may show
// names, and it needs no API key or per-page cost.
const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js";

function loadTesseract() {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve(window.Tesseract);
    const found = document.querySelector(`script[src="${TESSERACT}"]`);
    if (found) {
      found.addEventListener("load", () => resolve(window.Tesseract));
      found.addEventListener("error", () => reject(new Error("Could not load the text reader")));
      return;
    }
    const s = document.createElement("script");
    s.src = TESSERACT;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error("Could not load the text reader"));
    document.head.appendChild(s);
  });
}

// Keyword sets for the two fields the form can prefill. These are the
// words that actually appear on a DGMS-style observation sheet, so the
// match is against real vocabulary rather than the dropdown labels alone.
const OBSERVATION_HINTS = {
  "Safety Equipment Check": ["ppe", "helmet", "boots", "harness", "equipment", "gloves", "safety gear"],
  "Ventilation Inspection": ["ventilation", "air flow", "airflow", "methane", "gas", "fan", "booster"],
  "Slope Stability": ["slope", "bench", "highwall", "overburden", "dump", "collapse", "subsidence"],
  "Electrical Safety": ["electrical", "cable", "transformer", "earthing", "switchgear", "voltage"],
  "Housekeeping": ["housekeeping", "debris", "spillage", "obstruction", "clutter", "waste"],
  "Water Accumulation": ["water", "flooding", "drainage", "sump", "seepage", "inundation"],
  "PPE Compliance": ["ppe compliance", "not wearing", "without helmet", "protective"],
};

const SEVERITY_HINTS = {
  Critical: ["critical", "immediate", "stop work", "danger", "fatal", "emergency", "imminent"],
  High: ["high", "serious", "urgent", "major", "significant"],
  Medium: ["medium", "moderate"],
  Low: ["low", "minor", "routine", "satisfactory"],
};

// Recognition output is noisy: single-character lines, stray punctuation
// from table rules, and hard line breaks mid-sentence. Cleaning it before
// it reaches a form field is the difference between a usable draft and
// something the inspector deletes and retypes.
function tidy(raw) {
  return raw
    .split("\n")
    .map((l) => l.replace(/[|_]{2,}/g, " ").replace(/\s{2,}/g, " ").trim())
    .filter((l) => l.length > 2 && /[a-zA-Z]/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function detect(text, hints) {
  const lower = text.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const [label, words] of Object.entries(hints)) {
    const score = words.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = label;
    }
  }
  return bestScore > 0 ? best : null;
}

export default function OcrCapture({ onExtract }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState(null);
  const [preview, setPreview] = useState(null);
  const [text, setText] = useState("");

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus(null);
    setText("");
    setPreview(URL.createObjectURL(file));
    setBusy(true);
    setProgress(0);

    try {
      const Tesseract = await loadTesseract();
      const { data } = await Tesseract.recognize(file, "eng", {
        logger: (m) => {
          if (m.status === "recognizing text") setProgress(Math.round(m.progress * 100));
        },
      });
      const cleaned = tidy(data.text || "");
      if (!cleaned) {
        setStatus({ tone: "error", text: "No readable text found. Try a sharper photo, straight on, with the page filling the frame." });
        return;
      }
      setText(cleaned);

      // Confidence is reported so the inspector knows how much to trust
      // the draft. A low score usually means a skewed or shadowed photo,
      // which is fixable by retaking it.
      const conf = Math.round(data.confidence || 0);
      setStatus({
        tone: conf < 60 ? "info" : "success",
        text: conf < 60
          ? `Read with ${conf}% confidence. Check the text before you use it.`
          : `Read with ${conf}% confidence.`,
      });
    } catch (err) {
      setStatus({ tone: "error", text: `Could not read the image: ${err.message || err}` });
    } finally {
      setBusy(false);
    }
  };

  const useIt = () => {
    onExtract?.({
      notes: text,
      observationType: detect(text, OBSERVATION_HINTS),
      severity: detect(text, SEVERITY_HINTS),
    });
    setStatus({ tone: "success", text: "Copied into the form below. Check it before you record." });
  };

  return (
    <div>
      <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: -4 }}>
        Photograph a paper observation sheet and the text is read on this device
        into the form below. The image is not uploaded anywhere.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFile}
        style={{ display: "none" }}
      />
      <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={busy}>
        {busy ? `Reading ${progress}%` : "Photograph or choose a sheet"}
      </Button>

      {status && (
        <div style={{ marginTop: 12 }}>
          <Notice tone={status.tone}>{status.text}</Notice>
        </div>
      )}

      {preview && (
        <div style={{ display: "flex", gap: 16, marginTop: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
          <img
            src={preview}
            alt="The sheet you photographed"
            style={{ width: 160, border: "1px solid var(--line)", borderRadius: "var(--radius)" }}
          />
          {text && (
            <div style={{ flex: 1, minWidth: 260 }}>
              <Field label="Text read from the sheet — correct anything wrong">
                <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} />
              </Field>
              <Button onClick={useIt}>Use this text</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

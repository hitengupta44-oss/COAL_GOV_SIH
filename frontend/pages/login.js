import { useState } from "react";
import { useRouter } from "next/router";
import { useAuth } from "../lib/useAuth";
import { Button, Field, Notice } from "../components/ui";

export default function Login() {
  const { login, signup } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "login") {
        await login(email, password);
        router.push("/dashboard");
      } else {
        await signup(email, password, fullName);
        router.push("/pending-approval");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      {/* The left panel states what the platform is for. A login screen is
          the one place a first-time user has no other context. */}
      <aside style={{
        flex: "0 0 42%", background: "var(--ink)", color: "#C9D4DE",
        padding: "56px 48px", display: "flex", flexDirection: "column", justifyContent: "center",
      }}>
        <h1 style={{ color: "#fff", fontSize: 30, lineHeight: 1.2, maxWidth: 380 }}>
          Coal Mine Governance
        </h1>
        <p style={{ marginTop: 14, maxWidth: 400, fontSize: 15, lineHeight: 1.6 }}>
          Statutory compliance, safety findings and contractor oversight for coal
          mining operations — in one record, visible to the people accountable for it.
        </p>
        <div style={{ marginTop: 32, borderTop: "1px solid rgba(255,255,255,.14)", paddingTop: 20, fontSize: 13.5, color: "#8FA2B4", maxWidth: 400 }}>
          What you can see depends on your role. Mine officials and inspectors see
          their own site; regulators and corporate management see across all mines.
        </div>
      </aside>

      <main style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 32 }}>
        <form onSubmit={submit} style={{ width: "100%", maxWidth: 380 }}>
          <h2 style={{ fontSize: 20, marginBottom: 4 }}>
            {mode === "login" ? "Sign in" : "Create an account"}
          </h2>
          <p style={{ color: "var(--ink-soft)", fontSize: 14, marginBottom: 20 }}>
            {mode === "login"
              ? "Use the account your administrator set up for you."
              : "An administrator assigns your role once you've signed up."}
          </p>

          {error && <Notice tone="error">{error}</Notice>}

          {mode === "signup" && (
            <Field label="Full name">
              <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </Field>
          )}
          <Field label="Email">
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password">
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>

          <Button type="submit" disabled={busy} style={{ width: "100%" }}>
            {busy ? "Please wait" : mode === "login" ? "Sign in" : "Create account"}
          </Button>

          <p style={{ marginTop: 16, fontSize: 14 }}>
            {mode === "login" ? "No account yet? " : "Already have an account? "}
            <button type="button" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); }}
              style={{ background: "none", border: "none", color: "var(--primary)", cursor: "pointer", padding: 0, fontSize: 14 }}>
              {mode === "login" ? "Create one" : "Sign in"}
            </button>
          </p>
        </form>
      </main>
    </div>
  );
}

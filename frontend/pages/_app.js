import React from "react";
import { AuthProvider } from "../lib/useAuth";
import "../styles/globals.css";

// Next.js replaces any uncaught render error in production with a bare
// "Application error: a client-side exception has occurred" screen and
// puts the real message only in the browser console. That is useless to
// anyone who hits it, and it hid a logout crash here for some time. This
// boundary catches the error, shows what actually happened, and offers a
// way out instead of a dead black page.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    console.error("Caught by boundary:", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { error, info } = this.state;
    return (
      <div style={{ padding: 40, maxWidth: 760, margin: "0 auto" }}>
        <h1 style={{ fontSize: 20 }}>Something broke on this screen</h1>
        <p style={{ color: "var(--ink-soft)", fontSize: 14.5 }}>
          The details below say what went wrong. Signing out and back in usually
          clears it.
        </p>
        <pre
          style={{
            background: "var(--sev-critical-wash)",
            borderLeft: "3px solid var(--sev-critical)",
            padding: 14,
            fontSize: 13,
            whiteSpace: "pre-wrap",
            overflowX: "auto",
          }}
        >
          {String(error && (error.stack || error.message || error))}
          {info?.componentStack ? "\n\nComponent stack:" + info.componentStack : ""}
        </pre>
        <button
          onClick={() => {
            // Clear the stored session before reloading: if the crash came
            // from a half-torn-down auth state, reloading into the same
            // stored session would just reproduce it.
            try {
              Object.keys(window.localStorage)
                .filter((k) => k.startsWith("sb-"))
                .forEach((k) => window.localStorage.removeItem(k));
            } catch (e) {
              /* storage unavailable; the reload is still worth trying */
            }
            window.location.href = "/login";
          }}
          style={{
            padding: "8px 14px",
            background: "var(--primary)",
            color: "#fff",
            border: "1px solid var(--primary)",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          Sign out and start again
        </button>
      </div>
    );
  }
}

export default function App({ Component, pageProps }) {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <Component {...pageProps} />
      </AuthProvider>
    </ErrorBoundary>
  );
}

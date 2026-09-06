import { useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/useAuth";
import { chatWithAssistant } from "../lib/api";

// Suggested questions per role.
//
// These exist because a blank chat box is the worst possible interface for
// someone who doesn't yet know what the assistant can answer -- the user
// types something vague, gets a vague reply, and concludes the feature is
// useless. Each list is written to match what that role can actually SEE:
// the backend scopes its data snapshot by role (see _build_chat_context in
// app.py), so suggesting "compare mines across subsidiaries" to a worker
// would just produce a refusal. Keep these in sync with that scoping.
const SUGGESTIONS = {
  corporate_admin: [
    "Which mines are highest risk right now, and why?",
    "Where should I prioritise spending this quarter?",
    "Which subsidiaries have the worst compliance backlog?",
    "Compare our two most accident-prone mines.",
  ],
  regulator: [
    "Which mines have the most overdue statutory obligations?",
    "Where are environmental thresholds being breached?",
    "Which sites show a pattern of repeat violations?",
    "Summarise the national fatal accident picture.",
  ],
  mine_official: [
    "What compliance items are overdue at my mine?",
    "What are my most urgent safety issues?",
    "Which statutory deadlines are coming up?",
    "Summarise open grievances at my mine.",
  ],
  inspector: [
    "What high-severity findings are still open at my mine?",
    "What should I focus on during my next inspection?",
    "Has this mine had repeat issues of the same type?",
    "What compliance gaps relate to safety here?",
  ],
  contractor_manager: [
    "What safety obligations apply to contractor workers here?",
    "Are there open findings involving contractor activity?",
    "What compliance items affect my contract scope?",
  ],
  worker: [
    "What safety rules apply to me at this mine?",
    "What protective equipment am I entitled to?",
    "How do I raise a safety concern?",
    "What is the status of grievances at my mine?",
  ],
  admin: [
    "Summarise platform-wide compliance status.",
    "Which mines need attention most urgently?",
    "What are the biggest risks across all sites?",
  ],
};

export default function ChatPanel({ title = "Ask the Governance Assistant" }) {
  const { profile, getAccessToken } = useAuth();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  const suggestions = SUGGESTIONS[profile?.role] || SUGGESTIONS.worker;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, sending]);

  const send = async (text) => {
    const question = (text ?? input).trim();
    if (!question || sending) return;
    setInput("");
    setSending(true);
    // The question is shown immediately with a null reply so the user sees
    // their message land rather than staring at an unchanged box.
    setMessages((prev) => [...prev, { user: question, bot: null }]);
    try {
      const accessToken = await getAccessToken();
      const history = messages
        .filter((m) => m.bot)
        .map((m) => [m.user, m.bot]);
      const reply = await chatWithAssistant(accessToken, question, history);
      setMessages((prev) =>
        prev.map((m, i) => (i === prev.length - 1 ? { ...m, bot: reply } : m))
      );
    } catch (e) {
      setMessages((prev) =>
        prev.map((m, i) =>
          i === prev.length - 1 ? { ...m, bot: `Error: ${e.message || e}` } : m
        )
      );
    } finally {
      setSending(false);
    }
  };

  if (!open) {
    return (
      <div style={{ marginTop: 32 }}>
        <button onClick={() => setOpen(true)} style={openBtn}>
          💬 {title}
        </button>
      </div>
    );
  }

  return (
    <section style={{ marginTop: 32, border: "1px solid #ddd", borderRadius: 8, padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>💬 {title}</h2>
        <button onClick={() => setOpen(false)} style={linkBtn}>Hide</button>
      </div>

      <p style={{ color: "#666", fontSize: 13, marginTop: 6 }}>
        Answers use live platform data limited to what your role can see.
      </p>

      {messages.length === 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: "#666", marginBottom: 6 }}>Try asking:</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {suggestions.map((q) => (
              <button key={q} onClick={() => send(q)} style={chip}>{q}</button>
            ))}
          </div>
        </div>
      )}

      {messages.length > 0 && (
        <div ref={scrollRef} style={log}>
          {messages.map((m, i) => (
            <div key={i} style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 700 }}>You</div>
              <div style={{ marginBottom: 6 }}>{m.user}</div>
              <div style={{ fontWeight: 700 }}>Assistant</div>
              <div style={{ whiteSpace: "pre-wrap" }}>
                {m.bot === null ? <em style={{ color: "#888" }}>Thinking...</em> : m.bot}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Ask about compliance, safety, or your mine's data..."
          style={{ flex: 1, padding: 10 }}
          disabled={sending}
        />
        <button onClick={() => send()} disabled={sending} style={sendBtn}>
          {sending ? "..." : "Send"}
        </button>
      </div>

      {messages.length > 0 && (
        <button onClick={() => setMessages([])} style={{ ...linkBtn, marginTop: 8 }}>
          Clear conversation
        </button>
      )}
    </section>
  );
}

const log = {
  border: "1px solid #eee",
  borderRadius: 6,
  padding: 12,
  maxHeight: 320,
  overflowY: "auto",
  background: "#fafafa",
  fontSize: 14,
};
const chip = {
  padding: "6px 12px",
  borderRadius: 16,
  border: "1px solid #ccc",
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
};
const sendBtn = { padding: "10px 18px", cursor: "pointer" };
const openBtn = { padding: "10px 18px", cursor: "pointer", fontSize: 15 };
const linkBtn = {
  background: "none",
  border: "none",
  color: "#06c",
  cursor: "pointer",
  fontSize: 13,
  padding: 0,
};

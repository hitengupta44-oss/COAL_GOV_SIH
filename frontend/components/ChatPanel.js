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


// Minimal markdown rendering.
//
// The model's replies come back as markdown, and printing them raw meant
// users saw literal "**bold**" asterisks and pipe-delimited table rows --
// which looked broken. Rather than add a markdown library for the handful
// of constructs that actually show up here, this handles the common cases:
// bold, inline code, bullet lists, numbered lists and paragraph breaks.
// The backend system prompt also asks for plain prose over heavy nested
// formatting, so this only needs to cover the basics.
function renderInline(text, keyPrefix) {
  const nodes = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      nodes.push(<strong key={`${keyPrefix}-b${i++}`}>{tok.slice(2, -2)}</strong>);
    } else {
      nodes.push(
        <code key={`${keyPrefix}-c${i++}`} style={{ background: "#eee", padding: "1px 4px", borderRadius: 3 }}>
          {tok.slice(1, -1)}
        </code>
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function Markdown({ text }) {
  if (!text) return null;
  const lines = String(text).split("\n");
  const blocks = [];
  let list = null;

  const flush = () => {
    if (list) {
      blocks.push(
        <ul key={`ul-${blocks.length}`} style={{ margin: "6px 0", paddingLeft: 20 }}>
          {list.map((li, i) => <li key={i} style={{ marginBottom: 3 }}>{renderInline(li, `li${i}`)}</li>)}
        </ul>
      );
      list = null;
    }
  };

  lines.forEach((raw, i) => {
    const line = raw.trim();
    // Skip markdown table rows and separators: the panel is narrow and the
    // prompt discourages tables, but the model occasionally emits one and a
    // raw pipe row is worse than dropping it.
    if (/^\|?\s*[-:|\s]+\|/.test(line) && line.includes("|")) return;
    if (line.startsWith("|") && line.endsWith("|")) {
      flush();
      const cells = line.split("|").filter((c) => c.trim());
      blocks.push(
        <div key={`t-${i}`} style={{ marginBottom: 4 }}>
          {renderInline(cells.join(" — "), `t${i}`)}
        </div>
      );
      return;
    }
    if (!line) { flush(); return; }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    const numbered = line.match(/^\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      if (!list) list = [];
      list.push((bullet || numbered)[1]);
      return;
    }
    flush();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      blocks.push(
        <div key={`h-${i}`} style={{ fontWeight: 700, marginTop: 8, marginBottom: 2 }}>
          {renderInline(heading[1], `h${i}`)}
        </div>
      );
      return;
    }
    blocks.push(
      <p key={`p-${i}`} style={{ margin: "0 0 8px" }}>{renderInline(line, `p${i}`)}</p>
    );
  });
  flush();
  return <div>{blocks}</div>;
}

// Languages spoken across the Indian coalfields. The list is short on
// purpose: these cover the great majority of workers at CIL subsidiaries,
// and a picker with thirty entries is harder to use than one with six.
// Choosing a language appends an instruction to the question rather than
// changing any UI text -- the backend prompt already answers in whatever
// language it is asked in, so this is a shortcut for people whose
// keyboard is set to English.
const LANGUAGES = [
  ["en", "English"],
  ["hi", "हिन्दी"],
  ["bn", "বাংলা"],
  ["or", "ଓଡ଼ିଆ"],
  ["te", "తెలుగు"],
  ["mr", "मराठी"],
];

const LANG_INSTRUCTION = {
  hi: "Reply in Hindi.",
  bn: "Reply in Bengali.",
  or: "Reply in Odia.",
  te: "Reply in Telugu.",
  mr: "Reply in Marathi.",
};

export default function ChatPanel({ title = "Ask the Governance Assistant" }) {
  const { profile, getAccessToken } = useAuth();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [lang, setLang] = useState("en");
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
      const instruction = LANG_INSTRUCTION[lang];
      const reply = await chatWithAssistant(
        accessToken,
        instruction ? `${question}\n\n(${instruction})` : question,
        history
      );
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
    <section style={{ marginTop: 8, marginBottom: 20, background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--radius)", padding: "18px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>💬 {title}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <label style={{ fontSize: 13, color: "var(--ink-soft)" }}>
            <span style={{ marginRight: 6 }}>Language</span>
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              style={{ width: "auto", padding: "4px 8px", fontSize: 13 }}
            >
              {LANGUAGES.map(([code, name]) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </select>
          </label>
          <button onClick={() => setOpen(false)} style={linkBtn}>Hide</button>
        </div>
      </div>

      <p style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 6 }}>
        Answers use live platform data, limited to what your role can see.
      </p>

      {messages.length === 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 8 }}>Questions you can ask</div>
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
              <div>
                {m.bot === null
                  ? <em style={{ color: "var(--ink-faint)" }}>Working on it</em>
                  : <Markdown text={m.bot} />}
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
          style={{ flex: 1 }}
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
  border: "1px solid var(--line)",
  borderRadius: "var(--radius)",
  padding: 14,
  maxHeight: 340,
  overflowY: "auto",
  background: "var(--page)",
  fontSize: 14,
};
const chip = {
  padding: "6px 12px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--line-strong)",
  background: "var(--surface)",
  color: "var(--ink)",
  cursor: "pointer",
  fontSize: 13,
  textAlign: "left",
};
const sendBtn = {
  padding: "9px 18px", cursor: "pointer", background: "var(--primary)",
  color: "#fff", border: "1px solid var(--primary)", borderRadius: "var(--radius)", fontWeight: 500,
};
const openBtn = {
  padding: "9px 16px", cursor: "pointer", background: "var(--surface)",
  color: "var(--ink)", border: "1px solid var(--line-strong)",
  borderRadius: "var(--radius)", fontSize: 14, fontWeight: 500,
};
const linkBtn = {
  background: "none",
  border: "none",
  color: "var(--primary)",
  cursor: "pointer",
  fontSize: 13,
  padding: 0,
};

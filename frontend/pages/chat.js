import { useState } from "react";
import { chatWithAssistant } from "../lib/api";
import { useAuth } from "../lib/useAuth";

export default function Chat() {
  const { getAccessToken } = useAuth();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!input.trim()) return;
    const userMsg = input;
    setInput("");
    setSending(true);
    try {
      const accessToken = await getAccessToken();
      const reply = await chatWithAssistant(accessToken, userMsg, messages.map((m) => [m.user, m.bot]));
      setMessages((prev) => [...prev, { user: userMsg, bot: reply }]);
    } catch (e) {
      setMessages((prev) => [...prev, { user: userMsg, bot: `Error: ${e.message}` }]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ maxWidth: 700, margin: "40px auto", fontFamily: "sans-serif", padding: 16 }}>
      <h1>💬 Governance Assistant</h1>
      <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 16, minHeight: 300, marginBottom: 12 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 16 }}>
            <p><strong>You:</strong> {m.user}</p>
            <p><strong>Assistant:</strong> {m.bot}</p>
          </div>
        ))}
        {sending && <p style={{ color: "#666" }}>Thinking...</p>}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Ask about compliance, accidents, mine data..."
          style={{ flex: 1, padding: 10 }}
        />
        <button onClick={send} disabled={sending}>Send</button>
      </div>
    </div>
  );
}

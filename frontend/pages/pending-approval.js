import { useAuth } from "../lib/useAuth";

export default function PendingApproval() {
  const { user, logout } = useAuth();

  return (
    <div style={{ maxWidth: 520, margin: "80px auto", fontFamily: "sans-serif", textAlign: "center" }}>
      <h1>Account Pending Setup</h1>
      <p>
        You&apos;re signed in as <strong>{user?.email}</strong>, but no role has
        been assigned to your account yet.
      </p>
      <p style={{ color: "#666", fontSize: 14 }}>
        An admin needs to approve you from the Admin dashboard. Your account ID
        is <code>{user?.id}</code> if they ask for it.
      </p>
      <button onClick={logout} style={{ padding: "8px 16px", marginTop: 12 }}>
        Log Out
      </button>
    </div>
  );
}

import { useAuth } from "../lib/useAuth";
import { Button } from "../components/ui";

export default function PendingApproval() {
  const { user, logout } = useAuth();
  return (
    <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", padding: 32 }}>
      <div style={{ maxWidth: 460, background: "var(--surface)", border: "1px solid var(--line)", borderLeft: "3px solid var(--sev-medium)", borderRadius: "var(--radius)", padding: "28px 30px" }}>
        <h1 style={{ fontSize: 20 }}>Your account needs a role</h1>
        <p style={{ color: "var(--ink-soft)", fontSize: 14.5, marginTop: 10 }}>
          You&apos;re signed in as {user?.email}. An administrator assigns your role,
          which decides which mine and which records you can see. Until then there&apos;s
          no dashboard to show you.
        </p>
        <p style={{ color: "var(--ink-faint)", fontSize: 13.5 }}>
          If you&apos;re asked for your account reference, it&apos;s {user?.id}.
        </p>
        <div style={{ marginTop: 18 }}>
          <Button variant="secondary" onClick={logout}>Log out</Button>
        </div>
      </div>
    </div>
  );
}

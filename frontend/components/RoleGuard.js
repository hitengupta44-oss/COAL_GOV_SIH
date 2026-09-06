import { useEffect } from "react";
import { useRouter } from "next/router";
import { useAuth } from "../lib/useAuth";

/**
 * Wrap any dashboard page's content with this. Redirects to login if not
 * authenticated, to /pending-approval if no profile/role, and to /dashboard
 * (which re-routes correctly) if the user's actual role doesn't match
 * allowedRoles -- prevents a worker from typing /dashboard/corporate directly.
 */
export default function RoleGuard({ allowedRoles, children }) {
  const { user, profile, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    // `replace` rather than `push`: after signing out, the dashboard should
    // not sit in history for the back button to return to.
    if (loading) return;
    if (!user) return void router.replace("/login");
    if (!profile) return void router.replace("/pending-approval");
    if (!allowedRoles.includes(profile.role)) return void router.replace("/dashboard");
  }, [user, profile, loading, router, allowedRoles]);

  // Children are not rendered until user AND profile are both present, so
  // a page can never read profile.something during the gap between signing
  // out and the redirect landing.
  if (loading || !user || !profile || !allowedRoles.includes(profile.role)) {
    return <p style={{ padding: 40, color: "var(--ink-soft)" }}>Loading</p>;
  }

  return children;
}

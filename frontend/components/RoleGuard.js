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
    if (loading) return;
    if (!user) return router.push("/login");
    if (!profile) return router.push("/pending-approval");
    if (!allowedRoles.includes(profile.role)) return router.push("/dashboard");
  }, [user, profile, loading, router, allowedRoles]);

  if (loading || !user || !profile || !allowedRoles.includes(profile.role)) {
    return <p style={{ padding: 40, fontFamily: "sans-serif" }}>Loading...</p>;
  }

  return children;
}

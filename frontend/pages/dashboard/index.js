import { useEffect } from "react";
import { useRouter } from "next/router";
import { useAuth } from "../../lib/useAuth";

const ROLE_ROUTES = {
  worker: "/dashboard/worker",
  mine_official: "/dashboard/manager",
  inspector: "/dashboard/inspector",
  contractor_manager: "/dashboard/contractor-manager",
  corporate_admin: "/dashboard/corporate",
  regulator: "/dashboard/regulator",
  admin: "/dashboard/admin",
};

export default function DashboardRouter() {
  const { user, profile, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) return void router.push("/login");
    if (!profile) return void router.push("/pending-approval");
    router.push(ROLE_ROUTES[profile.role] || "/pending-approval");
  }, [user, profile, loading, router]);

  return (
    <p style={{ padding: 40, color: "var(--ink-soft)" }}>Taking you to your dashboard.</p>
  );
}

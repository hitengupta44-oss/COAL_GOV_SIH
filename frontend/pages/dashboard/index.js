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
    if (!user) {
      router.push("/login");
      return;
    }
    if (!profile) {
      router.push("/pending-approval");
      return;
    }
    const target = ROLE_ROUTES[profile.role] || "/pending-approval";
    router.push(target);
  }, [user, profile, loading, router]);

  return <p style={{ padding: 40, fontFamily: "sans-serif" }}>Loading your dashboard...</p>;
}

import { useEffect } from "react";
import { useRouter } from "next/router";
import { useAuth } from "../lib/useAuth";

export default function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.push(user ? "/dashboard" : "/login"); // /dashboard now auto-routes by role
  }, [user, loading, router]);

  return <p style={{ padding: 40, fontFamily: "sans-serif" }}>Loading...</p>;
}

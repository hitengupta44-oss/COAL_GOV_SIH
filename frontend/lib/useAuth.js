import { useEffect, useState, createContext, useContext } from "react";
import { supabase } from "./supabase";

// MIGRATION NOTE (Firebase -> Supabase Auth):
// This file previously used Firebase's onAuthStateChanged/signInWithEmailAndPassword
// and looked profiles up by `firebase_uid`. It now uses Supabase Auth end to end.
//
// Two things get simpler as a result:
//  1. There's one system of record instead of two. The user's id in
//     auth.users IS the id RLS policies see via auth.uid(), so the
//     database can enforce access itself (see supabase/schema.sql).
//  2. The access token is a Supabase JWT that the backend verifies with
//     the same Supabase project -- no Firebase Admin SDK, no service
//     account JSON secret to paste into Hugging Face.

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);       // Supabase auth user
  const [profile, setProfile] = useState(null); // user_profiles row (role, mine_id, ...)
  const [loading, setLoading] = useState(true);

  // Loads the user_profiles row for a given auth user id.
  // Note: RLS ("Read own profile") already restricts this to the caller's
  // own row, so this can't be used to enumerate other users.
  const loadProfile = async (uid) => {
    if (!uid) {
      setProfile(null);
      return;
    }
    // maybeSingle() instead of single(): a user with no profile row yet is
    // an expected state (they land on /pending-approval), not an error.
    const { data, error } = await supabase
      .from("user_profiles")
      .select("*")
      .eq("auth_uid", uid)
      .maybeSingle();

    if (error) {
      console.error("Failed to load profile:", error.message);
      setProfile(null);
    } else {
      setProfile(data);
    }
  };

  useEffect(() => {
    let active = true;

    // getSession() reads the session restored from storage on page load,
    // so a refresh doesn't bounce the user back to /login.
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!active) return;
      setUser(session?.user ?? null);
      await loadProfile(session?.user?.id);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!active) return;
      setUser(session?.user ?? null);
      await loadProfile(session?.user?.id);
      setLoading(false);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const login = async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  };

  // Self-service signup. Deliberately creates NO user_profiles row -- RLS
  // forbids that anyway (only admins may insert profiles), which is what
  // stops someone signing up and handing themselves the admin role. The
  // new user lands on /pending-approval until an admin assigns a role via
  // the admin dashboard. full_name is stashed in user_metadata so it shows
  // up as a prefilled hint in the admin's approval table.
  const signup = async (email, password, fullName) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName || null } },
    });
    if (error) throw error;
    return data;
  };

  // Sets loading=true BEFORE clearing user/profile. Without this there is a
  // render gap where a dashboard page is still mounted but profile has
  // become null, and anything reading profile.something throws a
  // client-side exception ("Application error: a client-side exception has
  // occurred") before RoleGuard's redirect effect gets a chance to run.
  // Holding loading=true keeps RoleGuard showing its placeholder until the
  // redirect lands. Pages also use optional chaining (profile?.x) as a
  // second layer of protection.
  const logout = async () => {
    setLoading(true);
    try {
      await supabase.auth.signOut();
    } finally {
      setUser(null);
      setProfile(null);
      setLoading(false);
    }
  };

  // Every backend call passes this token; backend/app.py verifies it
  // against the same Supabase project. The client auto-refreshes it near
  // expiry, so read it fresh before each request rather than caching it.
  const getAccessToken = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  };

  return (
    <AuthContext.Provider
      value={{ user, profile, loading, login, signup, logout, getAccessToken }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

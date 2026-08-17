import { createContext, useContext, useEffect, useState } from "react";
import { getCurrentUser, login as apiLogin, signup as apiSignup, logout as apiLogout } from "../api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // true only during the initial /auth/me check on mount -- distinguishes
  // "still finding out if there's a session" from "confirmed logged out",
  // so the UI doesn't flash the login screen before the check resolves
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCurrentUser()
      .then(setUser)
      .finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    const loggedInUser = await apiLogin(email, password);
    setUser(loggedInUser);
  };

  const signup = async (email, password, name) => {
    const newUser = await apiSignup(email, password, name);
    setUser(newUser);
  };

  const logout = async () => {
    await apiLogout();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

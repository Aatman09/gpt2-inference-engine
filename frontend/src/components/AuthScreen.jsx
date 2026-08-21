import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { getAuthConfig, googleLoginUrl } from "../api";
import { ArrowRightIcon, SunIcon, MoonIcon, GoogleIcon } from "./icons";

// error codes set by /auth/google/callback when the flow fails; mapped to
// readable text here rather than shown raw
const GOOGLE_ERRORS = {
  google_denied: "Google sign-in was cancelled.",
  invalid_state: "Google sign-in expired or was invalid. Please try again.",
  google_failed: "Could not sign in with Google. Please try again.",
};

// mode comes from the route (/login vs /signup) rather than internal state,
// so each has its own URL and the browser back button behaves sensibly
export default function AuthScreen({ mode = "login" }) {
  const { login, signup } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [searchParams] = useSearchParams();
  const [googleEnabled, setGoogleEnabled] = useState(false);

  // ask the server whether it has OAuth credentials before offering the
  // button; failures leave it hidden, which is the safe default
  useEffect(() => {
    let active = true;
    getAuthConfig()
      .then((cfg) => active && setGoogleEnabled(Boolean(cfg.google_enabled)))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const isSignup = mode === "signup";

  // the OAuth callback can only report failure by redirecting back here with
  // a query param -- it is a browser navigation, not a fetch, so there is no
  // response body for the UI to read
  const oauthError = GOOGLE_ERRORS[searchParams.get("error")];

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (isSignup) await signup(email, password, name);
      else await login(email, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-screen">
      <Link to="/" className="auth-back">achat</Link>

      <button
        type="button"
        className="rail-link auth-theme-toggle"
        onClick={toggleTheme}
        aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      >
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>

      <form className="auth-card" onSubmit={handleSubmit}>
        <div>
          <h2>{isSignup ? "Create an account" : "Welcome back"}</h2>
          <p className="auth-subtitle">
            {isSignup
              ? "Sign up to start chatting with your own GPT-2."
              : "Sign in to pick up where you left off."}
          </p>
        </div>

        {isSignup && (
          <div className="field">
            <label htmlFor="auth-name">Name</label>
            <input
              id="auth-name"
              className="input"
              type="text"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
            />
          </div>
        )}

        <div className="field">
          <label htmlFor="auth-email">Email</label>
          <input
            id="auth-email"
            className="input"
            type="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </div>

        <div className="field">
          <label htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            className="input"
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete={isSignup ? "new-password" : "current-password"}
          />
        </div>

        {(error || oauthError) && (
          <div className="auth-error">{error || oauthError}</div>
        )}

        <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
          {submitting ? "…" : isSignup ? "Sign up" : "Sign in"}
          <ArrowRightIcon />
        </button>

        {googleEnabled && (
          <>
            <div className="auth-divider">or</div>
            <a
              className="btn btn-ghost btn-block"
              href={googleLoginUrl()}
              style={{ textDecoration: "none" }}
            >
              <GoogleIcon />
              Continue with Google
            </a>
          </>
        )}

        <div className="auth-links">
          <span className="text-muted">
            {isSignup ? "Already have an account?" : "New here?"}
          </span>
          <Link to={isSignup ? "/login" : "/signup"}>
            {isSignup ? "Sign in" : "Create account"}
          </Link>
        </div>
      </form>
    </div>
  );
}

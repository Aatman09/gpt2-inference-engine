import { createContext, useContext, useEffect, useState } from "react";

const ThemeContext = createContext(null);

// Dark unless the user has explicitly chosen otherwise, or their OS says
// light and they've never chosen -- stored choice always wins.
function initialTheme() {
  const stored = localStorage.getItem("theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function initialFont() {
  const stored = localStorage.getItem("font");
  return stored === "serif" || stored === "mono" ? stored : "system";
}

function initialZoom() {
  const stored = Number(localStorage.getItem("zoom"));
  return stored >= 80 && stored <= 150 ? stored : 100;
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(initialTheme);
  const [font, setFont] = useState(initialFont);
  const [zoom, setZoom] = useState(initialZoom);

  // the palettes key off <html data-theme> (see index.css)
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  // reading face via <html data-font>, so every surface follows it
  useEffect(() => {
    document.documentElement.setAttribute("data-font", font);
    localStorage.setItem("font", font);
  }, [font]);

  // Text size, not zoom. CSS `zoom` scaled the entire interface -- padding,
  // controls, the drawer -- so bigger text also meant bigger chrome and no
  // more words per line. This scales only the type ramp (index.css reads
  // --text-scale into every --text-* step), so larger text actually fills
  // the space it is given instead of inflating the box around it.
  useEffect(() => {
    document.documentElement.style.removeProperty("zoom");
    document.documentElement.style.setProperty("--text-scale", String(zoom / 100));
    localStorage.setItem("zoom", String(zoom));
  }, [zoom]);

  const toggleTheme = () => setTheme((prev) => (prev === "dark" ? "light" : "dark"));

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, font, setFont, zoom, setZoom }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

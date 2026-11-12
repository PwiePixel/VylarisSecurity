"use client";

import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";

type Mode = "light" | "dark" | "system";
const KEY = "vd-theme";

const options: readonly { mode: Mode; label: string; icon: IconName }[] = [
  { mode: "light", label: "Hell", icon: "sun" },
  { mode: "dark", label: "Dunkel", icon: "moon" },
  { mode: "system", label: "System", icon: "monitor" },
];

function apply(mode: Mode) {
  const dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

/** Umschalter Hell / Dunkel / System. Die Auswahl bleibt nur lokal im Browser gespeichert. */
export function ThemeSwitch() {
  const [mode, setMode] = useState<Mode>("system");

  useEffect(() => {
    let stored: Mode = "system";
    try {
      const v = localStorage.getItem(KEY);
      if (v === "light" || v === "dark" || v === "system") stored = v;
    } catch {
      /* Speicher nicht verfügbar */
    }
    setMode(stored);
  }, []);

  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  const choose = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(KEY, m);
    } catch {
      /* ignorieren */
    }
    apply(m);
  };

  return (
    <div className="theme" role="group" aria-label="Darstellung">
      {options.map((o) => (
        <button key={o.mode} type="button" aria-pressed={mode === o.mode} title={o.label} onClick={() => choose(o.mode)}>
          <Icon name={o.icon} />
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Läuft vor dem ersten Rendern, damit es kein Aufblitzen im falschen Design gibt. */
export const themeInitScript = `(function(){try{var t=localStorage.getItem("${KEY}");var d=t==="dark"||((t===null||t==="system")&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.setAttribute("data-theme",d?"dark":"light")}catch(e){}})();`;

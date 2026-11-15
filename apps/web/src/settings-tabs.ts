// Tabs on the settings page. The chosen tab lives in the URL hash so a reload stays on it.

export const SETTINGS_TABS = [
  { id: "anbindungen", label: "Anbindungen" },
  { id: "marktplaetze", label: "Marktplätze" },
  { id: "system", label: "System" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];
export const DEFAULT_SETTINGS_TAB: SettingsTab = "anbindungen";

/** The settings tab named by a URL hash ("#marktplaetze"), or null if the hash names none. */
export function parseSettingsTab(hash: string): SettingsTab | null {
  const raw = decodeURIComponent(hash.replace(/^#/, "")).trim().toLowerCase();
  // "#weitere" was the old name of the System tab; old links keep working.
  const id = raw === "weitere" ? "system" : raw;
  return SETTINGS_TABS.find((t) => t.id === id)?.id ?? null;
}

export function settingsHash(tab: SettingsTab): string {
  return `#${tab}`;
}

/** Number of cards with an error per tab, shown as a small red count on the tab. */
export function tabAlerts(setups: { anbindungen: ReadonlyArray<{ error: string | null }>; marktplaetze: ReadonlyArray<{ error: string | null }> }): Record<SettingsTab, number> {
  return {
    anbindungen: setups.anbindungen.filter((s) => s.error).length,
    marktplaetze: setups.marktplaetze.filter((s) => s.error).length,
    system: 0,
  };
}

import { createContext, useContext, useState, type ReactNode } from "react";

interface AppContextValue {
  selectedAppId: number | null;
  setSelectedAppId: (id: number | null) => void;
  selectedAppSlug: string | null;
  setSelectedAppSlug: (slug: string | null) => void;
  selectedAgentId: number | null;
  setSelectedAgentId: (id: number | null) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [selectedAppId, setSelectedAppId] = useState<number | null>(null);
  const [selectedAppSlug, setSelectedAppSlug] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);

  return (
    <AppContext.Provider
      value={{
        selectedAppId,
        setSelectedAppId,
        selectedAppSlug,
        setSelectedAppSlug,
        selectedAgentId,
        setSelectedAgentId,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext must be used within AppProvider");
  return ctx;
}

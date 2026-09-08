import { Link, useLocation } from "wouter";
import { LayoutDashboard, Grid3x3, Bot, Settings, LogOut, FlaskConical, MonitorSmartphone, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { useAppContext } from "@/contexts/AppContext";

const NAV_ITEMS = [
  { href: "/", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/apps", icon: Grid3x3, label: "Apps" },
  { href: "/agents", icon: Bot, label: "Agent Builder" },
  { href: "/playground", icon: FlaskConical, label: "Playground" },
  // Opens in its own tab: it renders a bare page so the embed widget sits where
  // a visitor would meet it, which the dashboard shell would otherwise crop.
  { href: "/preview", icon: MonitorSmartphone, label: "Client Preview", newTab: true },
  { href: "/settings", icon: Settings, label: "Settings" },
];

const NAV_ITEM_CLASSES =
  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user } = useAuth();
  const { selectedAppId } = useAppContext();

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="flex w-60 flex-col border-r bg-card">
        <div className="flex h-14 items-center border-b px-4">
          <span className="text-lg font-bold">Bionic AI</span>
        </div>

        <nav className="flex-1 space-y-1 p-3">
          {NAV_ITEMS.map((item) => {
            const inactiveClasses =
              "text-muted-foreground hover:bg-accent/50 hover:text-foreground";

            // A new tab starts with an empty AppContext, so carry the app the
            // user is already working in through the URL.
            if (item.newTab) {
              const href =
                selectedAppId !== null ? `${item.href}?app=${selectedAppId}` : item.href;
              return (
                <a
                  key={item.href}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(NAV_ITEM_CLASSES, inactiveClasses)}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                  <ExternalLink className="ml-auto h-3 w-3 opacity-60" />
                </a>
              );
            }

            const isActive =
              item.href === "/"
                ? location === "/"
                : location.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href}>
                <div
                  className={cn(
                    NAV_ITEM_CLASSES,
                    isActive ? "bg-accent text-accent-foreground" : inactiveClasses,
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </div>
              </Link>
            );
          })}
        </nav>

        {/* User info */}
        <div className="border-t p-3">
          <div className="flex items-center gap-2 rounded-md px-3 py-2 text-sm">
            <div className="flex-1 truncate">
              <p className="font-medium truncate">{user?.name || "User"}</p>
              <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
            </div>
            <button
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" });
                window.location.href = "/";
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}

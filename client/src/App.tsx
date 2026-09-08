import { Route, Switch, Redirect } from "wouter";
import { Toaster } from "sonner";
import { AppProvider } from "./contexts/AppContext";
import { useAuth } from "./hooks/useAuth";
import DashboardLayout from "./components/DashboardLayout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Apps from "./pages/Apps";
import AgentBuilder from "./pages/AgentBuilder";
import Playground from "./pages/Playground";
import ClientPreview from "./pages/ClientPreview";
import Settings from "./pages/Settings";

function AuthenticatedApp() {
  return (
    <AppProvider>
      {/* /preview stands in for a customer's website, so it renders without the
          dashboard shell: the embed widget is position:fixed and must own the
          whole viewport to sit where it really sits. It opens in its own tab
          from the sidebar. */}
      <Switch>
        <Route path="/preview" component={ClientPreview} />
        <Route>
          <DashboardLayout>
            <Switch>
              <Route path="/" component={Dashboard} />
              <Route path="/apps" component={Apps} />
              <Route path="/apps/:slug" component={Apps} />
              <Route path="/agents" component={AgentBuilder} />
              <Route path="/playground" component={Playground} />
              <Route path="/settings" component={Settings} />
              <Route>
                <Redirect to="/" />
              </Route>
            </Switch>
          </DashboardLayout>
        </Route>
      </Switch>
    </AppProvider>
  );
}

export default function App() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-foreground" />
      </div>
    );
  }

  return (
    <>
      <Toaster theme="dark" position="top-right" />
      {isAuthenticated ? <AuthenticatedApp /> : <Login />}
    </>
  );
}

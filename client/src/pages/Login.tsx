import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function Login() {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <Card className="w-[400px]">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Bionic AI Platform</CardTitle>
          <CardDescription>
            Sign in to manage your AI agents and applications
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            className="w-full"
            size="lg"
            onClick={() => {
              window.location.href = "/api/auth/login";
            }}
          >
            Sign in with Keycloak
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

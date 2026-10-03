import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import SignOutButton from "@/components/sign-out-button";
import Inbox from "@/components/inbox";
import SettingsButton from "@/components/settings-button";
import { ThemeToggle } from "@/components/theme-toggle";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <main className="min-h-screen bg-background flex flex-col">
      <header className="border-b px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex flex-col leading-tight">
          <h1 className="text-3xl font-bold tracking-wide">Echo</h1>
          <span className="text-sm text-muted-foreground tracking-wide hidden sm:inline">Replies drafted for you, sent by you</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{user.email}</span>
          <ThemeToggle />
          <SettingsButton />
          <SignOutButton />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <Inbox userEmail={user.email ?? ""} />
      </div>
    </main>
  );
}

import SessionProvider from "@/components/session-provider";
import "./globals.css";
import type { Metadata } from "next";
import { authOptions } from "./api/auth/[...nextauth]/route";
import Header from "@/components/header";
import Sidebar from "@/components/side-bar";
import { getServerSession } from "next-auth";
import ThemeRegistry from "@/theme/theme-registry";

export const metadata: Metadata = {
  title: "Create Next App",
  description: "Generated by create next app",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);

  return (
    <html lang="en">
      <body>
        <ThemeRegistry>
          <SessionProvider session={session}>
            {session?.sub ? (
              <div style={{ display: "flex", minHeight: "100vh" }}>
                <Sidebar />
                <div style={{ flexGrow: 1, overflow: "auto" }}>
                  <Header />
                  {children}
                </div>
              </div>
            ) : (
              <>{children}</>
            )}
          </SessionProvider>
        </ThemeRegistry>
      </body>
    </html>
  );
}
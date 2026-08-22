import "./globals.css";
import { ChatHeader } from "./chat-header";

export const metadata = { title: "Cortex" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ChatHeader />
        {children}
      </body>
    </html>
  );
}

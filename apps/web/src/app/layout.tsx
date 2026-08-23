import type { Viewport } from "next";
import "./globals.css";
import { ChatHeader } from "./chat-header";

export const metadata = { title: "Cortex" };

/**
 * The App Router emits `<meta name="viewport">` from this export and from nothing else. Without
 * it there is no tag at all, and a phone browser falls back to a ~980px layout viewport and
 * scales the page down -- which is what "web khi xài ở đt bị break UI" was (reported
 * 2026-08-23). `100dvh` on body is measured against the same viewport, so the composer did not
 * sit at the visible bottom of the screen either.
 *
 * `maximumScale`/`userScalable` are deliberately absent: capping zoom on an app that is nothing
 * but text is an accessibility regression, and iOS ignores it in any case. See layout.test.tsx.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The composer is pinned to the bottom edge, which on a gesture-navigation phone is where the
  // system bar is drawn. `cover` is what makes env(safe-area-inset-bottom) resolve to a real
  // number so .chat-composer can pad for it instead of sitting under it.
  viewportFit: "cover",
};

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

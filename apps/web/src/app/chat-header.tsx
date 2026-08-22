"use client";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * The only chrome left. Product name, a connection dot, and one menu holding sign-out.
 *
 * Sign-out lives here because Sidebar held it and Sidebar is gone -- there is no other surface
 * left to put it on, and an app you cannot sign out of is not shippable.
 *
 * The connection dot is not decoration either. `ExportButton`'s label was the plainest proof
 * that the client was online -- e2e keyed on it -- and export went with the sidebar. This is
 * its replacement, for the user and for the suite.
 *
 * Renders nothing on `/login` (final whole-branch review finding): the root layout mounts this
 * unconditionally, and a signed-out visitor was getting a sign-out menu for a session that
 * doesn't exist. Checked with `usePathname` here rather than moving the mount out of
 * `layout.tsx`, since that layout is a server component and this is the one place already
 * paying the "use client" cost.
 */
export function ChatHeader() {
  const pathname = usePathname();
  const [online, setOnline] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  if (pathname?.startsWith("/login")) return null;

  return (
    <header className="chat-header">
      <span className="chat-title">Cortex</span>
      {!online && (
        <span className="conn offline" data-testid="conn-status" role="status">Ngoại tuyến</span>
      )}
      {online && <span className="conn online" data-testid="conn-status" hidden>Trực tuyến</span>}
      <button
        type="button" className="menu-toggle" aria-haspopup="menu" aria-expanded={menuOpen}
        aria-label="Menu" onClick={() => setMenuOpen((v) => !v)}
      >
        ⋮
      </button>
      {menuOpen && (
        <form className="chat-menu" role="menu" action="/auth/signout" method="post">
          <button type="submit" role="menuitem">Đăng xuất</button>
        </form>
      )}
    </header>
  );
}

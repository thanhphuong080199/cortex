"use client";

// A Server Component page can hand a Client Component a plain value (the session token) but
// not a plain closure -- passing a non-"use server" function across that boundary is a build
// error in Next.js. So page.tsx stays a server component (matching notes/[id]/page.tsx: same
// getUser()/getSession()/redirect("/login") pattern) and hands this thin client wrapper the
// token; this is the only piece that builds the real onSearch, keeping SearchForm itself free
// of fetch and therefore testable by injecting a fake onSearch (search-form.test.tsx).
import { api } from "@/lib/api";
import { SearchForm } from "./search-form";

export function SearchClient({ token }: { token: string }) {
  return <SearchForm onSearch={(q) => api.search(token, { q })} />;
}

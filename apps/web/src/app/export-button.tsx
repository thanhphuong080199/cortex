"use client";
import { useState } from "react";

export function ExportButton({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);

  // GET /export needs a bearer header, so a plain <a href> cannot work (spec §4.3):
  // fetch → blob → object URL → programmatic download.
  async function download() {
    setBusy(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/export`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { alert("Export failed. Please try again."); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.headers.get("content-disposition")?.match(/filename="(.+)"/)?.[1] ?? "cortex-export.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("Export failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return <button disabled={busy} onClick={() => void download()}>{busy ? "Exporting…" : "Export all"}</button>;
}

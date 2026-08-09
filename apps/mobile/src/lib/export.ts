import { Directory, File, Paths } from "expo-file-system";
import { isAvailableAsync, shareAsync } from "expo-sharing";

/**
 * Export is inherently ONLINE: `GET /export` streams a server-generated zip and nothing local
 * can produce one (spec §0 footnote). Parity means the feature exists, not that it works
 * offline — the caller disables the button with an explanation rather than failing on tap.
 */
export interface ExportDeps {
  /** The user's access token, or null when signed out. */
  token: string | null;
  apiUrl: string | undefined;
}

export class ExportError extends Error {}

/** `cortex-export-2026-08-03.zip` — the same name the server's Content-Disposition uses. */
export function exportFilename(now: Date = new Date()): string {
  return `cortex-export-${now.toISOString().slice(0, 10)}.zip`;
}

/**
 * Downloads the archive and hands it to the OS share sheet.
 *
 * Written to the CACHE directory, not documents: the file exists only to be handed to another
 * app, the OS reclaims cache under pressure, and a growing pile of multi-megabyte archives in
 * permanent storage on a device we already ask to hold the whole corpus is the wrong trade.
 *
 * `File.downloadFileAsync` streams the response into the file on Android rather than buffering
 * it, which matters because the server deliberately streams the zip to keep its own memory flat.
 */
export async function exportArchive(deps: ExportDeps): Promise<void> {
  if (!deps.token) throw new ExportError("not signed in");
  if (!deps.apiUrl) throw new ExportError("no API URL configured");

  // BEFORE the download, not after. This is a cheap local call and the transfer is several
  // megabytes; checked afterwards, a device with no share sheet pays for the whole thing
  // before being told the feature cannot work on it.
  if (!(await isAvailableAsync())) {
    throw new ExportError("sharing is not available on this device");
  }

  const destination = new File(Paths.cache, exportFilename());
  // A previous export of the same day would otherwise make the download fail outright.
  if (destination.exists) destination.delete();

  let file: { uri: string };
  try {
    file = await File.downloadFileAsync(
      `${deps.apiUrl}/export`,
      new Directory(Paths.cache),
      { headers: { Authorization: `Bearer ${deps.token}` }, idempotent: true },
    );
  } catch (err) {
    // downloadFileAsync STREAMS into the file, so a mid-flight failure leaves a partial zip
    // behind. The same-day clear above means the next attempt recovers -- but until then the
    // share sheet would hand another app a truncated archive indistinguishable from a
    // complete export.
    //
    // Unconditional, not `if (destination.exists)`: delete() on a file that is not there throws
    // and this catch already absorbs that, so the existence check would buy nothing but a stat
    // call. Best-effort either way -- a cleanup failure must never replace the download error,
    // which is the one the caller has to see.
    try { destination.delete(); } catch { /* keep the original error */ }
    throw err;
  }

  await shareAsync(file.uri, {
    mimeType: "application/zip",
    dialogTitle: "Export all notes",
  });
}

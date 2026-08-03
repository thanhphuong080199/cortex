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

  const destination = new File(Paths.cache, exportFilename());
  // A previous export of the same day would otherwise make the download fail outright.
  if (destination.exists) destination.delete();

  const file = await File.downloadFileAsync(
    `${deps.apiUrl}/export`,
    new Directory(Paths.cache),
    { headers: { Authorization: `Bearer ${deps.token}` }, idempotent: true },
  );

  // If the share sheet is unavailable the file is still sitting in a cache the user cannot
  // reach, so say so rather than reporting a success they cannot act on.
  if (!(await isAvailableAsync())) {
    throw new ExportError("sharing is not available on this device");
  }
  await shareAsync(file.uri, {
    mimeType: "application/zip",
    dialogTitle: "Export all notes",
  });
}

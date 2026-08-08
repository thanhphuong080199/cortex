import { beforeEach, describe, expect, it, vi } from "vitest";

const deleted: string[] = [];
let cacheHas = new Set<string>();
// Sequence, not just call counts. `wipe.test.ts` uses the same pattern: several of the
// properties here ("clears the stale file BEFORE downloading over it") are orderings, and an
// assertion that only counts calls holds just as well for the order that destroys the download.
const order: string[] = [];
const downloadFileAsync = vi.fn(async () => {
  order.push("download");
  return { uri: "file:///cache/cortex-export.zip" };
});

vi.mock("expo-file-system", () => ({
  Paths: { cache: "/cache/" },
  Directory: class {
    constructor(readonly path: string) {}
  },
  File: class {
    static downloadFileAsync = downloadFileAsync;
    readonly path: string;
    constructor(dir: string, name: string) {
      this.path = `${dir}${name}`;
    }
    get exists() {
      return cacheHas.has(this.path);
    }
    delete() {
      order.push("delete");
      deleted.push(this.path);
      cacheHas.delete(this.path);
    }
  },
}));

const shareAsync = vi.fn(async () => {});
const isAvailableAsync = vi.fn(async () => true);
vi.mock("expo-sharing", () => ({ shareAsync, isAvailableAsync }));

const { ExportError, exportArchive, exportFilename } = await import("./export.js");

const deps = { token: "jwt", apiUrl: "https://api.test" };

beforeEach(() => {
  deleted.length = 0;
  order.length = 0;
  cacheHas = new Set();
  downloadFileAsync.mockClear();
  downloadFileAsync.mockImplementation(async () => {
    order.push("download");
    return { uri: "file:///cache/cortex-export.zip" };
  });
  shareAsync.mockClear();
  isAvailableAsync.mockClear();
  isAvailableAsync.mockResolvedValue(true);
});

describe("exportFilename", () => {
  it("matches the name the server's Content-Disposition uses", () => {
    // The controller builds `cortex-export-${new Date().toISOString().slice(0,10)}.zip`.
    expect(exportFilename(new Date("2026-08-03T15:04:05.000Z"))).toBe(
      "cortex-export-2026-08-03.zip",
    );
  });
});

describe("exportArchive", () => {
  it("sends the user's token and downloads to the cache directory", async () => {
    await exportArchive(deps);

    const [url, destination, options] = downloadFileAsync.mock.calls[0] as unknown as [
      string,
      { path?: string; uri?: string },
      { headers: Record<string, string> },
    ];
    expect(url).toBe("https://api.test/export");
    // Without the header the endpoint answers 401 and the "archive" is an error body.
    expect(options.headers.Authorization).toBe("Bearer jwt");
    // The destination was previously skipped by an empty hole in this destructure, so the test
    // named "downloads to the cache directory" never looked at the directory. A regression to
    // Paths.document -- the trade export.ts spends a paragraph rejecting, because the file
    // exists only to be handed to another app -- passed it unchanged.
    expect(destination.path).toBe("/cache/");
  });

  it("deletes under the same name the server will send", () => {
    // The download target is the cache DIRECTORY; the filename comes from the server's
    // Content-Disposition (`cortex-export-<date>.zip`, export.controller.ts:15). So the
    // same-day cleanup below only clears the right file while these two agree, and both
    // derive the date from toISOString() in UTC. Pinned here because the coupling is
    // invisible at either site on its own.
    expect(exportFilename(new Date("2026-08-03T23:30:00.000Z"))).toBe(
      "cortex-export-2026-08-03.zip",
    );
  });

  it("hands the downloaded file to the share sheet", async () => {
    await exportArchive(deps);

    expect(shareAsync).toHaveBeenCalledWith("file:///cache/cortex-export.zip", {
      mimeType: "application/zip",
      dialogTitle: "Export all notes",
    });
  });

  it("clears a same-day export before downloading over it", async () => {
    cacheHas.add("/cache/cortex-export.zip");
    cacheHas.add(`/cache/${exportFilename()}`);

    await exportArchive(deps);

    // A second export on the same date reuses the filename; left in place it makes the
    // download fail rather than replace it.
    expect(deleted).toContain(`/cache/${exportFilename()}`);
    // BEFORE, which is the whole point of the test's name: a delete moved after the download
    // erases the file just written, and passed this test while doing it.
    expect(order.indexOf("delete")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("delete")).toBeLessThan(order.indexOf("download"));
  });

  it("refuses to export when signed out", async () => {
    await expect(exportArchive({ ...deps, token: null })).rejects.toBeInstanceOf(ExportError);
    expect(downloadFileAsync).not.toHaveBeenCalled();
  });

  it("refuses to export with no API URL configured", async () => {
    await expect(exportArchive({ ...deps, apiUrl: undefined })).rejects.toThrow("API URL");
    // Otherwise the request goes to "undefined/export" and fails as a network error, which
    // reads like being offline rather than like being misconfigured.
    expect(downloadFileAsync).not.toHaveBeenCalled();
  });

  it("reports when the file cannot be shared rather than claiming success", async () => {
    isAvailableAsync.mockResolvedValueOnce(false);

    // The archive is real but sitting in a cache directory the user cannot reach, so a silent
    // success would be a lie about where their data went.
    await expect(exportArchive(deps)).rejects.toThrow("sharing is not available");
    // And nothing was downloaded to get here. isAvailableAsync is a cheap local call while the
    // transfer is several megabytes; checked afterwards, a device with no share sheet paid for
    // the whole thing before being told the feature cannot work on it.
    expect(downloadFileAsync).not.toHaveBeenCalled();
  });

  it("propagates a failed download instead of sharing nothing", async () => {
    downloadFileAsync.mockRejectedValueOnce(new Error("UnableToDownload: 500"));

    await expect(exportArchive(deps)).rejects.toThrow("UnableToDownload");
    expect(shareAsync).not.toHaveBeenCalled();
  });

  /**
   * `File.downloadFileAsync` streams into the file, so a mid-flight failure leaves a partial
   * zip in cache. Line 38's same-day clear means the NEXT export recovers -- but in between,
   * the share sheet would hand another app a truncated archive indistinguishable from a
   * complete one.
   *
   * `cacheHas` is deliberately NOT seeded. Seeding it would make the pre-download same-day
   * clear fire, push the path into `deleted`, and the assertion below would then hold with or
   * without the cleanup -- the mock's `delete()` records the path regardless of who called it.
   */
  it("removes the partial file when the download fails", async () => {
    downloadFileAsync.mockRejectedValueOnce(new Error("connection reset"));

    await expect(exportArchive(deps)).rejects.toThrow("connection reset");

    expect(deleted).toEqual([`/cache/${exportFilename()}`]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const deleted: string[] = [];
let cacheHas = new Set<string>();
const downloadFileAsync = vi.fn(async () => ({ uri: "file:///cache/cortex-export.zip" }));

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
  cacheHas = new Set();
  downloadFileAsync.mockClear();
  downloadFileAsync.mockResolvedValue({ uri: "file:///cache/cortex-export.zip" });
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

    const [url, , options] = downloadFileAsync.mock.calls[0] as unknown as [
      string,
      unknown,
      { headers: Record<string, string> },
    ];
    expect(url).toBe("https://api.test/export");
    // Without the header the endpoint answers 401 and the "archive" is an error body.
    expect(options.headers.Authorization).toBe("Bearer jwt");
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
  });

  it("propagates a failed download instead of sharing nothing", async () => {
    downloadFileAsync.mockRejectedValueOnce(new Error("UnableToDownload: 500"));

    await expect(exportArchive(deps)).rejects.toThrow("UnableToDownload");
    expect(shareAsync).not.toHaveBeenCalled();
  });
});

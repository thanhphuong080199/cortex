// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchForm } from "./search-form";

const results = [
  { noteId: "n1", title: "Trust", snippet: "charging more made people trust it more", score: 0.9, matchedBy: "vector" },
];

describe("SearchForm", () => {
  it("does not search until submit — every query costs an embedding call", async () => {
    const search = vi.fn();
    render(<SearchForm onSearch={search} />);
    await userEvent.type(screen.getByRole("searchbox"), "pricing");
    expect(search).not.toHaveBeenCalled();
  });

  it("searches on submit and renders the results", async () => {
    const search = vi.fn().mockResolvedValue(results);
    render(<SearchForm onSearch={search} />);
    await userEvent.type(screen.getByRole("searchbox"), "pricing psychology{Enter}");
    await waitFor(() => expect(screen.getByText(/charging more/)).toBeInTheDocument());
    expect(search).toHaveBeenCalledWith("pricing psychology");
  });

  it("says why a result matched, so a semantic hit is not mistaken for a typo", async () => {
    render(<SearchForm onSearch={vi.fn().mockResolvedValue(results)} />);
    await userEvent.type(screen.getByRole("searchbox"), "x{Enter}");
    // Anchored, not `/by meaning/i`: that substring also matches "by meaning and wording"
    // (matchedBy "both"), so it wouldn't actually distinguish "vector" from "both".
    await waitFor(() => expect(screen.getByText(/^by meaning$/i)).toBeInTheDocument());
  });

  it("labels a hybrid match distinctly from a pure-vector one", async () => {
    const hybrid = [{ ...results[0]!, noteId: "n2", matchedBy: "both" }];
    render(<SearchForm onSearch={vi.fn().mockResolvedValue(hybrid)} />);
    await userEvent.type(screen.getByRole("searchbox"), "x{Enter}");
    await waitFor(() => expect(screen.getByText(/^by meaning and wording$/i)).toBeInTheDocument());
  });

  it("falls back to the raw matchedBy value when it doesn't recognize it", async () => {
    const odd = [{ ...results[0]!, noteId: "n3", matchedBy: "keyword" }];
    render(<SearchForm onSearch={vi.fn().mockResolvedValue(odd)} />);
    await userEvent.type(screen.getByRole("searchbox"), "x{Enter}");
    await waitFor(() => expect(screen.getByText("keyword")).toBeInTheDocument());
  });

  it("shows Untitled for a result with no title, instead of an empty link", async () => {
    const untitled = [{ ...results[0]!, noteId: "n4", title: null }];
    render(<SearchForm onSearch={vi.fn().mockResolvedValue(untitled)} />);
    await userEvent.type(screen.getByRole("searchbox"), "x{Enter}");
    await waitFor(() => expect(screen.getByText("Untitled")).toBeInTheDocument());
  });

  it("reports an empty result rather than rendering nothing", async () => {
    render(<SearchForm onSearch={vi.fn().mockResolvedValue([])} />);
    await userEvent.type(screen.getByRole("searchbox"), "nothing{Enter}");
    await waitFor(() => expect(screen.getByText(/no notes matched/i)).toBeInTheDocument());
  });

  it("surfaces a failure instead of looking like an empty result", async () => {
    render(<SearchForm onSearch={vi.fn().mockRejectedValue(new Error("boom"))} />);
    await userEvent.type(screen.getByRole("searchbox"), "x{Enter}");
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });
});

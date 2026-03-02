import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithContext } from "../../test/renderWithContext";
import RecentActivity from "../RecentActivity";

describe("RecentActivity", () => {
  it("renders the title", () => {
    renderWithContext(<RecentActivity />);
    expect(screen.getByText("Recent Activity")).toBeInTheDocument();
  });

  it("shows empty state when no transactions", () => {
    renderWithContext(<RecentActivity />);
    expect(screen.getByText("No activity yet")).toBeInTheDocument();
  });

  it("renders Refresh button", () => {
    renderWithContext(<RecentActivity />);
    expect(screen.getByText("Refresh")).toBeInTheDocument();
  });

  it("renders pagination controls", () => {
    renderWithContext(<RecentActivity />);
    expect(screen.getByText("Prev")).toBeInTheDocument();
    expect(screen.getByText("Next")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
  });

  it("disables both pagination buttons when no data", () => {
    renderWithContext(<RecentActivity />);
    expect(screen.getByText("Prev").closest("button")).toBeDisabled();
    expect(screen.getByText("Next").closest("button")).toBeDisabled();
  });
});

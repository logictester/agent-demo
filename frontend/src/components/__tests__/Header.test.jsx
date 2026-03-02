import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithContext } from "../../test/renderWithContext";
import Header from "../Header";

describe("Header", () => {
  beforeEach(() => localStorage.clear());

  it("renders the brand name", () => {
    renderWithContext(<Header onOpenSettings={() => {}} />);
    expect(screen.getByText("Helio Bank | AI Demo")).toBeInTheDocument();
  });

  it('shows "Guest User" when not logged in', () => {
    renderWithContext(<Header onOpenSettings={() => {}} />);
    expect(screen.getByText("Guest User")).toBeInTheDocument();
  });

  it("opens user menu on click", async () => {
    const user = userEvent.setup();
    renderWithContext(<Header onOpenSettings={() => {}} />);

    // Menu panel should not be visible initially
    expect(screen.queryByText("Account Menu")).not.toBeInTheDocument();

    // Click the user menu button
    await user.click(screen.getByText("Guest User"));

    // Menu panel should now be visible
    expect(screen.getByText("Account Menu")).toBeInTheDocument();
  });

  it("shows login button when not authenticated", async () => {
    const user = userEvent.setup();
    renderWithContext(<Header onOpenSettings={() => {}} />);

    await user.click(screen.getByText("Guest User"));

    expect(screen.getByText("Login with OneWelcome")).toBeInTheDocument();
  });

  it("shows Not Signed In status when no token", async () => {
    const user = userEvent.setup();
    renderWithContext(<Header onOpenSettings={() => {}} />);

    await user.click(screen.getByText("Guest User"));

    expect(screen.getByText("Not Signed In")).toBeInTheDocument();
  });

  it("calls onOpenSettings when settings button clicked", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    renderWithContext(<Header onOpenSettings={onOpenSettings} />);

    await user.click(screen.getByText("Guest User"));
    await user.click(screen.getByText("Settings"));

    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});

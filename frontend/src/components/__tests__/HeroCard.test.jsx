import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithContext } from "../../test/renderWithContext";
import HeroCard from "../HeroCard";

describe("HeroCard", () => {
  it("renders the title", () => {
    renderWithContext(<HeroCard onOpenOperations={() => {}} />);
    expect(
      screen.getByText("Banking assistant built for secure customer operations")
    ).toBeInTheDocument();
  });

  it("renders default balance values", () => {
    renderWithContext(<HeroCard onOpenOperations={() => {}} />);
    expect(screen.getByText("$24,982.14")).toBeInTheDocument();
    expect(screen.getByText("$7,410.00")).toBeInTheDocument();
  });

  it("renders risk status", () => {
    renderWithContext(<HeroCard onOpenOperations={() => {}} />);
    expect(screen.getByText("Normal")).toBeInTheDocument();
  });

  it("renders stat labels", () => {
    renderWithContext(<HeroCard onOpenOperations={() => {}} />);
    expect(screen.getByText("Available Balance")).toBeInTheDocument();
    expect(screen.getByText("Savings Account")).toBeInTheDocument();
    expect(screen.getByText("Risk Status")).toBeInTheDocument();
    expect(screen.getByText("Questions Asked")).toBeInTheDocument();
    expect(screen.getByText("Questions Answered")).toBeInTheDocument();
    expect(screen.getByText("Operations Performed")).toBeInTheDocument();
  });

  it("calls onOpenOperations when operations stat is clicked", async () => {
    const user = userEvent.setup();
    const onOpenOperations = vi.fn();
    renderWithContext(<HeroCard onOpenOperations={onOpenOperations} />);

    await user.click(screen.getByText("Operations Performed"));

    expect(onOpenOperations).toHaveBeenCalledOnce();
  });
});

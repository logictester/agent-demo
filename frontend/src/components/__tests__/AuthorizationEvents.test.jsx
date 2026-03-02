import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithContext } from "../../test/renderWithContext";
import AuthorizationEvents from "../AuthorizationEvents";

describe("AuthorizationEvents", () => {
  it("renders the title", () => {
    renderWithContext(<AuthorizationEvents />);
    expect(screen.getByText("Authorization Events")).toBeInTheDocument();
  });

  it("shows empty state when no events", () => {
    renderWithContext(<AuthorizationEvents />);
    expect(
      screen.getByText("No authorization events yet")
    ).toBeInTheDocument();
  });

  it("renders Refresh button", () => {
    renderWithContext(<AuthorizationEvents />);
    expect(screen.getByText("Refresh")).toBeInTheDocument();
  });

  it("renders pagination", () => {
    renderWithContext(<AuthorizationEvents />);
    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
  });
});

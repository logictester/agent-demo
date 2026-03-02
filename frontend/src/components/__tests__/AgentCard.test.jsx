import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithContext } from "../../test/renderWithContext";
import AgentCard from "../AgentCard";

describe("AgentCard", () => {
  beforeEach(() => localStorage.clear());

  it("renders the title", () => {
    renderWithContext(<AgentCard />);
    expect(screen.getByText("AI Banking Agent")).toBeInTheDocument();
  });

  it("renders the input placeholder", () => {
    renderWithContext(<AgentCard />);
    expect(
      screen.getByPlaceholderText("Try: transfer 50 to savings account")
    ).toBeInTheDocument();
  });

  it("renders Send button", () => {
    renderWithContext(<AgentCard />);
    expect(screen.getByText("Send")).toBeInTheDocument();
  });

  it("renders prompt hints section", () => {
    renderWithContext(<AgentCard />);
    expect(screen.getByText("Automation Prompt Hints")).toBeInTheDocument();
  });

  it("renders default response text", () => {
    renderWithContext(<AgentCard />);
    expect(
      screen.getByText("Response will appear here.")
    ).toBeInTheDocument();
  });

  it("renders Clear Response button", () => {
    renderWithContext(<AgentCard />);
    expect(screen.getByText("Clear Response")).toBeInTheDocument();
  });

  it("shows error when sending empty message", async () => {
    const user = userEvent.setup();
    renderWithContext(<AgentCard />);

    await user.click(screen.getByText("Send"));

    expect(
      screen.getByText("Please enter a message before sending.")
    ).toBeInTheDocument();
  });

  it("renders question history dropdown", () => {
    renderWithContext(<AgentCard />);
    expect(screen.getByText("No recent questions")).toBeInTheDocument();
  });
});

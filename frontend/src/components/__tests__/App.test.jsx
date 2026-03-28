import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithContext } from "../../test/renderWithContext";
import App from "../../App";

describe("App workspaces", () => {
  it("switches between banking operations and Trading Agent tabs", async () => {
    const user = userEvent.setup();
    renderWithContext(<App />);

    expect(screen.getByText("AI Banking Agent")).toBeInTheDocument();
    expect(screen.queryByText("Live market pulse with a simulated autonomous broker")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Trading Agent" }));

    expect(screen.getByText("Live market pulse with a simulated autonomous broker")).toBeInTheDocument();
    expect(screen.queryByText("AI Banking Agent")).not.toBeInTheDocument();
  });
});

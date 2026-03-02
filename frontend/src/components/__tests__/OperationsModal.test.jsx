import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithContext } from "../../test/renderWithContext";
import OperationsModal from "../OperationsModal";

describe("OperationsModal", () => {
  it("renders nothing when not open", () => {
    const { container } = renderWithContext(
      <OperationsModal open={false} onClose={() => {}} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders title when open", () => {
    renderWithContext(<OperationsModal open={true} onClose={() => {}} />);
    expect(screen.getByText("Performed Operations")).toBeInTheDocument();
  });

  it("shows empty state when no operations", () => {
    renderWithContext(<OperationsModal open={true} onClose={() => {}} />);
    expect(
      screen.getByText("No performed operations for current filter.")
    ).toBeInTheDocument();
  });

  it("renders filter dropdowns when open", () => {
    renderWithContext(<OperationsModal open={true} onClose={() => {}} />);
    expect(screen.getByText("All sources")).toBeInTheDocument();
    expect(screen.getByText("All automation types")).toBeInTheDocument();
  });

  it("calls onClose when Close button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithContext(<OperationsModal open={true} onClose={onClose} />);

    await user.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

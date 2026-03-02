import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithContext } from "../../test/renderWithContext";
import ConfirmModal from "../ConfirmModal";

describe("ConfirmModal", () => {
  it("renders nothing when no confirmModal state", () => {
    const { container } = renderWithContext(<ConfirmModal />);
    expect(container.innerHTML).toBe("");
  });
});

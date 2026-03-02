import { describe, it, expect, beforeEach } from "vitest";
import { renderWithContext } from "../../test/renderWithContext";
import SessionModal from "../SessionModal";

describe("SessionModal", () => {
  beforeEach(() => localStorage.clear());

  it("renders nothing when no session issue", () => {
    const { container } = renderWithContext(<SessionModal />);
    // No token = no session to check = nothing rendered
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when token exists but no expiry issue", () => {
    // Token with far-future expiry (1 hour from now)
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const header = btoa(JSON.stringify({ alg: "HS256" }));
    const payload = btoa(JSON.stringify({ exp }));
    localStorage.setItem("access_token", "some-token");
    localStorage.setItem("id_token", `${header}.${payload}.sig`);

    const { container } = renderWithContext(<SessionModal />);
    expect(container.innerHTML).toBe("");
  });
});

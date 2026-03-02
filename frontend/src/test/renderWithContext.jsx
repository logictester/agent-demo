import { render } from "@testing-library/react";
import { AppProvider } from "../context/AppContext";

/**
 * Wraps the rendered component in the AppProvider for tests.
 * Mocks fetch globally to prevent real network calls.
 */
export function renderWithContext(ui, options = {}) {
  // Prevent real network calls from context's initial data loads
  if (!globalThis.fetch.__isMocked) {
    const orig = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (...args) =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        }),
      { __isMocked: true, __original: orig }
    );
  }

  function Wrapper({ children }) {
    return <AppProvider>{children}</AppProvider>;
  }

  return render(ui, { wrapper: Wrapper, ...options });
}

/** Screenshot fixtures, only in a `vite build --mode scopemock` build (tree-shaken otherwise). */
import { scopeMock } from "./scopeMock.ts";

export const SCOPE_MOCK = import.meta.env.MODE === "scopemock"
  ? scopeMock(new URLSearchParams(window.location.search).get("scopeMock") ?? "live")
  : null;

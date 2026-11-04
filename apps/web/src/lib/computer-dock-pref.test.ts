// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { readComputerDockPref, writeComputerDockPref } from "./computer-dock-pref";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it("defaults to a bottom-docked, uncollapsed panel when nothing is saved", () => {
  expect(readComputerDockPref()).toEqual({ edge: "bottom", height: 320, collapsed: false });
});

it("round-trips what was written", () => {
  writeComputerDockPref({ edge: "top", height: 240, collapsed: true });
  expect(readComputerDockPref()).toEqual({ edge: "top", height: 240, collapsed: true });
});

it("falls back to defaults when storage throws on read", () => {
  vi.spyOn(Object.getPrototypeOf(window.localStorage), "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(readComputerDockPref()).toEqual({ edge: "bottom", height: 320, collapsed: false });
});

it("does not throw when storage throws on write", () => {
  vi.spyOn(Object.getPrototypeOf(window.localStorage), "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(() => writeComputerDockPref({ edge: "top", height: 200, collapsed: false })).not.toThrow();
});

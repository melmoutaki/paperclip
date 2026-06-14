import { describe, expect, it } from "vitest";
import { assertProcessCommandAllowed } from "../adapters/process/execute.js";

describe("process adapter execute guard", () => {
  it("blocks direct SSH commands from configured process adapters", () => {
    for (const command of ["ssh", "ssh.exe", "/usr/bin/ssh", "C:\\Windows\\System32\\OpenSSH\\ssh.exe"]) {
      expect(() => assertProcessCommandAllowed(command)).toThrow(/cannot execute direct SSH/i);
    }
  });

  it("allows non-SSH process commands", () => {
    expect(() => assertProcessCommandAllowed("node")).not.toThrow();
    expect(() => assertProcessCommandAllowed("/usr/bin/env")).not.toThrow();
  });
});

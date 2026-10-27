// Test-only capture: known negative-path diagnostics are asserted by the caller.
// Every unexpected warning/error still reaches stderr and is returned for failure.
export function captureDiagnostics(expected: RegExp[]) {
  const messages: string[] = [];
  for (const level of ["warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const message = args.map(String).join(" ");
      messages.push(message);
      if (!expected.some((pattern) => pattern.test(message))) original(...args);
    };
  }
  return () => messages.splice(0);
}

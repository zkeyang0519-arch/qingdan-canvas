import { createContext, useContext, useLayoutEffect } from "react";

export const OpeningPreparationContext = createContext(null);

// Reporting after the commit also covers lazy first-screen content. Without a
// gate (including OAuth consent), this wrapper has no effect on the application.
export default function OpeningPreparation({
  id = "page",
  status,
  error = "",
  children,
}) {
  const report = useContext(OpeningPreparationContext);
  useLayoutEffect(() => {
    if (!report) return;
    report(id, { status, error });
    return () => report(id, null);
  }, [report, id, status, error]);
  return children;
}

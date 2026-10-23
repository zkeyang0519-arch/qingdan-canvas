import { useEffect, useState } from "react";

export default function useResendCooldown() {
  const [deadline, setDeadline] = useState(0);
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (!deadline) return;
    const timer = setInterval(() => {
      const next = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(next);
      if (!next) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  function start(seconds = 60) {
    const duration = Number.isFinite(seconds) ? Math.max(0, seconds) : 60;
    setRemaining(Math.ceil(duration));
    setDeadline(Date.now() + duration * 1000);
  }
  return [remaining, start];
}

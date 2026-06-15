/**
 * ThinkingIndicator.tsx — Animated thinking status with dots.
 */

import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { colors } from "./theme.js";

interface ThinkingIndicatorProps {
  active: boolean;
}

export function ThinkingIndicator({ active }: Readonly<ThinkingIndicatorProps>) {
  const [dots, setDots] = useState("");

  useEffect(() => {
    if (!active) return;

    const interval = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? "" : prev + "."));
    }, 400);

    return () => clearInterval(interval);
  }, [active]);

  if (!active) return null;

  return (
    <Text color={colors.muted}> ◆ PENSANDO{dots} </Text>
  );
}

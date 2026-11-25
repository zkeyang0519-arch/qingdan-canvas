"use client";

import * as React from "react";
import { cn } from "./utils.js";
import { Separator as SeparatorPrimitive } from "radix-ui";

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "qd:shrink-0 qd:bg-border qd:data-horizontal:h-px qd:data-horizontal:w-full qd:data-vertical:w-px qd:data-vertical:self-stretch",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };

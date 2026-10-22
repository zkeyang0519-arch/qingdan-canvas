import React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

// shadcn/ui's Portal + Content composition keeps panels outside row stacking contexts.
// https://ui.shadcn.com/docs/components/radix/popover
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({ children, align = "end", ...props }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={8}
        collisionPadding={12}
        {...props}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "./utils.js";
import { Slot } from "radix-ui";

const buttonVariants = cva(
  "qd:group/button qd:inline-flex qd:shrink-0 qd:items-center qd:justify-center qd:rounded-4xl qd:border qd:border-transparent qd:bg-clip-padding qd:text-sm qd:font-medium qd:whitespace-nowrap qd:transition-all qd:outline-none qd:select-none qd:focus-visible:border-ring qd:focus-visible:ring-3 qd:focus-visible:ring-ring/30 qd:active:not-aria-[haspopup]:translate-y-px qd:disabled:pointer-events-none qd:disabled:opacity-50 qd:aria-invalid:border-destructive qd:aria-invalid:ring-3 qd:aria-invalid:ring-destructive/20 qd:dark:aria-invalid:border-destructive/50 qd:dark:aria-invalid:ring-destructive/40 qd:[&_svg]:pointer-events-none qd:[&_svg]:shrink-0 qd:[&_svg:not([class*=size-])]:size-4",
  {
    variants: {
      variant: {
        default:
          "qd:bg-primary qd:text-primary-foreground qd:hover:bg-primary/80",
        outline:
          "qd:border-border qd:bg-background qd:hover:bg-muted qd:hover:text-foreground qd:aria-expanded:bg-muted qd:aria-expanded:text-foreground qd:dark:bg-transparent qd:dark:hover:bg-input/30",
        secondary:
          "qd:bg-secondary qd:text-secondary-foreground qd:hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] qd:aria-expanded:bg-secondary qd:aria-expanded:text-secondary-foreground",
        ghost:
          "qd:hover:bg-muted qd:hover:text-foreground qd:aria-expanded:bg-muted qd:aria-expanded:text-foreground qd:dark:hover:bg-muted/50",
        destructive:
          "qd:bg-destructive/10 qd:text-destructive qd:hover:bg-destructive/20 qd:focus-visible:border-destructive/40 qd:focus-visible:ring-destructive/20 qd:dark:bg-destructive/20 qd:dark:hover:bg-destructive/30 qd:dark:focus-visible:ring-destructive/40",
        link: "qd:text-primary qd:underline-offset-4 qd:hover:underline",
      },
      size: {
        default:
          "qd:h-9 qd:gap-1.5 qd:px-3 qd:has-data-[icon=inline-end]:pr-2.5 qd:has-data-[icon=inline-start]:pl-2.5",
        xs: "qd:h-6 qd:gap-1 qd:px-2.5 qd:text-xs qd:has-data-[icon=inline-end]:pr-2 qd:has-data-[icon=inline-start]:pl-2 qd:[&_svg:not([class*=size-])]:size-3",
        sm: "qd:h-8 qd:gap-1 qd:px-3 qd:has-data-[icon=inline-end]:pr-2 qd:has-data-[icon=inline-start]:pl-2",
        lg: "qd:h-10 qd:gap-1.5 qd:px-4 qd:has-data-[icon=inline-end]:pr-3 qd:has-data-[icon=inline-start]:pl-3",
        icon: "qd:size-9",
        "icon-xs": "qd:size-6 qd:[&_svg:not([class*=size-])]:size-3",
        "icon-sm": "qd:size-8",
        "icon-lg": "qd:size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };

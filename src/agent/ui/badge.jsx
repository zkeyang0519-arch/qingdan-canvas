import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "./utils.js";
import { Slot } from "radix-ui";

const badgeVariants = cva(
  "qd:group/badge qd:inline-flex qd:h-5 qd:w-fit qd:shrink-0 qd:items-center qd:justify-center qd:gap-1 qd:overflow-hidden qd:rounded-3xl qd:border qd:border-transparent qd:px-2 qd:py-0.5 qd:text-xs qd:font-medium qd:whitespace-nowrap qd:transition-all qd:focus-visible:border-ring qd:focus-visible:ring-[3px] qd:focus-visible:ring-ring/50 qd:has-data-[icon=inline-end]:pr-1.5 qd:has-data-[icon=inline-start]:pl-1.5 qd:aria-invalid:border-destructive qd:aria-invalid:ring-destructive/20 qd:dark:aria-invalid:ring-destructive/40 qd:[&>svg]:pointer-events-none qd:[&>svg]:size-3!",
  {
    variants: {
      variant: {
        default:
          "qd:bg-primary qd:text-primary-foreground qd:[a]:hover:bg-primary/80",
        secondary:
          "qd:bg-secondary qd:text-secondary-foreground qd:[a]:hover:bg-secondary/80",
        destructive:
          "qd:bg-destructive/10 qd:text-destructive qd:focus-visible:ring-destructive/20 qd:dark:bg-destructive/20 qd:dark:focus-visible:ring-destructive/40 qd:[a]:hover:bg-destructive/20",
        outline:
          "qd:border-border qd:text-foreground qd:[a]:hover:bg-muted qd:[a]:hover:text-muted-foreground",
        ghost:
          "qd:hover:bg-muted qd:hover:text-muted-foreground qd:dark:hover:bg-muted/50",
        link: "qd:text-primary qd:underline-offset-4 qd:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({ className, variant = "default", asChild = false, ...props }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };

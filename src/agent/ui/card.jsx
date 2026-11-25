import * as React from "react";
import { cn } from "./utils.js";

function Card({ className, size = "default", ...props }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "qd:group/card qd:flex qd:flex-col qd:gap-(--card-spacing) qd:overflow-hidden qd:rounded-4xl qd:bg-card qd:py-(--card-spacing) qd:text-sm qd:text-card-foreground qd:shadow-md qd:ring-1 qd:ring-foreground/5 qd:[--card-spacing:--spacing(6)] qd:has-[>img:first-child]:pt-0 qd:data-[size=sm]:[--card-spacing:--spacing(4)] qd:dark:ring-foreground/10 qd:*:[img:first-child]:rounded-t-4xl qd:*:[img:last-child]:rounded-b-4xl",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "qd:group/card-header qd:@container/card-header qd:grid qd:auto-rows-min qd:items-start qd:gap-1.5 qd:rounded-t-4xl qd:px-(--card-spacing) qd:has-data-[slot=card-action]:grid-cols-[1fr_auto] qd:has-data-[slot=card-description]:grid-rows-[auto_auto] qd:[.border-b]:pb-(--card-spacing)",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }) {
  return (
    <div
      data-slot="card-title"
      className={cn("qd:text-base qd:font-medium", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }) {
  return (
    <div
      data-slot="card-description"
      className={cn("qd:text-sm qd:text-muted-foreground", className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "qd:col-start-2 qd:row-span-2 qd:row-start-1 qd:self-start qd:justify-self-end",
        className,
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }) {
  return (
    <div
      data-slot="card-content"
      className={cn("qd:px-(--card-spacing)", className)}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "qd:flex qd:items-center qd:rounded-b-4xl qd:px-(--card-spacing) qd:[.border-t]:pt-(--card-spacing)",
        className,
      )}
      {...props}
    />
  );
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
};

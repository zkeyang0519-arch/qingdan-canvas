import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "./utils.js";
import { Tabs as TabsPrimitive } from "radix-ui";

function Tabs({ className, orientation = "horizontal", ...props }) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "qd:group/tabs qd:flex qd:gap-2 qd:data-horizontal:flex-col",
        className,
      )}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  "qd:group/tabs-list qd:inline-flex qd:w-fit qd:items-center qd:justify-center qd:rounded-full qd:p-1 qd:text-muted-foreground qd:group-data-horizontal/tabs:h-9 qd:group-data-vertical/tabs:h-fit qd:group-data-vertical/tabs:flex-col qd:group-data-vertical/tabs:rounded-2xl qd:data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "qd:bg-muted",
        line: "qd:gap-1 qd:bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function TabsList({ className, variant = "default", ...props }) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "qd:relative qd:inline-flex qd:h-[calc(100%-1px)] qd:flex-1 qd:items-center qd:justify-center qd:gap-2 qd:rounded-full qd:border qd:border-transparent! qd:px-3 qd:py-1 qd:text-sm qd:font-medium qd:whitespace-nowrap qd:text-foreground/60 qd:transition-all qd:group-data-vertical/tabs:w-full qd:group-data-vertical/tabs:justify-start qd:group-data-vertical/tabs:rounded-2xl qd:group-data-vertical/tabs:px-3 qd:group-data-vertical/tabs:py-1.5 qd:hover:text-foreground qd:focus-visible:border-ring qd:focus-visible:ring-[3px] qd:focus-visible:ring-ring/50 qd:focus-visible:outline-1 qd:focus-visible:outline-ring qd:disabled:pointer-events-none qd:disabled:opacity-50 qd:has-data-[icon=inline-end]:pr-2 qd:has-data-[icon=inline-start]:pl-2 qd:dark:text-muted-foreground qd:dark:hover:text-foreground qd:[&_svg]:pointer-events-none qd:[&_svg]:shrink-0 qd:[&_svg:not([class*=size-])]:size-4",
        "qd:group-data-[variant=line]/tabs-list:bg-transparent qd:group-data-[variant=line]/tabs-list:data-active:bg-transparent qd:dark:group-data-[variant=line]/tabs-list:data-active:border-transparent qd:dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "qd:data-active:bg-background qd:data-active:text-foreground qd:dark:data-active:border-input qd:dark:data-active:bg-input/30 qd:dark:data-active:text-foreground",
        "qd:after:absolute qd:after:bg-foreground qd:after:opacity-0 qd:after:transition-opacity qd:group-data-horizontal/tabs:after:inset-x-0 qd:group-data-horizontal/tabs:after:bottom-[-5px] qd:group-data-horizontal/tabs:after:h-0.5 qd:group-data-vertical/tabs:after:inset-y-0 qd:group-data-vertical/tabs:after:-right-1 qd:group-data-vertical/tabs:after:w-0.5 qd:group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("qd:flex-1 qd:text-sm qd:outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };

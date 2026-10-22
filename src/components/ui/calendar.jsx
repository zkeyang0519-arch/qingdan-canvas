import React from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker } from "react-day-picker";
import { zhCN } from "react-day-picker/locale";
import "react-day-picker/style.css";

// shadcn/ui Calendar composition, styled with Qingdan's existing CSS tokens.
// https://ui.shadcn.com/docs/components/radix/calendar
function CalendarChevron({ orientation, className }) {
  const Icon =
    orientation === "left"
      ? ChevronLeft
      : orientation === "right"
        ? ChevronRight
        : ChevronDown;
  return <Icon className={className} size={15} aria-hidden="true" />;
}

export function Calendar({ className = "", ...props }) {
  return (
    <DayPicker
      className={`qingdan-calendar ${className}`}
      locale={zhCN}
      weekStartsOn={1}
      showOutsideDays
      fixedWeeks
      captionLayout="dropdown"
      navLayout="around"
      components={{ Chevron: CalendarChevron }}
      {...props}
    />
  );
}

import React, { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  completionDestination,
  completionFlightFrames,
  completionPoseAt,
  createCompletionMotion,
  observeCompletionMotion,
  rectIsVisible,
} from "./taskCompletionMotion.js";
import "./taskCompletionMotion.css";

export default function TaskCompletionMotion({
  entry,
  listElement,
  onFinished,
}) {
  const host = useRef(),
    callback = useRef(onFinished);
  callback.current = onFinished;
  useLayoutEffect(() => {
    const element = host.current;
    const find = (selector) =>
      [...(listElement?.querySelectorAll(selector) || [])].find(
        (n) => n.dataset.taskId === entry.itemId,
      );
    const target = find(".done-panel [data-task-id]");
    const sourceSlot = [
      ...(listElement?.querySelectorAll("[data-completion-source]") || []),
    ].find((n) => n.dataset.completionSource === entry.itemId);
    const buffer = [
      ...(listElement?.querySelectorAll("[data-completion-buffer]") || []),
    ].find((n) => n.dataset.completionBuffer === entry.eventId);
    const targetSlot = target?.parentElement,
      panel = target?.closest(".todo-panel-body");
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (
      !target ||
      !sourceSlot ||
      !buffer ||
      !element.animate ||
      document.hidden ||
      media?.matches
    ) {
      callback.current();
      return;
    }
    // Reveal an offscreen insertion during the hold. Never scroll the page or jump
    // a destination that another in-flight card is already following.
    const initialScroll = panel.scrollTop;
    const { toRect, scrollDelta } = completionDestination(
      target,
      panel,
      entry.manual,
    );
    const motion = createCompletionMotion({
      ...entry,
      fromRect: entry.source.fromRect,
      toRect,
      visible: rectIsVisible(toRect, panel.getBoundingClientRect()),
      reducedMotion: media?.matches,
    });
    if (!motion) {
      callback.current();
      return;
    }

    const { fromRect: from } = motion,
      animations = [];
    const observer = observeCompletionMotion({
      window,
      document,
      media,
      duration: motion.duration,
      onFinished: () => callback.current(),
    });
    const startTime = document.timeline?.currentTime;
    const animate = (node, frames) => {
      const animation = node.animate(frames, {
        duration: motion.duration,
        fill: "both",
        easing: "linear",
      });
      if (startTime != null) animation.startTime = startTime;
      animations.push(animation);
      return animation;
    };
    const card = entry.source.card.cloneNode(true);
    element.append(card);
    target.dataset.completionHidden = "true";
    targetSlot.classList.add("completion-target-slot");
    Object.assign(element.style, {
      left: `${from.x}px`,
      top: `${from.y}px`,
      width: `${from.width}px`,
      height: `${from.height}px`,
    });
    const lift = 150 / 900,
      confirmed = 350 / 900,
      arrived = 750 / 900;
    const clock = animate(element, completionFlightFrames(motion));
    animate(element, [
      {
        offset: 0,
        backgroundColor: entry.source.backgroundColor,
        boxShadow: "0 0 0 #43563200",
        easing: "cubic-bezier(.2,.7,.3,1)",
      },
      {
        offset: lift,
        backgroundColor: "#f4f7ee",
        boxShadow: "0 12px 28px #43563226, 0 2px 5px #43563212",
      },
      {
        offset: confirmed,
        backgroundColor: "#f8faf3",
        boxShadow: "0 12px 28px #43563226, 0 2px 5px #43563212",
      },
      {
        offset: arrived,
        backgroundColor: "#f8faf3",
        boxShadow: "0 5px 12px #43563218, 0 1px 3px #4356320a",
      },
      {
        offset: 1,
        backgroundColor: window.getComputedStyle(target).backgroundColor,
        boxShadow: "0 0 0 #43563200",
      },
    ]);
    clock.onfinish = observer.finish;
    const slotFrames = (start, end) => [
      { offset: 0, height: `${start}px` },
      {
        offset: confirmed,
        height: `${start}px`,
        easing: "cubic-bezier(.45,0,.25,1)",
      },
      { offset: arrived, height: `${end}px` },
      { offset: 1, height: `${end}px` },
    ];
    animate(sourceSlot, slotFrames(from.height, 0));
    animate(targetSlot, slotFrames(0, toRect.height));
    animate(buffer, slotFrames(toRect.height, 0));
    const checkbox = card.querySelector(".todo-circle"),
      targetCheck = target.querySelector(".todo-circle");
    if (checkbox && targetCheck) {
      checkbox.replaceChildren(
        ...[...targetCheck.childNodes].map((n) => n.cloneNode(true)),
      );
      const fromStyle = window.getComputedStyle(checkbox),
        toStyle = window.getComputedStyle(targetCheck);
      animate(checkbox, [
        {
          offset: 0,
          backgroundColor: fromStyle.backgroundColor,
          borderColor: fromStyle.borderColor,
        },
        {
          offset: lift,
          backgroundColor: toStyle.backgroundColor,
          borderColor: toStyle.borderColor,
        },
        {
          offset: 1,
          backgroundColor: toStyle.backgroundColor,
          borderColor: toStyle.borderColor,
        },
      ]);
      if (checkbox.firstElementChild)
        animate(checkbox.firstElementChild, [
          { offset: 0, opacity: 0, transform: "scale(.6)" },
          { offset: lift, opacity: 1, transform: "scale(1)" },
          { offset: 1, opacity: 1, transform: "scale(1)" },
        ]);
    }
    const targetText = [...target.querySelectorAll(".todo-copy, .todo-copy *")];
    [...card.querySelectorAll(".todo-copy, .todo-copy *")].forEach(
      (node, index) => {
        const toColor = window.getComputedStyle(
          targetText[index] || targetText[0],
        ).color;
        const color = window.getComputedStyle(node).color;
        animate(node, [
          { offset: 0, color },
          { offset: lift, color },
          { offset: confirmed, color: toColor },
          { offset: 1, color: toColor },
        ]);
      },
    );
    const targetTools = [
      ...target.querySelectorAll(".todo-row-tools, .todo-row-tools *"),
    ];
    [...card.querySelectorAll(".todo-row-tools, .todo-row-tools *")].forEach(
      (node, index) => {
        if (!targetTools[index]) return;
        const opacity = window.getComputedStyle(node).opacity,
          finalOpacity = window.getComputedStyle(targetTools[index]).opacity;
        if (opacity !== finalOpacity)
          animate(node, [
            { offset: 0, opacity },
            { offset: arrived, opacity },
            { offset: 1, opacity: finalOpacity },
          ]);
      },
    );
    for (const line of entry.source.lines) {
      const strike = document.createElement("span");
      strike.className = "completion-strike";
      Object.assign(strike.style, {
        left: `${line.x}px`,
        top: `${line.y}px`,
        width: `${line.right - line.x}px`,
      });
      element.append(strike);
      animate(strike, [
        { offset: 0, transform: "scaleX(0)" },
        {
          offset: lift,
          transform: "scaleX(0)",
          easing: "cubic-bezier(.2,.6,.3,1)",
        },
        { offset: confirmed, transform: "scaleX(1)" },
        { offset: 1, transform: "scaleX(1)" },
      ]);
    }
    let frame,
      revealed = scrollDelta === 0;
    const paint = () => {
      // Another completed card may be opening a slot above this one.
      const time = Number(clock.currentTime) || 0;
      if (!revealed) {
        const progress = Math.min(1, time / 350);
        panel.scrollTop =
          initialScroll +
          scrollDelta * progress * progress * (3 - 2 * progress);
        revealed = progress === 1;
      }
      const basePose = completionPoseAt(motion, time);
      const pose = completionPoseAt(
        motion,
        time,
        target.getBoundingClientRect(),
      );
      element.style.left = `${from.x + pose.x - basePose.x}px`;
      element.style.top = `${from.y + pose.y - basePose.y}px`;
      frame = window.requestAnimationFrame(paint);
    };
    paint();
    return () => {
      observer.dispose();
      window.cancelAnimationFrame(frame);
      animations.forEach((animation) => {
        animation.onfinish = null;
        animation.cancel();
      });
      delete target.dataset.completionHidden;
      targetSlot.classList.remove("completion-target-slot");
      element.replaceChildren();
    };
  }, [entry, listElement]);

  return createPortal(
    <div
      ref={host}
      className="task-completion-copy"
      aria-hidden="true"
      inert
      data-completion-event={entry.eventId}
    />,
    document.body,
  );
}

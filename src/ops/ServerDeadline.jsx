import React, { useState } from "react";
import { Clock3 } from "lucide-react";
import { deadlineInfo, validDeadline } from "../../shared/deadline.js";
import {
  TaskDeadlineButton,
  TaskDeadlinePopover,
  DeadlineIndicator,
  formatDeadline,
  formatDeadlineRange,
} from "../canvas/TaskDeadline.jsx";

export function DeadlineRing({ server, now }) {
  const info = deadlineInfo(server, now);
  const description = `${server.name}：${info.relative}${server.dueAt ? `，${formatDeadlineRange(server.dueAt, server.dueStartAt)}` : ""}`;
  return (
    <span
      className="ops-deadline-display"
      data-deadline={info.status}
      role="img"
      aria-label={description}
      title={description}
    >
      <span className="todo-deadline-button">
        <DeadlineIndicator info={info} />
      </span>
    </span>
  );
}

export function DeadlineDate({ dueAt, dueStartAt }) {
  return (
    <span
      className="ops-deadline-date"
      title={formatDeadlineRange(dueAt, dueStartAt)}
    >
      <Clock3 size={13} aria-hidden="true" />
      <span className="sr-only">DDL：</span>
      {validDeadline(dueAt) ? (
        <span>
          {dueStartAt && (
            <>
              <time dateTime={dueStartAt}>{formatDeadline(dueStartAt)}</time>
              <span> – </span>
            </>
          )}
          <time dateTime={dueAt}>{formatDeadline(dueAt)}</time>
        </span>
      ) : (
        <span>—</span>
      )}
    </span>
  );
}

export default function ServerDeadline({ server, now, readOnly, onSave }) {
  const [open, setOpen] = useState(false);
  const info = deadlineInfo(server, now);
  return (
    <div className="ops-server-deadline" data-deadline={info.status}>
      <DeadlineDate {...server} />
      <TaskDeadlinePopover
        open={open}
        onOpenChange={setOpen}
        task={{
          title: server.name || "服务器",
          dueAt: server.dueAt,
          dueStartAt: server.dueStartAt,
        }}
        disabled={readOnly}
        showHint={false}
        disabledMessage="这台服务器当前无法编辑。"
        onClose={() => setOpen(false)}
        onSave={(dueAt, dueStartAt) => {
          if (readOnly) return "这台服务器当前无法编辑。";
          const error = onSave(dueAt, dueStartAt);
          if (!error) setOpen(false);
          return error;
        }}
      >
        <TaskDeadlineButton
          info={info}
          dueAt={server.dueAt}
          dueStartAt={server.dueStartAt}
          text={server.name || "服务器"}
          disabled={readOnly}
        />
      </TaskDeadlinePopover>
    </div>
  );
}

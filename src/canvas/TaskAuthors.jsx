import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import UserAvatar from "../UserAvatar.jsx";
import "./taskAuthors.css";

const TaskAuthors = createContext({ visible: true, people: new Map() });
const readPreference = (key) => {
  try {
    return window.localStorage.getItem(key) !== "false";
  } catch {
    return true;
  }
};

export function TaskAuthorsProvider({
  user,
  roomId,
  members = [],
  profiles = [],
  children,
}) {
  const key = `qingdan.task-authors:${JSON.stringify([user.id, roomId])}`;
  const [preference, setPreference] = useState(() => ({
    key,
    visible: readPreference(key),
  }));
  const visible =
    preference.key === key ? preference.visible : readPreference(key);
  useEffect(() => {
    const refresh = () => setPreference({ key, visible: readPreference(key) });
    refresh();
    const changed = (event) => {
      if (event.key === key || event.key === null) refresh();
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [key]);
  const people = useMemo(
    () =>
      new Map([
        [user.id, user],
        ...members.map((member) => [member.userId, member]),
        ...profiles.map((profile) => [profile.userId, profile]),
      ]),
    [members, profiles, user],
  );
  const setVisible = (next) => {
    setPreference({ key, visible: next });
    try {
      window.localStorage.setItem(key, String(next));
    } catch {
      /* Still allow changing the current view when storage is unavailable. */
    }
  };
  return (
    <TaskAuthors.Provider
      value={{ visible, people, viewerId: user.id, setVisible }}
    >
      {children}
    </TaskAuthors.Provider>
  );
}

export function AuthorAvatarToggle() {
  const { visible, setVisible } = useContext(TaskAuthors);
  return (
    <button
      className="author-avatar-toggle"
      type="button"
      role="switch"
      aria-label="显示待办作者头像"
      aria-checked={visible}
      title="显示待办作者头像，仅影响你在此画布中的显示"
      onClick={() => setVisible(!visible)}
      onKeyDown={(event) => {
        if ([" ", "Enter", "ArrowLeft", "ArrowRight"].includes(event.key))
          event.stopPropagation();
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        setVisible(event.key === "ArrowRight");
      }}
    >
      <span>作者头像</span>
      <span className="author-avatar-track" aria-hidden="true">
        <span />
      </span>
    </button>
  );
}

function useAuthor(block) {
  const { people } = useContext(TaskAuthors);
  const profile = people.get(block.createdByUserId);
  const name = block.createdByUserId
    ? profile?.name || block.createdByName || "未命名成员"
    : "作者未记录";
  return {
    name,
    avatarVersion: profile?.avatarVersion,
    label: block.createdByUserId ? `创建者：${name}` : name,
  };
}

export function TaskAuthorAvatar({ block }) {
  const { visible, viewerId } = useContext(TaskAuthors);
  const { name, label, avatarVersion } = useAuthor(block);
  if (!visible) return null;
  return (
    <UserAvatar
      userId={block.createdByUserId}
      avatarVersion={avatarVersion}
      viewerId={viewerId}
      name={name}
      label={label}
      className={`task-author-avatar ${block.createdByUserId ? "" : "author-unknown"}`}
    />
  );
}

export function TaskAuthorDetails({ block }) {
  const { label } = useAuthor(block);
  return <div className="task-author-details">{label}</div>;
}

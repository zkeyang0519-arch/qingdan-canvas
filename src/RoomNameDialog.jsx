import React, { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { Modal } from "./canvas/Panels.jsx";

export default function RoomNameDialog({
  room,
  accountId,
  onRenamed,
  onClose,
}) {
  const [name, setName] = useState(room.name);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const save = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (pending.current || room.role !== "owner") return;
    if (!trimmed || trimmed.length > 80) {
      setError("项目名称需要 1–80 个字。");
      return;
    }
    if (trimmed === room.name) {
      onClose();
      return;
    }
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await api(`/api/rooms/${room.id}`, {
        method: "PATCH",
        accountId,
        body: { name: trimmed },
      });
      // App checks the account epoch even if the dialog closed during saving.
      onRenamed(result.room);
      if (mounted.current) onClose();
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  return (
    <Modal title="修改项目名称" onClose={onClose}>
      <form onSubmit={save}>
        <label className="field-label" htmlFor="rename-project-name">
          项目名称
        </label>
        <input
          id="rename-project-name"
          className="text-field"
          value={name}
          maxLength={80}
          disabled={saving}
          onFocus={(event) => event.target.select()}
          onChange={(event) => {
            setName(event.target.value);
            setError("");
          }}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={saving || !name.trim() || room.role !== "owner"}
          >
            {saving ? "保存中…" : "保存名称"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Grip,
  Plus,
  StickyNote,
  LockKeyhole,
  ArrowUpRight,
} from "lucide-react";
import useCanvasReturn from "./useCanvasReturn.jsx";
import Minimap from "./Minimap.jsx";
import Note from "./Note.jsx";
import ImageContent from "./ImageContent.jsx";
import ImageEditor from "./ImageEditor.jsx";
import ImageToolbar from "./ImageToolbar.jsx";
import CollectionWrap from "./CollectionWrap.jsx";
import { collectionTouches } from "./collectionWrap.js";
import CollectionFlight from "./CollectionFlight.jsx";
import RadialCreate, { useRadialCreate } from "./RadialCreate.jsx";
import useArrangement from "./useArrangement.jsx";
import useArrangedCollection from "./useArrangedCollection.jsx";
import ArrangedCollectionOverlay from "./ArrangedCollectionOverlay.jsx";
import { imageFrame, imageTransformPatch, exportImage } from "./images.js";
import { downloadBlob } from "./backup.js";
import {
  objectLabel,
  isComplete,
  moveObjects,
  collectObjects,
  takeOutObject,
  patchObjects,
  createObject,
  createImageNote,
  groupObjects,
  movableIds,
  reparentObjects,
  id,
} from "./model.js";
import {
  screenToWorld,
  zoomAt,
  intersects,
  contains,
  bounds,
} from "./geometry.js";
import {
  ancestors,
  displayRect,
  hiddenByAncestor,
  effectivelyLocked,
  marqueeRoots,
  selectionRoots,
  snapMove,
  snapResize,
  ALIGNMENT_SNAP_RELEASE_PX,
  canDragIntoFrame,
  frameDragBarriers,
  constrainFrameMove,
  descendantIds,
  placementInFrame,
  frameBounds,
  normalizeLayout,
  visibleInspirationBoards,
} from "./layout.js";
import { parseClipboard } from "./paste.js";
import { COLLECTION_DOCK, collectionDockWorldRect } from "./collectionDock.js";
import {
  isInspirationBoard,
  boardPlacement,
  boardResize,
  boardLeftLimit,
  boardsOverlap,
} from "./inspirationBoards.js";

const GROUP_DWELL_MS = 2000;
const BOARD_DWELL_MS = 1000;

export default function Canvas({
  workspace,
  boardId,
  view,
  onView,
  selection,
  setSelection,
  editing,
  onEdit,
  onExit,
  onContext,
  onCollection,
  onReference,
  onReferencePicker,
  onImagePreview,
  onToast,
  onPasteFeedback,
  onImportPending,
  onPickImages,
  apiRef,
  blocked,
  toolsHidden = false,
  temporaryVisible,
  dockedCollectionId,
}) {
  const { state, update, begin, end } = workspace;
  const arranged = view.mode === "arranged";
  const viewport = useRef(null),
    gesture = useRef(null),
    points = useRef(new Map()),
    space = useRef(false),
    suppressClick = useRef(false),
    pointer = useRef(null),
    groupTimer = useRef(null),
    alignmentTimer = useRef(null),
    moveRef = useRef(null),
    longPress = useRef(),
    cancelImport = useRef(0),
    measured = useRef(new Map());
  const [marquee, setMarquee] = useState(null),
    [dropTarget, setDropTarget] = useState(null),
    [dragging, setDragging] = useState(false),
    [dimensions, setDimensions] = useState({
      width: innerWidth,
      height: innerHeight - 64,
    }),
    [pendingImages, setPendingImages] = useState([]),
    [assetUrls, setAssetUrls] = useState(new Map()),
    [hoveredId, setHoveredId] = useState(null);
  const [dragLayer, setDragLayer] = useState(null);
  const [boardDraft, setBoardDraft] = useState(null);
  const contextMenuUntil = useRef(0);
  const { animateTakeOut, returningIds } = useCanvasReturn({
    objects: state.objects,
    boardId,
    enabled: !arranged,
    viewport,
  });
  const [placement, setPlacement] = useState(null),
    [groupHover, setGroupHover] = useState(null),
    [guides, setGuides] = useState([]),
    [lifted, setLifted] = useState(null),
    [dragAnchor, setDragAnchor] = useState(null),
    [collectionFlights, setCollectionFlights] = useState([]);
  const finishCollectionFlight = useCallback((token) => {
    setCollectionFlights((flights) => flights.filter((f) => f.token !== token));
  }, []);
  const [imageEdit, setImageEdit] = useState(null),
    [imageTool, setImageTool] = useState("arrow"),
    [imageMenu, setImageMenu] = useState(false);
  const imageEditor = useRef(null),
    exportingImage = useRef(false);
  const pendingBatches = useRef(new Set());
  const cancelImages = useCallback(() => {
    const hadPending = pendingBatches.current.size > 0;
    cancelImport.current++;
    pendingBatches.current.clear();
    setPendingImages([]);
    return hadPending;
  }, []);
  useEffect(() => {
    onImportPending?.(pendingImages.length > 0);
  }, [pendingImages, onImportPending]);
  const live = useRef({});
  live.current = { state, view, selection, editing, boardId, blocked };
  const objects = useMemo(
    () => new Map(state.objects.map((o) => [o.id, o])),
    [state.objects],
  );
  const dockCandidate = objects.get(dockedCollectionId);
  const dockedCollection =
    dockCandidate?.boardId === boardId ? dockCandidate : null;
  const collectionRect = (object) =>
    object.id === dockedCollectionId
      ? { ...object, ...collectionDockWorldRect(view) }
      : object;
  const activeFlights = collectionFlights.filter(
    (f) =>
      f.object.boardId === boardId &&
      objects.has(f.target.id) &&
      objects.get(f.object.id)?.parentId === f.target.id,
  );
  useEffect(() => {
    setCollectionFlights((flights) => {
      const remaining = flights.filter(
        (f) =>
          f.object.boardId === boardId &&
          objects.has(f.target.id) &&
          objects.get(f.object.id)?.parentId === f.target.id,
      );
      return remaining.length === flights.length ? flights : remaining;
    });
  }, [objects, boardId]);
  const selectedObject =
    selection.length === 1 ? objects.get(selection[0]) : null;
  const selectedImage =
    selectedObject?.type === "image" && selectedObject.boardId === boardId
      ? selectedObject
      : null;
  const imageMode =
    imageEdit?.id === selectedImage?.id ? imageEdit?.mode : null;
  const imageLocked =
    selectedImage && effectivelyLocked(objects, selectedImage.id);
  const isShown = (object, all = objects) =>
    object.id !== dockedCollectionId &&
    !hiddenByAncestor(all, object.id) &&
    (!view.hideCompleted ||
      !isComplete(object) ||
      temporaryVisible === object.id ||
      hoveredId === object.id ||
      editing?.noteId === object.id);
  const boardObjects = state.objects.filter((o) => o.boardId === boardId);
  const arrangement = useArrangement({
    enabled: arranged,
    objects: boardObjects
      .filter((o) => isShown(o))
      .map((o) =>
        imageEdit?.mode === "crop" && imageEdit.id === o.id
          ? { ...o, height: (o.width * o.naturalHeight) / o.naturalWidth }
          : o,
      ),
    dimensions,
    viewport,
    boardId,
    onView,
    view,
  });
  const radial = useRadialCreate({
    enabled: arranged && !blocked && !toolsHidden,
    scope: boardId,
    viewport,
  });
  const arrangedCollection = useArrangedCollection({
    enabled: arranged,
    boardId,
    blocked,
    toolsHidden,
    workspace,
    arrangement,
    viewport,
    dockedCollectionId,
    selection,
    setSelection,
    onExit,
    onToast,
    suppressClick,
  });
  const contentPoint = (point) =>
    arranged
      ? { x: point.x, y: point.y + (viewport.current?.scrollTop || 0) }
      : screenToWorld(point, live.current.view);
  const changeImage = (key, changes) => {
    if (live.current.blocked) return;
    update((s) => {
      const object = s.objects.find((o) => o.id === key && o.type === "image");
      if (
        !object ||
        effectivelyLocked(s.objects, key) ||
        object.boardId !== live.current.boardId
      )
        return s;
      return patchObjects(s, {
        [key]: typeof changes === "function" ? changes(object) : changes,
      });
    });
  };
  const exitImageEdit = (cancel = false, after) => {
    if (!imageEdit && !imageMenu) return false;
    const close = () => {
      setImageEdit(null);
      setImageMenu(false);
      after?.();
    };
    if (cancel || blocked || imageLocked) {
      imageEditor.current?.cancel();
      close();
    } else if (imageMode === "crop") {
      imageEditor.current?.applyCrop();
      close();
    } else if (imageEditor.current) imageEditor.current.finishText(close);
    else close();
    return true;
  };
  useEffect(() => {
    if (
      imageEdit &&
      (!selectedImage ||
        imageEdit.id !== selectedImage.id ||
        blocked ||
        imageLocked ||
        toolsHidden)
    ) {
      imageEditor.current?.cancel();
      setImageEdit(null);
    }
    setImageMenu(false);
  }, [selectedImage?.id, boardId, blocked, imageLocked, toolsHidden]);
  useEffect(() => {
    const outside = (event) => {
      if (!event.target.closest(".image-editor,.image-toolbar")) {
        const composing = imageEditor.current?.isComposing();
        if (composing) {
          event.preventDefault();
          event.stopPropagation();
        }
        exitImageEdit(false, () => {
          if (composing && event.target === viewport.current) setSelection([]);
        });
      }
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  });
  const imageAction = async (action) => {
    const object = selectedImage;
    if (!object) return;
    setImageMenu(false);
    if (action === "view") {
      onImagePreview({
        object,
        url: assetUrls.get(object.assetId),
        alt: object.alt,
      });
      return;
    }
    if (action.startsWith("locate:")) {
      onReference(action.slice(7));
      return;
    }
    if (action.startsWith("download-")) {
      if (exportingImage.current) return;
      exportingImage.current = true;
      try {
        const blob = workspace.assets.get(object.assetId);
        if (!blob) throw new Error("原始图片资源不可用。");
        const name =
          state.assets[object.assetId]?.name || object.alt || "轻单图片";
        if (action === "download-original") downloadBlob(blob, name);
        else
          downloadBlob(
            await exportImage(object, blob),
            `${name.replace(/\.[^.]+$/, "")}-标注.png`,
          );
      } catch (error) {
        onToast(error.message);
      } finally {
        exportingImage.current = false;
      }
      return;
    }
    if (action === "cancel") {
      exitImageEdit(true);
      return;
    }
    if (action === "back") {
      exitImageEdit();
      return;
    }
    if (blocked || effectivelyLocked(state.objects, object.id)) return;
    if (action === "annotate" || action === "crop") {
      onExit();
      setImageEdit({ id: object.id, mode: action });
    } else if (action.startsWith("tool:")) {
      imageEditor.current?.finishText(() => setImageTool(action.slice(5)));
    } else if (action === "free") imageEditor.current?.freeCrop();
    else if (action === "square") imageEditor.current?.squareCrop();
    else if (action === "apply") exitImageEdit();
    else if (action === "restore") {
      imageEditor.current?.cancel();
      changeImage(object.id, (o) => imageTransformPatch(o, { crop: null }));
      setImageEdit(null);
    } else if (action === "rotate")
      changeImage(object.id, (o) =>
        imageTransformPatch(o, {
          rotation: ((o.rotation || 0) + (o.flipX ? 270 : 90)) % 360,
        }),
      );
    else if (action === "flip")
      changeImage(object.id, (o) => ({ flipX: !o.flipX }));
    else if (action === "undo") {
      imageEditor.current?.cancel();
      workspace.undo();
    } else if (action === "link") {
      onExit();
      const next = createImageNote(workspace.current.current, object.id);
      const note = next.objects.at(-1);
      arrangement.queueBirth(
        note.id,
        contentPoint(pointer.current || center()),
      );
      update(next);
      setSelection([note.id]);
      onEdit(note.id, note.blocks[1].id);
    }
  };
  const onMeasure = useCallback(
    (key, height) => {
      measured.current.set(key, height);
      if (height <= 0 || live.current.blocked) return;
      update(
        (s) => {
          const note = s.objects.find((o) => o.id === key);
          if (!note || note.type !== "note") return s;
          const frame = s.objects.find((o) => o.id === note.parentId);
          const oldOverhang =
            isInspirationBoard(frame) &&
            note.x < boardLeftLimit(frame, note) - 0.01 &&
            !gesture.current?.started;
          if (
            !oldOverhang &&
            Math.abs((note.layoutHeight || note.height) - height) < 0.5
          )
            return s;
          let changes = { layoutHeight: height };
          if (isInspirationBoard(frame) && !gesture.current?.started) {
            if (effectivelyLocked(s.objects, key)) return s;
            const place = boardPlacement(
              frame,
              { ...note, layoutHeight: height },
              s.objects.map(displayRect),
            );
            if (place)
              changes = {
                ...changes,
                ...place,
                zIndex: Math.max(0, ...s.objects.map((o) => o.zIndex)) + 1,
              };
            else {
              const retained = note.layoutHeight || note.height;
              changes = {
                height: retained,
                layoutHeight: retained,
                fixedHeight: true,
              };
              measured.current.set(key, retained);
            }
          }
          if (Object.keys(changes).length === 1) {
            // Measuring the DOM must not change the shared edit timestamp.
            return normalizeLayout({
              ...s,
              objects: s.objects.map((o) =>
                o.id === key ? { ...o, ...changes } : o,
              ),
            });
          }
          return patchObjects(s, { [key]: changes });
        },
        { record: false, persist: !gesture.current?.started },
      );
    },
    [update],
  );
  const actual = (object) => ({
    ...object,
    height:
      object.type === "frame" && object.collapsed
        ? 56
        : measured.current.get(object.id) || displayRect(object).height,
  });
  const viewportTop = viewport.current?.getBoundingClientRect().top ?? 64;
  const local = (event) => {
    const r = viewport.current.getBoundingClientRect();
    return { x: event.clientX - r.left, y: event.clientY - r.top };
  };
  const center = () => ({
    x: viewport.current.clientWidth / 2,
    y: viewport.current.clientHeight / 2,
  });
  const cancelGesture = useCallback(() => {
    radial.cancel();
    arrangedCollection.cancel();
    clearTimeout(longPress.current);
    clearTimeout(groupTimer.current);
    clearTimeout(alignmentTimer.current);
    const g = gesture.current;
    if (g?.kind === "selection") {
      setSelection(g.selection);
      contextMenuUntil.current = Date.now() + 500;
    }
    if (g?.started && ["move", "resize"].includes(g.kind)) end(true);
    if (g?.kind === "pan" || g?.kind === "pinch") onView(g.view);
    if (g && viewport.current?.hasPointerCapture(g.pointerId))
      viewport.current.releasePointerCapture(g.pointerId);
    gesture.current = null;
    points.current.clear();
    suppressClick.current = false;
    setMarquee(null);
    setBoardDraft(null);
    setDropTarget(null);
    setDragging(false);
    setPlacement(null);
    setGroupHover(null);
    setGuides([]);
    setLifted(null);
    setDragAnchor(null);
  }, [end, onView, setSelection, radial.cancel, arrangedCollection.cancel]);
  useEffect(
    () => () => {
      clearTimeout(groupTimer.current);
      clearTimeout(alignmentTimer.current);
      clearTimeout(longPress.current);
    },
    [],
  );
  useEffect(() => {
    const observer = new ResizeObserver((entries) =>
      setDimensions({
        width: entries[0].contentRect.width,
        height: entries[0].contentRect.height,
      }),
    );
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const urls = new Map();
    for (const [key, blob] of workspace.assets)
      urls.set(key, URL.createObjectURL(blob));
    setAssetUrls(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [workspace.assetVersion]);
  useEffect(() => {
    const keydown = (e) => {
      if (
        e.code === "Space" &&
        live.current.view.mode !== "arranged" &&
        !e.target.closest("input,textarea,[contenteditable=true],[role=menu]")
      ) {
        e.preventDefault();
        space.current = true;
        viewport.current?.classList.add("space-pan");
      }
      if (e.key === "Escape") {
        cancelGesture();
        cancelImages();
      }
      if (e.key === "Alt" && gesture.current?.lastPointer)
        moveRef.current({ ...gesture.current.lastPointer, altKey: true });
    };
    const keyup = (e) => {
      if (e.code === "Space") {
        space.current = false;
        viewport.current?.classList.remove("space-pan");
      }
      if (e.key === "Alt" && gesture.current?.lastPointer)
        moveRef.current({ ...gesture.current.lastPointer, altKey: false });
    };
    const blur = () => {
      space.current = false;
      viewport.current?.classList.remove("space-pan");
      cancelGesture();
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur);
    };
  }, [cancelGesture, cancelImages]);
  useEffect(() => {
    cancelGesture();
    cancelImages();
  }, [boardId, arranged]);
  useEffect(() => {
    if (arranged && temporaryVisible) arrangement.scrollTo(temporaryVisible);
  }, [temporaryVisible, boardId, arranged]);
  useEffect(() => {
    const el = viewport.current;
    const wheel = (event) => {
      if (event.target.closest(".canvas-minimap")) {
        event.preventDefault();
        return;
      }
      if (live.current.view.mode === "arranged") {
        radial.cancel();
        arrangement.interruptRestore();
        return;
      }
      if (
        event.target.closest(".note-paper.is-editing") &&
        !event.ctrlKey &&
        !event.metaKey
      )
        return;
      event.preventDefault();
      const current = live.current.view;
      if (gesture.current?.hover) {
        clearTimeout(groupTimer.current);
        gesture.current.hover = null;
        gesture.current.placement = null;
        setGroupHover(null);
        setPlacement(null);
      }
      onView(
        event.ctrlKey || event.metaKey
          ? zoomAt(
              current,
              local(event),
              current.scale * Math.exp(-event.deltaY * 0.002),
            )
          : {
              ...current,
              x: current.x - (event.shiftKey ? event.deltaY : event.deltaX),
              y: current.y - (event.shiftKey ? 0 : event.deltaY),
            },
      );
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [onView]);
  const addNote = (kind = "text", point, frameId) => {
    if (live.current.blocked) return;
    onExit();
    const note = {
      ...createObject(
        live.current.boardId,
        "note",
        point || contentPoint(pointer.current || center()),
      ),
      noteKind: kind,
    };
    const frame = live.current.state.objects.find(
      (o) =>
        isInspirationBoard(o) &&
        o.boardId === live.current.boardId &&
        !o.collapsed &&
        !hiddenByAncestor(live.current.state.objects, o.id) &&
        (frameId ? o.id === frameId : point && contains(o, point)),
    );
    if (frame) {
      if (effectivelyLocked(live.current.state.objects, frame.id)) return;
      Object.assign(note, {
        width: 236,
        height: 178,
        parentId: frame.id,
        color: ["sand", "sage", "rose"][
          live.current.state.objects.filter((o) => o.parentId === frame.id)
            .length % 3
        ],
      });
      const place = boardPlacement(
        frame,
        note,
        live.current.state.objects.map(actual),
      );
      if (!place) {
        onToast("板内没有足够空间，请先扩大灵感板。");
        return;
      }
      Object.assign(note, place);
      note.zIndex =
        Math.max(0, ...live.current.state.objects.map((o) => o.zIndex)) + 1;
    }
    arrangement.queueBirth(
      note.id,
      point || contentPoint(pointer.current || center()),
    );
    update((s) => ({ ...s, objects: [...s.objects, note] }));
    setSelection([note.id]);
    onEdit(note.id, note.blocks[0].id);
  };
  const pasteText = (text, html = "", point) => {
    if (live.current.blocked || (!text.trim() && !html)) return;
    const note = {
      ...createObject(
        live.current.boardId,
        "note",
        point || contentPoint(pointer.current || center()),
      ),
      noteKind: "checklist",
      blocks: parseClipboard(text, html),
    };
    if (!note.blocks.length) return;
    arrangement.queueBirth(
      note.id,
      point || contentPoint(pointer.current || center()),
    );
    update((s) => ({ ...s, objects: [...s.objects, note] }));
    setSelection([note.id]);
    onPasteFeedback(note.id, text, note.blocks.length);
  };
  const addImages = async (files, point) => {
    if (live.current.blocked) return;
    const board = live.current.boardId,
      target = point || contentPoint(pointer.current || center()),
      token = cancelImport.current;
    const accepted = [...files].filter((file) =>
      /^image\/(png|jpeg|webp|gif|avif|bmp|svg\+xml)$/.test(file.type),
    );
    if (!accepted.length) {
      onToast("请拖入 PNG、JPG、WebP、GIF、SVG 等图片。");
      return;
    }
    const batchId = id("batch");
    pendingBatches.current.add(batchId);
    const placeholders = accepted.map((file, i) => ({
      id: id("loading"),
      x: target.x + i * 24,
      y: target.y + i * 24,
      boardId: board,
    }));
    setPendingImages((p) => [...p, ...placeholders]);
    try {
      const decoded = await Promise.all(
        accepted.map(async (file, index) => {
          const url = URL.createObjectURL(file);
          let size;
          try {
            size = await new Promise((resolve, reject) => {
              const image = new Image();
              image.onload = () =>
                resolve({
                  width: image.naturalWidth,
                  height: image.naturalHeight,
                });
              image.onerror = () =>
                reject(new Error(`无法读取图片：${file.name}`));
              image.src = url;
            });
          } finally {
            URL.revokeObjectURL(url);
          }
          const key = id("asset"),
            scale = Math.min(1, 460 / size.width, 380 / size.height);
          return {
            file,
            key,
            meta: {
              id: key,
              name: file.name || "粘贴图片",
              mime: file.type,
              byteLength: file.size,
            },
            object: {
              ...createObject(board, "image", {
                x: target.x + index * 24,
                y: target.y + index * 24,
              }),
              assetId: key,
              alt: file.name || "粘贴图片",
              naturalWidth: size.width,
              naturalHeight: size.height,
              width: size.width * scale,
              height: size.height * scale,
            },
          };
        }),
      );
      if (
        token !== cancelImport.current ||
        !workspace.current.current.boards.some((b) => b.id === board)
      )
        return;
      workspace.addAssets(decoded.map((item) => [item.key, item.file]));
      if (
        live.current.boardId === board &&
        live.current.view.mode === "arranged"
      )
        decoded.forEach((item) =>
          arrangement.queueBirth(item.object.id, target),
        );
      update((s) => ({
        ...s,
        assets: {
          ...s.assets,
          ...Object.fromEntries(decoded.map((item) => [item.key, item.meta])),
        },
        objects: [...s.objects, ...decoded.map((item) => item.object)],
      }));
      if (live.current.boardId === board)
        setSelection(decoded.map((item) => item.object.id));
      onToast(`已添加 ${decoded.length} 张图片`);
    } catch (error) {
      if (token === cancelImport.current) onToast(error.message);
    } finally {
      pendingBatches.current.delete(batchId);
      setPendingImages((p) =>
        p.filter((o) => !placeholders.some((x) => x.id === o.id)),
      );
    }
  };
  useEffect(() => {
    apiRef.current = {
      addNote,
      addImages,
      pasteText,
      archiveSelection: arrangedCollection.collect,
      takeOutArranged: arrangedCollection.takeOut,
      animateTakeOut,
      cancel: () => {
        cancelGesture();
        exitImageEdit(true);
      },
      exitImageEdit,
      cancelImports: cancelImages,
      getPoint: () => contentPoint(pointer.current || center()),
      getSize: () => dimensions,
      measure: actual,
      screenRect: (key) => arrangement.screenRect(key),
      scrollTo: (key) => arrangement.scrollTo(key),
      scrollTop: () => {
        if (viewport.current) {
          arrangement.interruptRestore();
          viewport.current.scrollTop = 0;
          arrangement.saveScroll();
        }
      },
    };
  });
  useEffect(() => {
    const paste = (event) => {
      if (
        event.target.closest("input,textarea,[contenteditable=true]") ||
        live.current.blocked
      )
        return;
      const files = [...event.clipboardData.files];
      if (files.some((f) => f.type.startsWith("image/"))) {
        event.preventDefault();
        addImages(files);
      } else if (event.clipboardData.getData("text/plain")) {
        event.preventDefault();
        pasteText(
          event.clipboardData.getData("text/plain"),
          event.clipboardData.getData("text/html"),
        );
      }
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  });
  const down = (event) => {
    if (event.target.closest(".image-editor,.image-toolbar")) return;
    if (event.target.closest(".radial-create")) return;
    const p = local(event);
    pointer.current = p;
    if (
      !arranged &&
      event.button === 0 &&
      event.ctrlKey &&
      !blocked &&
      !event.target.closest(
        "[data-object-id],button,input,textarea,[contenteditable=true]",
      )
    ) {
      event.preventDefault();
      onExit();
      setSelection([]);
      gesture.current = {
        kind: "board",
        start: p,
        view,
        pointerId: event.pointerId,
      };
      viewport.current.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button === 2) {
      if (
        !arranged &&
        !event.target.closest("button,input,textarea,[contenteditable=true]")
      ) {
        event.preventDefault();
        onExit();
        exitImageEdit();
        gesture.current = {
          kind: "selection",
          start: p,
          view,
          selection,
          snapshot: workspace.current.current,
          objectId: event.target.closest("[data-object-id]")?.dataset.objectId,
          pointerId: event.pointerId,
        };
        viewport.current.setPointerCapture(event.pointerId);
      }
      return;
    }
    if (arranged) {
      arrangement.interruptRestore();
      if (event.button === 1) {
        event.preventDefault();
        return;
      }
      if (
        event.button !== 0 ||
        event.target.closest(
          "button:not(.collection-icon),input,textarea,[contenteditable=true],.note-reference",
        )
      )
        return;
      const key = event.target.closest("[data-object-id]")?.dataset.objectId;
      onExit();
      if (key) {
        const nextSelection = event.shiftKey
          ? selection.includes(key)
            ? selection.filter((id) => id !== key)
            : [...selection, key]
          : selection.includes(key)
            ? selection
            : [key];
        setSelection(nextSelection);
        if (!event.shiftKey)
          arrangedCollection.start(event, key, nextSelection, p);
      } else {
        setSelection([]);
        radial.start(event, contentPoint(p));
      }
      return;
    }
    if (event.pointerType === "touch") {
      points.current.set(event.pointerId, p);
      if (points.current.size === 2) {
        cancelGesture();
        points.current.set(event.pointerId, p);
        const other = lastTouch.current;
        if (other) points.current.set(other.id, other.point);
        const pair = [...points.current.values()];
        if (pair.length === 2) {
          const mid = {
            x: (pair[0].x + pair[1].x) / 2,
            y: (pair[0].y + pair[1].y) / 2,
          };
          gesture.current = {
            kind: "pinch",
            view,
            center: mid,
            distance: Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y),
            pointerId: event.pointerId,
          };
        }
        return;
      }
      lastTouch.current = { id: event.pointerId, point: p };
    }
    if (
      event.target.closest(
        "input,textarea,[contenteditable=true],.note-reference,.object-action,.add-line,.resize-handle",
      )
    )
      return;
    const element = event.target.closest("[data-object-id]"),
      key = element?.dataset.objectId,
      object = objects.get(key);
    if (event.button === 1 || space.current) {
      event.preventDefault();
      onExit();
      gesture.current = {
        kind: "pan",
        start: p,
        view,
        pointerId: event.pointerId,
      };
      return;
    }
    if (event.button !== 0) return;
    if (!object) {
      onExit();
      if (!event.shiftKey) setSelection([]);
      gesture.current = {
        kind: event.shiftKey && !blocked ? "marquee" : "pan",
        start: p,
        view,
        selection: [],
        snapshot: workspace.current.current,
        pointerId: event.pointerId,
      };
    } else {
      if (blocked) return;
      event.preventDefault();
      onExit();
      const chosen = event.shiftKey
        ? selection.includes(key)
          ? selection.filter((x) => x !== key)
          : [...selection, key]
        : selection.includes(key)
          ? selection
          : [key];
      setSelection(chosen);
      if (effectivelyLocked(state.objects, key)) return;
      if (
        isInspirationBoard(object) &&
        !event.target.closest(".frame-heading,.frame-edge")
      )
        return;
      const roots = selectionRoots(state.objects, chosen).filter(
        (key) => key !== dockedCollectionId,
      );
      gesture.current = {
        kind: "move",
        start: p,
        view,
        ids: roots,
        anchorId: key,
        snapshot: normalizeLayout({
          ...workspace.current.current,
          objects: workspace.current.current.objects.map((o) =>
            o.type === "note" ? { ...o, layoutHeight: actual(o).height } : o,
          ),
        }),
        pointerId: event.pointerId,
        modified: event.shiftKey || event.ctrlKey || event.metaKey,
      };
    }
    if (event.pointerType === "touch")
      longPress.current = setTimeout(() => {
        gesture.current = null;
        suppressClick.current = true;
        onContext({
          screen: { x: event.clientX, y: event.clientY },
          world: screenToWorld(p, view),
          objectId: key,
        });
      }, 550);
  };
  const lastTouch = useRef(null);
  const move = (event) => {
    const p = local(event);
    pointer.current = p;
    if (arranged) {
      radial.move(event);
      arrangedCollection.move(event, p);
      return;
    }
    const g = gesture.current;
    if (points.current.has(event.pointerId))
      points.current.set(event.pointerId, p);
    if (!g) return;
    if (g.kind === "pinch") {
      const pair = [...points.current.values()];
      if (pair.length === 2) {
        const mid = {
            x: (pair[0].x + pair[1].x) / 2,
            y: (pair[0].y + pair[1].y) / 2,
          },
          distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        const next = zoomAt(
          g.view,
          g.center,
          (g.view.scale * distance) / Math.max(g.distance, 1),
        );
        onView({
          ...next,
          x: next.x + mid.x - g.center.x,
          y: next.y + mid.y - g.center.y,
        });
      }
      return;
    }
    if (event.pointerId !== g.pointerId) return;
    const dx = p.x - g.start.x,
      dy = p.y - g.start.y;
    if (!g.started) {
      if (Math.hypot(dx, dy) < 4) return;
      clearTimeout(longPress.current);
      g.started = true;
      setDragging(true);
      viewport.current.setPointerCapture(event.pointerId);
      if (["move", "resize"].includes(g.kind)) begin();
      if (g.kind === "move" && g.ids.length === 1) {
        const first = g.snapshot.objects.find((o) => o.id === g.ids[0]);
        if (
          first?.type === "image" &&
          movableIds(g.snapshot, g.ids).has(first.id)
        )
          setLifted(first.id);
      }
    }
    if (g.kind === "pan") {
      onView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
      return;
    }
    if (["marquee", "selection", "board"].includes(g.kind)) {
      const a = screenToWorld(g.start, g.view),
        b = screenToWorld(p, g.view),
        rect = {
          x: Math.min(a.x, b.x),
          y: Math.min(a.y, b.y),
          width: Math.abs(a.x - b.x),
          height: Math.abs(a.y - b.y),
        };
      if (g.kind === "board") {
        g.rect = rect;
        g.boardBlocked = visibleInspirationBoards(
          workspace.current.current.objects,
          boardId,
        ).some((frame) => boardsOverlap(rect, frame));
        setBoardDraft({ ...rect, blocked: g.boardBlocked });
        return;
      }
      setMarquee(rect);
      g.chosen = marqueeRoots(
        g.snapshot.objects.filter(
          (o) => o.boardId === boardId && o.id !== dockedCollectionId,
        ),
        rect,
        (o) => isShown(o, g.snapshot.objects),
        { promoteGroups: g.kind === "marquee" },
      );
      setSelection(g.chosen);
      return;
    }
    if (g.kind === "resize") {
      clearTimeout(alignmentTimer.current);
      g.lastPointer = {
        clientX: event.clientX,
        clientY: event.clientY,
        pointerId: event.pointerId,
        altKey: event.altKey,
      };
      const o = g.object;
      const board = isInspirationBoard(o);
      const scale = g.view.scale;
      const now = Date.now();
      let width = Math.max(o.type === "image" ? 40 : 160, o.width + dx / scale),
        height = Math.max(70, o.height + dy / scale);
      if (o.type === "image") {
        const frame = imageFrame(o);
        height = (width * frame.height) / frame.width;
      }
      const constrainBoard = (w, h) =>
        boardResize(
          o,
          w,
          h,
          g.snapshot.objects.filter((n) => n.parentId === o.id).map(actual),
          visibleInspirationBoards(g.snapshot.objects, boardId).filter(
            (n) => n.id !== o.id,
          ),
        );
      if (board) ({ width, height } = constrainBoard(width, height));
      const freeSize = { width, height };
      const rawRect = { ...o, ...freeSize };
      const previousRect = g.resizeRawRect || o;
      g.resizeRawRect = rawRect;
      let resizeSnap = null;
      if ((o.type === "note" || board) && !event.altKey) {
        const flexibleParents = new Set(
          ancestors(g.snapshot.objects, o.id)
            .filter(
              (parent) =>
                parent.type === "frame" && !isInspirationBoard(parent),
            )
            .map((parent) => parent.id),
        );
        const targets = g.snapshot.objects
          .filter(
            (target) =>
              target.id !== o.id &&
              target.boardId === boardId &&
              target.type !== "collection" &&
              !flexibleParents.has(target.id) &&
              isShown(target, g.snapshot.objects),
          )
          .map(actual);
        resizeSnap = snapResize(rawRect, targets, scale, g.resizeSnaps, {
          now,
          previousRect,
          minWidth: board ? 240 : 160,
          minHeight: board ? 180 : 70,
        });
        ({ width, height } = resizeSnap);
        if (board) {
          ({ width, height } = constrainBoard(width, height));
          // Attraction must not violate another board's gap or a child anchor.
          if (Math.abs(width - resizeSnap.width) > 0.001)
            resizeSnap.snaps.x = null;
          if (Math.abs(height - resizeSnap.height) > 0.001)
            resizeSnap.snaps.y = null;
        }
      }
      const parent = g.snapshot.objects.find((p) => p.id === o.parentId);
      let memberPlacement = {};
      if (isInspirationBoard(parent)) {
        const placeMember = () =>
          boardPlacement(
            parent,
            {
              ...o,
              width,
              height,
              ...(o.type === "note" ? { layoutHeight: height } : {}),
            },
            g.snapshot.objects.map(actual),
          );
        let pos = placeMember();
        if (
          resizeSnap &&
          (!pos ||
            (resizeSnap.snaps.x &&
              Math.abs(pos.x + width - resizeSnap.snaps.x.at) > 0.001) ||
            (resizeSnap.snaps.y &&
              Math.abs(pos.y + height - resizeSnap.snaps.y.at) > 0.001))
        ) {
          // Board anchors and permitted overlap take priority over attraction.
          ({ width, height } = freeSize);
          resizeSnap = null;
          pos = placeMember();
        }
        if (!pos) {
          g.resizeSnaps = null;
          return;
        }
        memberPlacement = {
          ...pos,
          zIndex: Math.max(0, ...g.snapshot.objects.map((p) => p.zIndex)) + 1,
        };
      }
      g.resizeSnaps = resizeSnap?.snaps || null;
      const resumeAt = Math.min(
        ...["x", "y"].map((axis) => {
          const snap = g.resizeSnaps?.[axis];
          const edge =
            rawRect[axis] + rawRect[axis === "x" ? "width" : "height"];
          return snap?.holdUntil > now &&
            Math.abs(edge - snap.at) > ALIGNMENT_SNAP_RELEASE_PX / scale
            ? snap.holdUntil
            : Infinity;
        }),
      );
      if (Number.isFinite(resumeAt))
        alignmentTimer.current = setTimeout(
          () => {
            if (gesture.current === g && !live.current.blocked)
              moveRef.current(g.lastPointer);
          },
          Math.max(1, resumeAt - now),
        );
      update(
        patchObjects(g.snapshot, {
          [o.id]: {
            width,
            height,
            ...memberPlacement,
            ...(o.type === "note"
              ? { fixedHeight: true, layoutHeight: height }
              : {}),
          },
        }),
        { record: false, persist: false, source: g.snapshot },
      );
      const resized = { ...o, width, height, ...memberPlacement };
      const topLeft = screenToWorld({ x: 0, y: 0 }, view);
      const bottomRight = screenToWorld(
        { x: dimensions.width, y: dimensions.height },
        view,
      );
      setGuides([
        ...[resized.x, resized.x + resized.width].map((at) => ({
          axis: "x",
          at,
          from: Math.min(topLeft.y, resized.y),
          to: Math.max(bottomRight.y, resized.y + resized.height),
        })),
        ...[resized.y, resized.y + resized.height].map((at) => ({
          axis: "y",
          at,
          from: Math.min(topLeft.x, resized.x),
          to: Math.max(bottomRight.x, resized.x + resized.width),
        })),
      ]);
      return;
    }
    clearTimeout(alignmentTimer.current);
    let delta = { x: dx / g.view.scale, y: dy / g.view.scale };
    const movingIds = movableIds(g.snapshot, g.ids);
    if (!movingIds.size) return;
    const rawAnchor = g.snapshot.objects.find(
      (o) => o.id === (g.anchorId || g.ids[0]),
    );
    const overDock =
      dockedCollection &&
      rawAnchor &&
      movingIds.has(rawAnchor.id) &&
      !effectivelyLocked(g.snapshot.objects, dockedCollection.id) &&
      !event.altKey &&
      collectionTouches(
        g.snapshot.objects
          .filter((o) => g.ids.includes(o.id) && movingIds.has(o.id))
          .map((o) => ({ ...actual(o), x: o.x + delta.x, y: o.y + delta.y })),
        collectionRect(dockedCollection),
      );
    if (view.snapEnabled && !event.altKey && !overDock) {
      const first = g.snapshot.objects.find((o) => o.id === g.ids[0]);
      if (first)
        delta = {
          x: Math.round((first.x + delta.x) / 16) * 16 - first.x,
          y: Math.round((first.y + delta.y) / 16) * 16 - first.y,
        };
    }
    const roots = g.snapshot.objects.filter(
      (o) => g.ids.includes(o.id) && movingIds.has(o.id),
    );
    const pauseAlignment = roots.some(
      (o) => o.type === "note" || isInspirationBoard(o),
    );
    const onFixedBoard = roots.some((o) =>
      isInspirationBoard(g.snapshot.objects.find((p) => p.id === o.parentId)),
    );
    const barriers = frameDragBarriers(g.snapshot.objects, roots);
    const protectedIds = descendantIds(
      g.snapshot.objects,
      barriers
        .filter(({ frame }) => !pauseAlignment || !isInspirationBoard(frame))
        .map(({ frame }) => frame.id),
    );
    const rect = bounds(roots.map(actual));
    const wanted = { ...rect, x: rect.x + delta.x, y: rect.y + delta.y };
    const previousRect = g.moveRawRect || rect;
    g.moveRawRect = wanted;
    const now = Date.now();
    let moveSnap = null;
    let nextGuides = [];
    if (!event.altKey && !overDock && (!onFixedBoard || pauseAlignment)) {
      const parentIds = new Set(
        roots.flatMap((o) =>
          ancestors(g.snapshot.objects, o.id).map((p) => p.id),
        ),
      );
      const targets = g.snapshot.objects
        .filter(
          (o) =>
            o.boardId === boardId &&
            o.type !== "collection" &&
            !movingIds.has(o.id) &&
            !parentIds.has(o.id) &&
            !protectedIds.has(o.id) &&
            isShown(o, g.snapshot.objects),
        )
        .map(actual);
      const snap = snapMove(wanted, targets, view.scale, g.moveSnaps, {
        pause: pauseAlignment,
        now,
        previousRect,
      });
      if (pauseAlignment) moveSnap = snap;
      delta = { x: snap.x - rect.x, y: snap.y - rect.y };
      nextGuides = snap.guides;
    }
    const requestedDelta = { ...delta };
    if ((!overDock || roots.some(isInspirationBoard)) && barriers.length) {
      // A timer or pointerup can re-evaluate an unchanged pointer. Do not apply
      // the blocked part of its previous movement a second time around a corner.
      const unchanged =
        g.lastPointer?.clientX === event.clientX &&
        g.lastPointer?.clientY === event.clientY &&
        g.lastPointer?.altKey === !!event.altKey &&
        g.requestedDelta?.x === delta.x &&
        g.requestedDelta?.y === delta.y;
      const limited = constrainFrameMove(
        barriers,
        g.acceptedDelta || { x: 0, y: 0 },
        unchanged ? g.acceptedDelta : delta,
        { scale: view.scale, snap: !event.altKey },
      );
      nextGuides = nextGuides.filter(
        (guide) => Math.abs(limited[guide.axis] - delta[guide.axis]) < 0.001,
      );
      nextGuides.push(...limited.guides);
      delta = { x: limited.x, y: limited.y };
    }
    if (!overDock) {
      for (const note of roots) {
        const parent = g.snapshot.objects.find((o) => o.id === note.parentId);
        if (
          note.type === "note" &&
          isInspirationBoard(parent) &&
          !movingIds.has(parent.id)
        ) {
          delta.x = Math.max(delta.x, boardLeftLimit(parent, note) - note.x);
        }
      }
    }
    // Board separation and member limits win over attraction on either axis.
    for (const axis of ["x", "y"]) {
      if (
        moveSnap?.snaps[axis] &&
        Math.abs(delta[axis] + rect[axis] - moveSnap[axis]) > 0.001
      )
        moveSnap.snaps[axis] = null;
    }
    nextGuides = nextGuides.filter(
      (guide) =>
        !moveSnap || guide.ownEdge === undefined || moveSnap.snaps[guide.axis],
    );
    g.moveSnaps = moveSnap?.snaps || null;
    const resumeAt = Math.min(
      ...["x", "y"].map((axis) => {
        const snap = g.moveSnaps?.[axis];
        return snap?.holdUntil > now &&
          Math.abs(wanted[axis] - snap.position) >
            ALIGNMENT_SNAP_RELEASE_PX / view.scale
          ? snap.holdUntil
          : Infinity;
      }),
    );
    if (Number.isFinite(resumeAt))
      alignmentTimer.current = setTimeout(
        () => {
          if (gesture.current === g && !live.current.blocked)
            moveRef.current(g.lastPointer);
        },
        Math.max(1, resumeAt - now),
      );
    g.requestedDelta = requestedDelta;
    g.acceptedDelta = delta;
    g.lastPointer = {
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
      altKey: !!event.altKey,
    };
    setGuides(nextGuides);
    let moved = moveObjects(g.snapshot, g.ids, delta, {
      constrainBoards: false,
    });
    const world = screenToWorld(p, view);
    const startWorld = screenToWorld(g.start, g.view);
    const acceptedPointer = {
      x: startWorld.x + delta.x,
      y: startWorld.y + delta.y,
    };
    const first = roots.length === 1 ? roots[0] : null;
    if (first?.type === "image" && first.parentId) {
      const parent = g.snapshot.objects.find((o) => o.id === first.parentId);
      if (
        parent?.type === "frame" &&
        !isInspirationBoard(parent) &&
        (event.altKey ||
          !contains(
            {
              ...parent,
              x: parent.x - 24,
              y: parent.y - 24,
              width: parent.width + 48,
              height: parent.height + 48,
            },
            acceptedPointer,
          ))
      )
        g.detached = true;
      if (g.detached) moved = reparentObjects(moved, [first.id], null);
    }
    const anchor = moved.objects.find((o) => o.id === (g.anchorId || g.ids[0]));
    const canCollect = anchor && movingIds.has(anchor.id);
    setDragAnchor(canCollect ? { x: anchor.x, y: anchor.y } : null);
    const drop =
      event.altKey || !canCollect
        ? null
        : g.snapshot.objects
            .filter(
              (o) =>
                o.boardId === boardId &&
                o.type === "collection" &&
                !effectivelyLocked(g.snapshot.objects, o.id) &&
                !hiddenByAncestor(g.snapshot.objects, o.id) &&
                !movingIds.has(o.id) &&
                collectionTouches(
                  moved.objects
                    .filter(
                      (item) =>
                        g.ids.includes(item.id) && movingIds.has(item.id),
                    )
                    .map(actual),
                  collectionRect(o),
                ),
            )
            .sort(
              (a, b) =>
                (b.id === dockedCollectionId) - (a.id === dockedCollectionId) ||
                b.zIndex - a.zIndex,
            )[0];
    g.drop = drop?.id;
    setDropTarget(drop?.id || null);
    let nextPlacement = null;
    const ungrouped = roots.every((o) => !o.parentId);
    let target = null;
    if ((ungrouped || first?.type === "image") && !drop && !event.altKey) {
      const targets = g.snapshot.objects
        .filter(
          (o) =>
            o.type === "frame" &&
            o.boardId === boardId &&
            !o.collapsed &&
            !movingIds.has(o.id) &&
            !effectivelyLocked(g.snapshot.objects, o.id) &&
            !hiddenByAncestor(g.snapshot.objects, o.id) &&
            roots.every((root) =>
              canDragIntoFrame(g.snapshot.objects, root, o),
            ) &&
            contains(o, world),
        )
        .sort(
          (a, b) =>
            ancestors(g.snapshot.objects, b.id).length -
              ancestors(g.snapshot.objects, a.id).length || b.zIndex - a.zIndex,
        );
      target = targets[0];
      if (target?.id === first?.parentId && !g.detached) target = null;
    }
    if (ungrouped && target) {
      if (g.hover?.id !== target.id) {
        clearTimeout(groupTimer.current);
        const hover = {
          id: target.id,
          since: Date.now(),
          duration: isInspirationBoard(target)
            ? BOARD_DWELL_MS
            : GROUP_DWELL_MS,
        };
        g.hover = hover;
        groupTimer.current = setTimeout(() => {
          if (
            gesture.current === g &&
            g.hover === hover &&
            !live.current.blocked
          )
            moveRef.current(g.lastPointer);
        }, hover.duration);
      }
      const ready = Date.now() - g.hover.since >= g.hover.duration;
      setGroupHover({
        ...g.hover,
        title: target.title,
        ready,
        frame: target,
        x: p.x,
        y: p.y,
      });
      if (!ready) target = null;
    } else {
      clearTimeout(groupTimer.current);
      g.hover = null;
      setGroupHover(null);
    }
    if (target) {
      const surroundingFor = (frame) => {
        const tree = descendantIds(moved.objects, [frame.id]),
          parents = new Set(
            ancestors(moved.objects, frame.id).map((o) => o.id),
          );
        return moved.objects.filter(
          (o) =>
            o.boardId === boardId &&
            !movingIds.has(o.id) &&
            !tree.has(o.id) &&
            !parents.has(o.id) &&
            isShown(o, moved.objects),
        );
      };
      const origin = bounds(
          moved.objects
            .filter((o) => roots.some((root) => root.id === o.id))
            .map(actual),
        ),
        members = moved.objects.filter(
          (o) => o.parentId === target.id && !movingIds.has(o.id),
        );
      let childId = target.id;
      const parents = ancestors(moved.objects, target.id)
        .filter((o) => o.type === "frame")
        .map((frame) => {
          const layer = {
            frame,
            surrounding: surroundingFor(frame),
            members: moved.objects.filter(
              (o) =>
                o.parentId === frame.id &&
                o.id !== childId &&
                !movingIds.has(o.id),
            ),
          };
          childId = frame.id;
          return layer;
        });
      const rect = isInspirationBoard(target)
        ? roots.length === 1
          ? boardPlacement(
              target,
              { ...first, ...origin, parentId: target.id },
              members.map(actual),
            )
          : null
        : placementInFrame(target, origin, members, origin, {
            surrounding: surroundingFor(target),
            ancestors: parents,
          });
      if (rect)
        nextPlacement = {
          ids: roots.map((o) => o.id),
          origin,
          targetId: target.id,
          ...rect,
          frame: frameBounds(target, [...members, rect]),
          fixedBoard: isInspirationBoard(target),
        };
      if (ungrouped && !rect)
        setGroupHover((hover) => ({ ...hover, unavailable: true }));
    }
    g.placement = nextPlacement;
    setPlacement(nextPlacement?.fixedBoard ? null : nextPlacement);
    if (nextPlacement || drop) setGuides([]);
    update(moved, { record: false, persist: false, source: g.snapshot });
  };
  moveRef.current = move;
  useEffect(() => {
    const g = gesture.current;
    if (g?.kind === "move" && g.started && g.lastPointer)
      moveRef.current(g.lastPointer);
  }, [view.x, view.y, view.scale]);
  const up = (event) => {
    if (arranged) {
      radial.up(event);
      arrangedCollection.up(event, local(event));
      return;
    }
    clearTimeout(longPress.current);
    points.current.delete(event.pointerId);
    const g = gesture.current;
    if (!g) {
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      return;
    }
    if (g.kind === "pinch") {
      gesture.current = null;
      points.current.clear();
      return;
    }
    if (g.pointerId !== event.pointerId) return;
    if (g.started) {
      // Re-evaluate the final pointer position and modifiers before committing.
      if (["move", "resize", "selection", "marquee", "board"].includes(g.kind))
        move(event);
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (g.kind === "move" && g.drop && !event.altKey) {
        const before = workspace.current.current;
        const next = collectObjects(before, g.ids, g.drop);
        const target = collectionRect(
          next.objects.find((o) => o.id === g.drop),
        );
        const flights = before.objects
          .filter(
            (o) =>
              g.ids.includes(o.id) &&
              o.parentId !== g.drop &&
              next.objects.find((item) => item.id === o.id)?.parentId ===
                g.drop,
          )
          .map((o) => ({
            token: id(),
            object: actual(o),
            snapshot: before.objects.map(actual),
            visibleIds: new Set(
              before.objects
                .filter((item) => isShown(item, before.objects))
                .map((item) => item.id),
            ),
            target,
            startScale: 1,
            wrapScale: view.scale,
          }));
        setCollectionFlights((previous) => [...previous, ...flights]);
        update(next, {
          record: false,
          persist: false,
        });
      } else if (g.kind === "move" && g.placement && !event.altKey) {
        const slot = g.placement;
        update(
          (s) =>
            reparentObjects(
              moveObjects(s, slot.ids, {
                x: slot.x - slot.origin.x,
                y: slot.y - slot.origin.y,
              }),
              slot.ids,
              slot.targetId,
            ),
          { record: false, persist: false },
        );
      }
      if (g.kind === "move" && !g.drop) {
        const before = workspace.current.current;
        const candidates = before.objects.filter(
          (o) =>
            g.ids.includes(o.id) &&
            movableIds(g.snapshot, g.ids).has(o.id) &&
            isInspirationBoard(before.objects.find((f) => f.id === o.parentId)),
        );
        if (candidates.length) {
          let siblings = before.objects.filter((o) => !candidates.includes(o));
          const patches = {};
          let failed = false;
          let z = Math.max(0, ...before.objects.map((o) => o.zIndex));
          for (const card of candidates) {
            const frame = before.objects.find((o) => o.id === card.parentId);
            const place = boardPlacement(
              frame,
              actual(card),
              siblings.map(actual),
            );
            if (!place) {
              failed = true;
              break;
            }
            patches[card.id] = { ...place, zIndex: ++z };
            siblings.push({ ...card, ...patches[card.id] });
          }
          if (failed) {
            for (const card of candidates) {
              const old = g.snapshot.objects.find((o) => o.id === card.id);
              patches[card.id] = {
                x: old.x,
                y: old.y,
                parentId: old.parentId,
                zIndex: old.zIndex,
              };
            }
            onToast("板内没有合适位置，已返回拖动前的位置。");
          }
          update(patchObjects(before, patches), {
            record: false,
            persist: false,
          });
          window.requestAnimationFrame?.(() => {
            if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
              return;
            for (const card of candidates) {
              const p = patches[card.id];
              const node = viewport.current?.querySelector(
                `[data-object-id="${card.id}"]`,
              );
              node?.animate?.(
                [
                  {
                    transform: `translate(${card.x - p.x}px,${card.y - p.y}px)`,
                  },
                  { transform: "translate(0,0)" },
                ],
                { duration: 180, easing: "ease-out" },
              );
            }
          });
        }
      }
      if (g.kind === "board" && g.rect && !blocked) {
        if (g.boardBlocked) {
          onToast("灵感板之间需要保留 24px 间距，请在空白区域创建。");
        } else if (g.rect.width >= 240 && g.rect.height >= 180) {
          const frame = {
            ...createObject(boardId, "frame", g.rect),
            ...g.rect,
            fixedBounds: true,
            title: "新的灵感板",
          };
          update((s) => ({ ...s, objects: [...s.objects, frame] }));
          setSelection([frame.id]);
        }
      }
      if (g.kind === "marquee" && g.chosen?.length && !blocked) {
        const next = groupObjects(workspace.current.current, g.chosen);
        if (next !== workspace.current.current) {
          update(next);
          setSelection([next.objects.at(-1).id]);
        }
      }
      if (["move", "resize"].includes(g.kind)) end();
    }
    if (g.kind === "selection") {
      contextMenuUntil.current = Date.now() + 500;
      if (!g.started) {
        if (g.objectId && !g.selection.includes(g.objectId))
          setSelection([g.objectId]);
        onContext({
          screen: { x: event.clientX, y: event.clientY },
          world: screenToWorld(local(event), g.view),
          objectId: g.objectId,
        });
      }
    }
    if (viewport.current.hasPointerCapture(event.pointerId))
      viewport.current.releasePointerCapture(event.pointerId);
    gesture.current = null;
    clearTimeout(groupTimer.current);
    clearTimeout(alignmentTimer.current);
    setMarquee(null);
    setBoardDraft(null);
    setDropTarget(null);
    setDragging(false);
    setPlacement(null);
    setGroupHover(null);
    setGuides([]);
    setLifted(null);
    setDragAnchor(null);
  };
  const startResize = (event, object) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (blocked || effectivelyLocked(state.objects, object.id)) return;
    onExit();
    const p = local(event);
    gesture.current = {
      kind: "resize",
      start: p,
      view,
      object: actual(object),
      snapshot: workspace.current.current,
      pointerId: event.pointerId,
    };
    viewport.current.setPointerCapture(event.pointerId);
  };
  const viewRect = {
    ...screenToWorld({ x: -250, y: -250 }, view),
    width: (dimensions.width + 500) / view.scale,
    height: (dimensions.height + 500) / view.scale,
  };
  const movingGesture = gesture.current;
  const floatingIds =
    dragging && movingGesture?.started && movingGesture.kind === "move"
      ? movableIds(movingGesture.snapshot, movingGesture.ids)
      : new Set();
  const visible = boardObjects
    .filter((o) => {
      if (!isShown(o)) return false;
      if (arranged) return arrangement.layout.rects.has(o.id);
      return (
        selection.includes(o.id) ||
        editing?.noteId === o.id ||
        intersects(actual(o), viewRect)
      );
    })
    .sort(
      (a, b) =>
        (a.type === "frame" ? -1 : 0) - (b.type === "frame" ? -1 : 0) ||
        (a.type === "frame" && b.type === "frame"
          ? ancestors(objects, a.id).length - ancestors(objects, b.id).length
          : 0) ||
        a.zIndex - b.zIndex,
    );
  const patch = (object, changes) =>
    update(
      (s) =>
        effectivelyLocked(s.objects, object.id)
          ? s
          : patchObjects(s, { [object.id]: changes }),
      {
        record: editing?.noteId !== object.id,
      },
    );
  const toggle = (object, blockId) => {
    if (
      blocked ||
      effectivelyLocked(workspace.current.current.objects, object.id)
    )
      return;
    return workspace.toggleBlock(object.id, blockId);
  };
  return (
    <main
      ref={viewport}
      className={`canvas ${arranged ? "arranged" : ""} ${dragging || arrangedCollection.session?.phase === "dragging" ? "is-dragging" : ""} ${!arranged && view.gridVisible ? "has-grid" : ""}`}
      aria-label={arranged ? "排列视图" : "自由画布"}
      tabIndex={0}
      style={{
        "--grid-size": `${24 * view.scale}px`,
        "--grid-x": `${view.x}px`,
        "--grid-y": `${view.y}px`,
      }}
      onPointerOver={(event) =>
        setHoveredId(
          event.target.closest("[data-object-id]")?.dataset.objectId || null,
        )
      }
      onPointerLeave={() => setHoveredId(null)}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancelGesture}
      onDoubleClick={(event) => {
        if (
          arranged ||
          blocked ||
          event.target.closest(
            ".frame-heading,.frame-edge,.resize-handle,button,input,textarea,[contenteditable=true]",
          )
        )
          return;
        const key = event.target.closest("[data-object-id]")?.dataset.objectId;
        const frame = objects.get(key);
        if (isInspirationBoard(frame) && !frame.collapsed) {
          event.stopPropagation();
          addNote("checklist", contentPoint(local(event)), frame.id);
        }
      }}
      onScroll={() => {
        if (arranged) {
          radial.cancel();
          arrangedCollection.cancel();
          arrangement.saveScroll();
        }
      }}
      onKeyDown={(event) => {
        if (
          arranged &&
          [
            "PageDown",
            "PageUp",
            "Home",
            "End",
            "ArrowDown",
            "ArrowUp",
            " ",
          ].includes(event.key)
        )
          arrangement.interruptRestore();
      }}
      onClickCapture={(event) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onContextMenu={(event) => {
        if (
          !arranged &&
          (["selection", "board"].includes(gesture.current?.kind) ||
            Date.now() < contextMenuUntil.current)
        ) {
          event.preventDefault();
          return;
        }
        if (event.target.closest("[contenteditable=true]")) return;
        exitImageEdit();
        event.preventDefault();
        radial.cancel();
        arrangedCollection.cancel();
        clearTimeout(longPress.current);
        if (gesture.current?.started) cancelGesture();
        const key = event.target.closest("[data-object-id]")?.dataset.objectId;
        onExit();
        if (key && !selection.includes(key)) setSelection([key]);
        const p = local(event);
        pointer.current = p;
        onContext({
          screen: { x: event.clientX, y: event.clientY },
          world: contentPoint(p),
          objectId: key,
        });
      }}
      onDragOver={(event) => {
        if (
          event.dataTransfer.types.includes("Files") ||
          event.dataTransfer.types.includes("application/x-qingdan-object") ||
          event.dataTransfer.types.includes("application/x-qingdan-note")
        ) {
          event.preventDefault();
          event.dataTransfer.dropEffect = event.dataTransfer.types.includes(
            "Files",
          )
            ? "copy"
            : "move";
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        const point = contentPoint(local(event));
        const objectId =
          event.dataTransfer.getData("application/x-qingdan-object") ||
          event.dataTransfer.getData("application/x-qingdan-note");
        if (objectId) {
          if (blocked) return;
          if (arranged) {
            if (arrangedCollection.takeOut(objectId)) onCollection(null);
            return;
          }
          const before = workspace.current.current;
          const next = takeOutObject(before, objectId, point, boardId);
          if (next === before) return;
          const source = ancestors(before.objects, objectId)
            .filter((o) => o.type === "collection")
            .at(-1);
          if (source) animateTakeOut(objectId, collectionRect(source));
          update(next);
          setSelection([objectId]);
          onCollection(null);
        } else addImages(event.dataTransfer.files, point);
      }}
    >
      {!boardObjects.some((o) => o.id !== dockedCollectionId) &&
        !pendingImages.length && (
          <div className="empty-canvas">
            <div className="empty-mark">
              <StickyNote size={32} strokeWidth={1.25} />
              <span />
            </div>
            <h1>把想法，放在这里。</h1>
            <p>
              {arranged
                ? "长按空白处，选择想要添加的内容"
                : "右键任意位置，开始一张便签"}
            </p>
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => addNote("text", contentPoint(center()))}
            >
              <Plus size={15} />
              新建便签
            </button>
            <div className="empty-tips">
              {arranged ? (
                "长按新建 · 向下滚动浏览"
              ) : (
                <>
                  按住空白处移动画布 <span>·</span> Ctrl + 滚轮缩放
                </>
              )}
            </div>
          </div>
        )}
      <div
        className={`canvas-world ${!arranged && view.scale < 0.3 ? "zoomed-out" : ""}`}
        style={{
          ...(arranged
            ? { height: arrangement.layout.height }
            : {
                transform: `translate(${view.x}px,${view.y}px) scale(${view.scale})`,
              }),
        }}
      >
        {arranged &&
          arrangedCollection.session?.roots.map(({ object }) => (
            <div
              key={`placeholder-${object.id}`}
              className={`arranged-placeholder placeholder-${object.type}`}
              data-placeholder-id={object.id}
              aria-hidden="true"
              style={{
                left: object.x,
                top: object.y,
                width: object.width,
                height: object.height,
              }}
            />
          ))}
        {visible.map((object, index) => {
          const rect = arranged
            ? arrangement.layout.rects.get(object.id)
            : object;
          const renderedObject = arranged
            ? {
                ...object,
                ...rect,
                ...(object.type === "note"
                  ? { height: 108, fixedHeight: false }
                  : {}),
              }
            : object;
          const selected = selection.includes(object.id);
          const editingImage = imageMode && selectedImage?.id === object.id;
          const members = boardObjects.filter((o) => o.parentId === object.id);
          const receiving =
            dropTarget === object.id ||
            arrangedCollection.receiving === object.id ||
            activeFlights.some((f) => f.target.id === object.id);
          const element = (
            <div
              key={object.id}
              ref={
                arranged
                  ? (el) => arrangement.register(object.id, el)
                  : undefined
              }
              className={`canvas-object ${isInspirationBoard(object) ? "inspiration-board" : ""} ${isInspirationBoard(objects.get(object.parentId)) ? "board-member" : ""} ${arranged ? "arranged-object" : ""} object-${object.type} ${selected ? "is-selected" : ""} ${editingImage ? "is-image-editing" : ""} ${temporaryVisible === object.id ? "located" : ""} ${receiving ? "receiving" : ""} ${lifted === object.id ? "is-lifted" : ""} ${placement?.targetId === object.id ? "drop-group" : ""}`}
              data-object-id={object.id}
              style={{
                visibility:
                  arranged && arrangedCollection.hiddenIds.has(object.id)
                    ? "hidden"
                    : undefined,
                left: rect.x,
                top: rect.y,
                width: rect.width,
                ...(object.type === "note"
                  ? {}
                  : {
                      height:
                        object.type === "frame" && object.collapsed
                          ? 56
                          : editingImage && imageMode === "crop"
                            ? (rect.width * object.naturalHeight) /
                              object.naturalWidth
                            : rect.height,
                    }),
                zIndex: receiving
                  ? 100000
                  : lifted === object.id
                    ? visible.length * 3 + 5
                    : object.type === "frame"
                      ? ancestors(objects, object.id).length + 1
                      : temporaryVisible === object.id || editingImage
                        ? visible.length * 2 + 2
                        : visible.length + index + 2,
              }}
            >
              {!arranged &&
                object.type === "note" &&
                isInspirationBoard(objects.get(object.parentId)) && (
                  <div className="board-note-grip">
                    <Grip size={12} />
                    <span>
                      {object.noteKind === "checklist" ? "清单" : "便签"}
                    </span>
                  </div>
                )}
              {arranged &&
                !blocked &&
                !toolsHidden &&
                !editingImage &&
                editing?.noteId !== object.id &&
                dockedCollection &&
                !effectivelyLocked(objects, dockedCollection.id) &&
                movableIds(state, [object.id]).has(object.id) && (
                  <button
                    type="button"
                    className="arranged-archive"
                    aria-label="收纳此元素"
                    title="收纳"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      arrangedCollection.collect([object.id]);
                    }}
                  >
                    <Archive size={14} strokeWidth={1.7} />
                  </button>
                )}
              {object.type === "note" ? (
                <Note
                  object={
                    effectivelyLocked(objects, object.id)
                      ? { ...renderedObject, locked: true }
                      : renderedObject
                  }
                  editing={
                    editing?.noteId === object.id &&
                    !effectivelyLocked(objects, object.id)
                  }
                  focusBlock={editing?.blockId}
                  onEdit={(blockId) =>
                    !blocked &&
                    !effectivelyLocked(objects, object.id) &&
                    onEdit(object.id, blockId)
                  }
                  onPatch={(changes) => !blocked && patch(object, changes)}
                  onExit={onExit}
                  objects={objects}
                  onReference={onReference}
                  onReferencePicker={onReferencePicker}
                  onMeasure={arranged ? arrangement.measure : onMeasure}
                  onToggle={(blockId) => toggle(object, blockId)}
                />
              ) : object.type === "image" ? (
                editingImage ? (
                  <ImageEditor
                    key={`${object.id}-${imageMode}`}
                    ref={imageEditor}
                    object={renderedObject}
                    url={assetUrls.get(object.assetId)}
                    mode={imageMode}
                    tool={imageTool}
                    onAddMark={(mark) =>
                      changeImage(object.id, (o) => ({
                        annotations: [...(o.annotations || []), mark],
                      }))
                    }
                    onCrop={(crop) =>
                      changeImage(object.id, (o) =>
                        imageTransformPatch(o, { crop }),
                      )
                    }
                  />
                ) : (
                  <ImageContent
                    object={renderedObject}
                    url={assetUrls.get(object.assetId)}
                    onDoubleClick={() =>
                      onImagePreview({
                        object,
                        url: assetUrls.get(object.assetId),
                        alt: object.alt,
                      })
                    }
                  />
                )
              ) : object.type === "frame" ? (
                <div
                  className={`group-frame ${object.collapsed ? "collapsed" : ""}`}
                >
                  {["top", "right", "bottom", "left"].map((side) => (
                    <div key={side} className={`frame-edge edge-${side}`} />
                  ))}
                  <div className="frame-heading">
                    <button
                      className="object-action"
                      aria-label={object.collapsed ? "展开分组" : "折叠分组"}
                      onClick={() =>
                        patch(object, { collapsed: !object.collapsed })
                      }
                    >
                      {object.collapsed ? (
                        <ChevronRight size={16} />
                      ) : (
                        <ChevronDown size={16} />
                      )}
                    </button>
                    <span className="frame-title" title={object.title}>
                      {object.title}
                    </span>
                    {(!isInspirationBoard(object) || object.collapsed) && (
                      <small>{members.length}</small>
                    )}
                    {object.locked && <LockKeyhole size={12} />}
                    {isInspirationBoard(object) && !object.collapsed && (
                      <button
                        className="object-action board-add"
                        aria-label="板内新建清单"
                        disabled={
                          blocked || effectivelyLocked(objects, object.id)
                        }
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() =>
                          addNote(
                            "checklist",
                            { x: object.x + 28, y: object.y + 72 },
                            object.id,
                          )
                        }
                      >
                        <Plus size={14} />
                        清单
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="collection-icon"
                  aria-label={`${object.title}，${members.length} 项，点击展开`}
                  title={`${object.title} · ${members.length} 项`}
                  onClick={() => {
                    if (!suppressClick.current) onCollection(object.id);
                  }}
                >
                  <Archive size={46} strokeWidth={1.35} />
                  {members.length > 0 && (
                    <span className="collection-count">{members.length}</span>
                  )}
                </button>
              )}
              {selected &&
                !arranged &&
                !effectivelyLocked(objects, object.id) &&
                !["frame", "collection"].includes(object.type) &&
                !editingImage &&
                !(object.type === "frame" && object.collapsed) && (
                  <button
                    className="resize-handle"
                    aria-label={`调整${objectLabel(object)}大小`}
                    onPointerDown={(event) => startResize(event, object)}
                  >
                    <Grip size={12} />
                  </button>
                )}
            </div>
          );
          // Pointer capture stays on the viewport while only moving objects
          // leave the world's stacking context. Saved z-order is unchanged.
          return dragLayer &&
            (floatingIds.has(object.id) || returningIds.has(object.id))
            ? createPortal(element, dragLayer, object.id)
            : element;
        })}
        {!arranged &&
          !blocked &&
          visible
            .filter(
              (object) =>
                isInspirationBoard(object) &&
                !object.collapsed &&
                !effectivelyLocked(objects, object.id) &&
                !floatingIds.has(object.id) &&
                !returningIds.has(object.id),
            )
            .map((object) => (
              <button
                key={`resize-${object.id}`}
                data-resize-board={object.id}
                className="resize-handle inspiration-resize"
                aria-label={`调整${objectLabel(object)}大小`}
                style={{
                  left: object.x + object.width - 26,
                  top: object.y + object.height - 26,
                  right: "auto",
                  bottom: "auto",
                  zIndex: visible.length * 2 + 4,
                }}
                onPointerDown={(event) => startResize(event, object)}
              >
                <Grip size={12} />
              </button>
            ))}
        {pendingImages
          .filter((o) => o.boardId === boardId)
          .map((o) => (
            <div
              key={o.id}
              className="image-placeholder"
              style={{ left: o.x, top: o.y }}
            >
              正在读取图片…<button onClick={cancelImages}>取消</button>
            </div>
          ))}
        {marquee && (
          <div
            className="marquee"
            style={{
              left: marquee.x,
              top: marquee.y,
              width: marquee.width,
              height: marquee.height,
            }}
          />
        )}
        {boardDraft && (
          <div
            className={`inspiration-draft ${boardDraft.blocked ? "is-blocked" : ""}`}
            style={{
              left: boardDraft.x,
              top: boardDraft.y,
              width: boardDraft.width,
              height: boardDraft.height,
            }}
          />
        )}
        {placement && (
          <>
            <div
              className="placement-frame"
              style={{
                left: placement.frame.x,
                top: placement.frame.y,
                width: placement.frame.width,
                height: placement.frame.height,
              }}
            />
            <div
              className="placement-preview"
              aria-label="元素落位预览"
              style={{
                left: placement.x,
                top: placement.y,
                width: placement.width,
                height: placement.height,
              }}
            >
              <span>松手放入分组</span>
            </div>
          </>
        )}
        {groupHover &&
          !groupHover.ready &&
          !isInspirationBoard(groupHover.frame) && (
            <div
              className="group-hover-frame"
              style={{
                left: groupHover.frame.x,
                top: groupHover.frame.y,
                width: groupHover.frame.width,
                height: groupHover.frame.height,
              }}
            />
          )}
        {guides.length > 0 && (
          <svg className="snap-guides" aria-hidden="true">
            {guides.map((g, i) => (
              <line
                key={i}
                x1={g.axis === "x" ? g.at : g.from}
                y1={g.axis === "y" ? g.at : g.from}
                x2={g.axis === "x" ? g.at : g.to}
                y2={g.axis === "y" ? g.at : g.to}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
        )}
      </div>
      {dockedCollection && (
        <div
          className={`collection-dock object-collection ${dropTarget === dockedCollection.id || arrangedCollection.receiving === dockedCollection.id || activeFlights.some((f) => f.target.id === dockedCollection.id) ? "receiving" : ""}`}
          data-object-id={dockedCollection.id}
          style={{
            left: COLLECTION_DOCK.x,
            top: COLLECTION_DOCK.y + (arranged ? viewportTop : 0),
            width: COLLECTION_DOCK.width,
            height: COLLECTION_DOCK.height,
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
            onExit();
            setSelection([]);
          }}
        >
          <button
            type="button"
            className="collection-icon"
            aria-label={`${dockedCollection.title}，${boardObjects.filter((o) => o.parentId === dockedCollection.id).length} 项，点击展开`}
            title={`${dockedCollection.title} · 固定在左上角`}
            onClick={() => {
              if (!suppressClick.current) onCollection(dockedCollection.id);
            }}
          >
            <Archive size={28} strokeWidth={1.35} />
            {boardObjects.some((o) => o.parentId === dockedCollection.id) && (
              <span className="collection-count">
                {
                  boardObjects.filter((o) => o.parentId === dockedCollection.id)
                    .length
                }
              </span>
            )}
          </button>
        </div>
      )}
      {arranged && (
        <ArrangedCollectionOverlay
          session={arrangedCollection.session}
          viewport={viewport}
          objects={objects}
          assetUrls={assetUrls}
          onDone={arrangedCollection.cancel}
        />
      )}
      <div
        ref={setDragLayer}
        className={`canvas-drag-layer ${view.scale < 0.3 ? "zoomed-out" : ""}`}
        aria-hidden="true"
        inert
        style={{
          transform: `translate(${view.x}px,${view.y}px) scale(${view.scale})`,
        }}
      >
        {!arranged &&
          dropTarget &&
          dragging &&
          movingGesture?.kind === "move" && (
            <CollectionWrap
              key={dropTarget}
              rects={boardObjects
                .filter(
                  (o) =>
                    movingGesture.ids.includes(o.id) && floatingIds.has(o.id),
                )
                .map(actual)}
              target={collectionRect(objects.get(dropTarget))}
              scale={view.scale}
            />
          )}
        {activeFlights.map((flight) => (
          <CollectionFlight
            key={flight.token}
            flight={flight}
            assetUrls={assetUrls}
            objects={objects}
            onDone={finishCollectionFlight}
          />
        ))}
        {dragAnchor && (
          <span
            className={`collection-anchor ${dropTarget ? "is-receiving" : ""}`}
            style={{
              left: dragAnchor.x,
              top: dragAnchor.y,
              width: 8 / view.scale,
              height: 8 / view.scale,
              borderWidth: 1.5 / view.scale,
            }}
          />
        )}
      </div>
      {groupHover && (
        <div
          className={`group-drop-hint ${groupHover.ready ? "is-ready" : ""}`}
          data-target-id={groupHover.id}
          role="status"
          style={{
            left: Math.max(
              8,
              Math.min(groupHover.x + 18, dimensions.width - 220),
            ),
            top: Math.max(
              8,
              Math.min(groupHover.y + 18, dimensions.height - 68),
            ),
          }}
        >
          <span>
            {groupHover.unavailable
              ? "空间不足，请调整位置"
              : groupHover.ready
                ? "松手放入"
                : `停留 ${groupHover.duration / 1000} 秒后放入`}
            「{groupHover.title || "未命名分组"}」
          </span>
          <span className="group-dwell-track" aria-hidden="true">
            <i
              key={`${groupHover.id}-${groupHover.since}`}
              style={{ animationDuration: `${groupHover.duration}ms` }}
            />
          </span>
        </div>
      )}
      {selectedImage &&
        visible.some((o) => o.id === selectedImage.id) &&
        !dragging &&
        !arrangedCollection.session &&
        !toolsHidden && (
          <ImageToolbar
            rect={{
              x: arranged
                ? arrangement.screenRect(selectedImage.id)?.x
                : selectedImage.x * view.scale + view.x,
              y: arranged
                ? arrangement.screenRect(selectedImage.id)?.y
                : selectedImage.y * view.scale + view.y,
              width: arranged
                ? arrangement.screenRect(selectedImage.id)?.width
                : selectedImage.width * view.scale,
              height: arranged
                ? arrangement.screenRect(selectedImage.id)?.height
                : (imageMode === "crop"
                    ? (selectedImage.width * selectedImage.naturalHeight) /
                      selectedImage.naturalWidth
                    : selectedImage.height) * view.scale,
            }}
            dimensions={dimensions}
            viewportOffset={arranged ? viewportTop : 0}
            mode={imageMode}
            tool={imageTool}
            onAction={imageAction}
            disabled={blocked || effectivelyLocked(objects, selectedImage.id)}
            canUndo={workspace.canUndo}
            notes={state.objects
              .filter(
                (o) =>
                  o.type === "note" &&
                  o.blocks.some((b) =>
                    b.runs.some(
                      (r) =>
                        r.type === "ref" && r.targetId === selectedImage.id,
                    ),
                  ),
              )
              .map((o) => ({ id: o.id, label: objectLabel(o) }))}
            menu={imageMenu}
            setMenu={setImageMenu}
          />
        )}
      {!arranged && !toolsHidden && (
        <Minimap
          key={boardId}
          objects={boardObjects
            .filter((o) => isShown(o) && o.type !== "collection")
            .map(actual)}
          view={view}
          size={dimensions}
          onView={onView}
          assetUrls={assetUrls}
          disabled={blocked}
          onLocate={(id) => {
            onExit();
            setSelection([id]);
          }}
        />
      )}
      <RadialCreate
        menu={radial.menu}
        onCancel={radial.cancel}
        onChoose={(kind, point) => {
          radial.cancel();
          if (kind === "image") onPickImages?.(point);
          else addNote(kind, point);
        }}
      />
    </main>
  );
}

// A task keeps its creator even when another member edits, completes or restores it.
export const taskAuthorKey = (noteId, blockId) =>
  JSON.stringify([noteId, blockId]);
export const taskAuthor = (block) =>
  block.createdByUserId
    ? {
        createdByUserId: block.createdByUserId,
        ...(block.createdByName !== undefined
          ? { createdByName: block.createdByName }
          : {}),
      }
    : {};

export function validTaskAuthor(block) {
  return (
    (block.createdByUserId === undefined ||
      (typeof block.createdByUserId === "string" &&
        block.createdByUserId.length > 0 &&
        block.createdByUserId.length <= 256)) &&
    (block.createdByName === undefined ||
      (block.createdByUserId !== undefined &&
        typeof block.createdByName === "string" &&
        block.createdByName.trim().length > 0 &&
        block.createdByName.length <= 80))
  );
}

export function withTaskAuthor(block, author) {
  if (
    block.createdByUserId === author.createdByUserId &&
    block.createdByName === author.createdByName
  )
    return block;
  const { createdByUserId, createdByName, ...rest } = block;
  return { ...rest, ...author };
}

export function rememberTaskAuthors(objects, known) {
  for (const note of objects) {
    if (note.type !== "note" || !Array.isArray(note.blocks)) continue;
    for (const block of note.blocks)
      known.set(taskAuthorKey(note.id, block.id), taskAuthor(block));
  }
}

export function attributeLocalBlocks(objects, user, known) {
  return objects.map((note) =>
    note.type !== "note" || !Array.isArray(note.blocks)
      ? note
      : {
          ...note,
          blocks: note.blocks.map((block) =>
            withTaskAuthor(
              block,
              known.get(taskAuthorKey(note.id, block.id)) ?? {
                createdByUserId: user.id,
                createdByName: user.name,
              },
            ),
          ),
        },
  );
}

// Server metadata is authoritative, but must not replace text typed while a commit was in flight.
export function adoptTaskAuthors(objects, canonical) {
  const known = new Map();
  for (const note of canonical) {
    if (note.type !== "note" || !Array.isArray(note.blocks)) continue;
    for (const block of note.blocks)
      known.set(taskAuthorKey(note.id, block.id), block);
  }
  return objects.map((note) =>
    note.type !== "note" || !Array.isArray(note.blocks)
      ? note
      : {
          ...note,
          blocks: note.blocks.map((block) => {
            const accepted = known.get(taskAuthorKey(note.id, block.id));
            if (!accepted) return block;
            const attributed = withTaskAuthor(block, taskAuthor(accepted));
            // Replica comparisons serialize objects. Match the server's key
            // order too, without losing any text or fields edited after send.
            return Object.fromEntries(
              [
                ...new Set([
                  ...Object.keys(accepted),
                  ...Object.keys(attributed),
                ]),
              ]
                .filter((key) => Object.hasOwn(attributed, key))
                .map((key) => [key, attributed[key]]),
            );
          }),
        },
  );
}

// JSDOM has no LockManager. Serialize the browser API boundary, including
// separately mounted consumers sharing the same origin and lock name.
export function browserLocks() {
  const tails = new Map();
  return {
    request(name, callback) {
      const next = (tails.get(name) || Promise.resolve()).then(callback);
      tails.set(
        name,
        next.catch(() => {}),
      );
      return next;
    },
  };
}

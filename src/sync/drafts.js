export async function claimDraftIdentity(room, id, locks = globalThis.navigator?.locks) {
    if (!locks) return { id: crypto.randomUUID(), release() {} };
    const claim = key =>
        new Promise((resolve, reject) => {
            void locks
                .request(`qingdan.draft.${room}.${key}`, { ifAvailable: true }, async lock => {
                    if (!lock) {
                        resolve(null);
                        return;
                    }
                    let release;
                    const holding = new Promise(done => {
                        release = done;
                    });
                    resolve({ id: key, release });
                    await holding;
                })
                .catch(reject);
        });
    return (await claim(id)) || (await claim(crypto.randomUUID()));
}
export function openDrafts() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("qingdan-canvas", 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore("drafts");
            request.result.createObjectStore("assets");
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => db.close();
            resolve({
                close: () => db.close(),
                get(store, key) {
                    return new Promise((done, fail) => {
                        const read = db.transaction(store).objectStore(store).get(key);
                        read.onsuccess = () => done(read.result);
                        read.onerror = () => fail(read.error);
                    });
                },
                put(store, key, value) {
                    return new Promise((done, fail) => {
                        const tx = db.transaction(store, "readwrite");
                        tx.objectStore(store).put(value, key);
                        tx.oncomplete = () => done();
                        tx.onerror = () => fail(tx.error);
                        tx.onabort = () => fail(tx.error || new Error("本地草稿保存失败。"));
                    });
                }
            });
        };
    });
}

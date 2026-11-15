// An isolated Electron profile for exercising the actual export helper.
const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const profile = path.resolve(process.argv[2]);
if (!profile.startsWith(path.resolve(".tmp") + path.sep))
  throw Error("Fixture profile must stay in .tmp");
app.setPath("userData", profile);
app
  .whenReady()
  .then(async () => {
    await session.defaultSession.protocol.handle(
      "https",
      () =>
        new Response("<!doctype html><title>Fixture</title>", {
          headers: { "Content-Type": "text/html" },
        }),
    );
    const w = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await w.loadURL("https://todo.zky.lol/app");
    await w.webContents.executeJavaScript(`(async()=>{
    localStorage.setItem('private-auth-key','MUST-NOT-EXPORT');
    localStorage.setItem('qingdan.desktop.input.v1:'+JSON.stringify([location.origin,'alice','room-a']),JSON.stringify({note:'Electron 未提交草稿'}));
    await new Promise((resolve,reject)=>{const q=indexedDB.open('qingdan-canvas',1);q.onupgradeneeded=()=>{q.result.createObjectStore('drafts');q.result.createObjectStore('assets');};q.onsuccess=()=>{const db=q.result,tx=db.transaction(['drafts','assets'],'readwrite');tx.objectStore('drafts').put({replica:{version:1,base:[],objects:[],flight:{type:'commit',opId:'offline-operation',changes:[]}},view:{dynamicIsland:{pinned:true}},assets:{},trash:[]},'alice/room-a/desktop-v1');tx.objectStore('assets').put(new Blob(['fixture image'],{type:'image/png'}),'room-a/asset-1');tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)};q.onerror=()=>reject(q.error)});
  })()`);
    fs.writeFileSync(
      path.join(profile, "window-position.json"),
      JSON.stringify({ x: 200, y: 0, width: 314, height: 64, dock: "top" }),
    );
    await session.defaultSession.flushStorageData();
    w.destroy();
    app.quit();
  })
  .catch((e) => {
    console.error(e.message);
    app.exit(1);
  });

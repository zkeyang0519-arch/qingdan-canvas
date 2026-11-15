#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod hit_test;
mod migration;
mod online;
mod resume;
mod updates;
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

type Result<T> = std::result::Result<T, String>;
#[derive(Default)]
struct Shared {
    rects: Vec<[f64; 4]>,
    context: Value,
    saved: Option<(String, tokio::sync::oneshot::Sender<Value>)>,
    allow_exit: bool,
    island_ready: bool,
    dragging: bool,
    loaded: Option<String>,
    switching: bool,
    bridge_ready: bool,
    migration: Option<(String, tokio::sync::oneshot::Sender<Value>)>,
}
struct State {
    shared: Arc<Mutex<Shared>>,
    action: tokio::sync::Mutex<()>,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn approved(url: &url::Url) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && ((url.path() == "/app"
            && (online::origin_allowed(url.origin().ascii_serialization().as_str())
                || [
                    "http://127.0.0.1:5178",
                    "http://127.0.0.1:8788",
                    "http://127.0.0.1:8790",
                ]
                .contains(&url.origin().ascii_serialization().as_str())))
            || (["/tauri-preview.html", "/tauri-transition.html"].contains(&url.path())
                && [
                    "tauri://localhost",
                    "http://tauri.localhost",
                    "https://tauri.localhost",
                ]
                .contains(
                    &format!("{}://{}", url.scheme(), url.host_str().unwrap_or("")).as_str(),
                )))
}
fn guard(w: &WebviewWindow) -> Result<()> {
    if w.label() != "main" || !approved(&w.url().map_err(err)?) {
        return Err("Untrusted desktop page".into());
    }
    Ok(())
}
fn profile(w: &WebviewWindow) -> Result<std::path::PathBuf> {
    data_dir(w.app_handle())
}
fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf> {
    #[cfg(feature = "test-harness")]
    if let Ok(dir) = std::env::var("QINGDAO_TEST_DATA_DIR") {
        let dir = std::path::PathBuf::from(dir);
        if dir.is_absolute() {
            return Ok(dir);
        }
        return Err("Test data directory must be absolute".into());
    }
    app.path().app_data_dir().map_err(err)
}
fn geometry(w: &WebviewWindow, dragging: bool) -> Result<Value> {
    let cursor = w.cursor_position().map_err(err)?;
    let monitors = w.available_monitors().map_err(err)?;
    let cursor_monitor = monitors
        .iter()
        .find(|m| {
            let p = m.position();
            let s = m.size();
            cursor.x >= p.x as f64
                && cursor.y >= p.y as f64
                && cursor.x < (p.x as f64 + s.width as f64)
                && cursor.y < (p.y as f64 + s.height as f64)
        })
        .cloned();
    let monitor = (if dragging {
        cursor_monitor
    } else {
        w.current_monitor().map_err(err)?
    })
    .or(w.primary_monitor().map_err(err)?)
    .ok_or("No display")?;
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let pos = w.outer_position().map_err(err)?;
    let size = w.inner_size().map_err(err)?;
    let window_scale = w.scale_factor().map_err(err)?;
    let saved = std::fs::read(profile(w)?.join("position.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    Ok(
        json!({"work":{"x":work.position.x as f64 / scale,"y":work.position.y as f64 / scale,"width":work.size.width as f64 / scale,"height":work.size.height as f64 / scale},"cursor":{"x":cursor.x/scale,"y":cursor.y/scale},"bounds":{"x":pos.x as f64/window_scale,"y":pos.y as f64/window_scale,"width":size.width as f64/window_scale,"height":size.height as f64/window_scale},"scale":scale,"saved":saved}),
    )
}
fn finite(data: &Value, key: &str, min: f64, max: f64) -> Result<f64> {
    data[key]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= min && *n <= max)
        .ok_or_else(|| format!("Invalid {key}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_navigation_that_would_expose_native_capabilities() {
        for value in [
            "https://todo.zky.lol.evil.example/app",
            "https://todo.zky.lol@evil.example/app",
            "https://user:password@todo.zky.lol/app",
            "https://todo.zky.lol/app/other",
            "http://127.0.0.1:9999/app",
            "file:///app",
            "http://tauri.localhost/app",
        ] {
            assert!(!approved(&url::Url::parse(value).unwrap()), "{value}");
        }
        assert!(approved(
            &url::Url::parse("https://todo.zky.lol/app?room=board-1").unwrap()
        ));
        assert!(approved(
            &url::Url::parse("tauri://localhost/tauri-preview.html").unwrap()
        ));
    }
    #[test]
    fn bounds_reject_strings_negative_sizes_and_excessive_allocations() {
        for data in [
            json!({"width":"300"}),
            json!({"width":-1}),
            json!({"width":1000000}),
            json!({}),
        ] {
            assert!(finite(&data, "width", 40., 1920.).is_err());
        }
    }
    #[test]
    fn login_lobby_can_clear_context_without_accepting_partial_identity() {
        assert_eq!(
            context_value(json!({"accountId":null,"roomId":null})).unwrap(),
            Value::Null
        );
        assert!(context_value(json!({"accountId":"alice","roomId":null})).is_err());
        assert_eq!(
            context_value(json!({"accountId":"alice","roomId":"room-a","extra":"ignored"}))
                .unwrap(),
            json!({"accountId":"alice","roomId":"room-a"})
        );
    }
}
pub async fn prepare(w: &WebviewWindow) -> Result<Value> {
    if w.url().map_err(err)?.path() == "/tauri-transition.html" {
        return Ok(json!({"ok":true}));
    }
    {
        let state = w.state::<State>();
        let shared = state.shared.lock().unwrap();
        if !shared.bridge_ready && shared.context.is_null() {
            // A network error page has no editable application to save. Keep
            // tray retry/exit usable without discarding any stored profile.
            return Ok(json!({"ok":true}));
        }
    }
    let token = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    w.state::<State>().shared.lock().unwrap().saved = Some((token.clone(), tx));
    let result = async {
        w.emit("prepare-save", &token).map_err(err)?;
        tokio::time::timeout(Duration::from_secs(8), rx)
            .await
            .map_err(|_| "等待保存超时，窗口已保留。".to_string())?
            .map_err(err)
    }
    .await;
    let state = w.state::<State>();
    let mut shared = state.shared.lock().unwrap();
    if shared.saved.as_ref().is_some_and(|(id, _)| *id == token) {
        shared.saved.take();
    }
    drop(shared);
    let result = result?;
    if result["ok"] != true
        || (result["missingHandler"] == true && !state.shared.lock().unwrap().context.is_null())
    {
        return Err("本地内容尚未保存。".into());
    }
    Ok(result)
}
fn local_url(page: &str) -> url::Url {
    url::Url::parse(&format!(
        "{}{page}",
        if cfg!(windows) {
            "http://tauri.localhost/"
        } else {
            "tauri://localhost/"
        }
    ))
    .unwrap()
}
async fn navigate_wait(w: &WebviewWindow, target: url::Url) -> Result<()> {
    w.state::<State>().shared.lock().unwrap().loaded = None;
    w.navigate(target.clone()).map_err(err)?;
    for _ in 0..150 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if w.state::<State>().shared.lock().unwrap().loaded.as_deref() == Some(target.as_str()) {
            return Ok(());
        }
    }
    Err("页面加载未完成".into())
}
async fn dispose_page(w: &WebviewWindow) -> Result<()> {
    let mut url = local_url("tauri-transition.html");
    url.query_pairs_mut()
        .append_pair("transition", &uuid::Uuid::new_v4().to_string());
    navigate_wait(w, url).await
}
fn context_value(data: Value) -> Result<Value> {
    if data.is_null()
        || (data.is_object() && data["accountId"].is_null() && data["roomId"].is_null())
    {
        return Ok(Value::Null);
    }
    if !online::id(&data["accountId"]) || !online::id(&data["roomId"]) {
        return Err("Invalid context".into());
    }
    Ok(json!({"accountId":data["accountId"],"roomId":data["roomId"]}))
}
pub async fn safe_to_leave(w: &WebviewWindow) -> Result<()> {
    let saved = prepare(w).await?;
    if (saved["hasDraft"] == true || saved["unsynced"] == true) && saved["draftsPersisted"] != true
    {
        return Err("仍有未提交或未同步内容，请处理后再切换或退出。".into());
    }
    if !w.state::<State>().shared.lock().unwrap().switching {
        let url = w.url().map_err(err)?;
        if url.path() == "/app" {
            let room = url
                .query_pairs()
                .find(|(k, _)| k == "room")
                .map(|(_, v)| v.into_owned());
            resume::save(&profile(w)?, &url, room.as_deref())?;
        }
    }
    Ok(())
}
#[tauri::command]
async fn desktop(window: WebviewWindow, op: String, data: Value) -> Result<Value> {
    guard(&window)?;
    match op.as_str() {
        "bridge_ready" => {
            window.state::<State>().shared.lock().unwrap().bridge_ready = true;
            Ok(Value::Null)
        }
        "geometry" => geometry(&window, data["dragging"] == true),
        "bounds" => {
            let b = &data["bounds"];
            let x = finite(b, "x", -100000., 100000.)?;
            let y = finite(b, "y", -100000., 100000.)?;
            let width = finite(b, "width", 40., 1920.)?;
            let height = finite(b, "height", 40., 2160.)?;
            let list = data["rects"].as_array().ok_or("Invalid shape")?;
            if list.len() > 2200 {
                return Err("Shape too complex".into());
            }
            let mut rects = Vec::new();
            for r in list {
                rects.push([
                    finite(r, "x", 0., 1920.)?,
                    finite(r, "y", 0., 2160.)?,
                    finite(r, "width", 1., 1920.)?,
                    finite(r, "height", 1., 2160.)?,
                ]);
            }
            {
                let state = window.state::<State>();
                let mut shared = state.shared.lock().unwrap();
                shared.rects = rects.clone();
                shared.island_ready = data["islandReady"] == true;
                shared.dragging = data["dragging"] == true;
            }
            // Use the target monitor's scale for physical position. Logical global
            // coordinates cannot be passed directly on mixed-DPI Windows desktops.
            let scale = finite(&data, "scale", 0.5, 8.)?;
            window
                .set_position(tauri::PhysicalPosition::new(
                    (x * scale).round() as i32,
                    (y * scale).round() as i32,
                ))
                .map_err(err)?;
            window
                .set_size(tauri::PhysicalSize::new(
                    (width * scale).round() as u32,
                    (height * scale).round() as u32,
                ))
                .map_err(err)?;
            hit_test::apply(&window, rects, scale).await?;
            Ok(Value::Null)
        }
        "save_position" => {
            for key in ["x", "y", "width", "height"] {
                finite(&data, key, -100000., 100000.)?;
            }
            let dir = profile(&window)?;
            std::fs::create_dir_all(&dir).map_err(err)?;
            std::fs::write(
                dir.join("position.json"),
                serde_json::to_vec(&data).map_err(err)?,
            )
            .map_err(err)?;
            Ok(Value::Null)
        }
        "context" => {
            let data = context_value(data)?;
            let state = window.state::<State>();
            let mut shared = state.shared.lock().unwrap();
            if !shared.switching && !data.is_null() {
                resume::save(
                    &profile(&window)?,
                    &window.url().map_err(err)?,
                    data["roomId"].as_str(),
                )?;
            }
            shared.context = data;
            Ok(json!(true))
        }
        "saved" => {
            let state = window.state::<State>();
            let mut shared = state.shared.lock().unwrap();
            if shared
                .saved
                .as_ref()
                .is_some_and(|(token, _)| data["token"] == *token)
            {
                if let Some((_, tx)) = shared.saved.take() {
                    let _ = tx.send(data);
                }
            }
            Ok(Value::Null)
        }
        "migration_result" => {
            let state = window.state::<State>();
            let mut shared = state.shared.lock().unwrap();
            if shared
                .migration
                .as_ref()
                .is_some_and(|(token, _)| data["token"] == *token)
            {
                if let Some((_, tx)) = shared.migration.take() {
                    let _ = tx.send(data);
                }
            }
            Ok(Value::Null)
        }
        "hide" => {
            window.hide().map_err(err)?;
            Ok(json!(true))
        }
        "open_workspace" => {
            if !online::id(&data) {
                return Err("Invalid room".into());
            }
            let mut url = window.url().map_err(err)?;
            if !online::origin_allowed(&url.origin().ascii_serialization()) {
                url = url::Url::parse("https://todo.zky.lol/app").unwrap();
            }
            url.set_path("/app");
            url.set_query(None);
            url.query_pairs_mut()
                .append_pair("room", data.as_str().unwrap());
            window
                .opener()
                .open_url(url.as_str(), None::<&str>)
                .map_err(err)?;
            Ok(json!(true))
        }
        "update" => Ok(window.state::<updates::Updates>().snapshot()),
        "check_update" => updates::check(&window).await,
        "install_update" => updates::install(&window).await,
        #[cfg(feature = "test-harness")]
        "test_exit" => {
            safe_to_leave(&window).await?;
            window.state::<State>().shared.lock().unwrap().allow_exit = true;
            window.app_handle().exit(0);
            Ok(Value::Null)
        }
        _ => Err("Unknown desktop operation".into()),
    }
}
fn show(w: &WebviewWindow) {
    let _ = w.show();
    let _ = w.set_focus();
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                show(&w)
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::Updates::default())
        .manage(State {
            shared: Arc::new(Mutex::new(Shared::default())),
            action: tokio::sync::Mutex::new(()),
        })
        .invoke_handler(tauri::generate_handler![desktop])
        .setup(|app| {
            let dir = data_dir(app.handle())?;
            let initial = std::env::var("QINGDAO_PREVIEW_URL")
                .ok()
                .and_then(|s| url::Url::parse(&s).ok())
                .filter(approved)
                .or_else(|| resume::read(&dir));
            let target = initial.map(WebviewUrl::External).unwrap_or_else(|| {
                WebviewUrl::External(url::Url::parse("https://todo.zky.lol/app").unwrap())
            });
            let builder = tauri::WebviewWindowBuilder::new(app, "main", target);
            #[cfg(feature = "test-harness")]
            let builder = builder.data_directory(dir.join("webview"));
            let _w = builder
                .title("轻岛 · Tauri 验证版")
                .inner_size(370., 500.)
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible_on_all_workspaces(true)
                .initialization_script(include_str!("../generated/bridge.js"))
                .on_navigation(approved)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_page_load(|w, payload| {
                    let state = w.state::<State>();
                    let mut shared = state.shared.lock().unwrap();
                    match payload.event() {
                        tauri::webview::PageLoadEvent::Started => {
                            shared.bridge_ready = false;
                            shared.context = Value::Null;
                            shared.island_ready = false;
                            shared.loaded = None;
                        }
                        tauri::webview::PageLoadEvent::Finished => {
                            shared.loaded = Some(payload.url().to_string());
                        }
                    }
                })
                .build()?;
            let menu = tauri::menu::Menu::with_items(
                app,
                &[
                    &tauri::menu::MenuItem::with_id(app, "show", "显示轻岛", true, None::<&str>)?,
                    &tauri::menu::MenuItem::with_id(
                        app,
                        "reload",
                        "重新加载当前画布",
                        true,
                        None::<&str>,
                    )?,
                    &tauri::menu::MenuItem::with_id(
                        app,
                        "updates",
                        "检查验证版更新",
                        true,
                        None::<&str>,
                    )?,
                    &tauri::menu::MenuItem::with_id(
                        app,
                        "export",
                        "导出当前账号草稿",
                        true,
                        None::<&str>,
                    )?,
                    &tauri::menu::MenuItem::with_id(
                        app,
                        "import",
                        "导入旧版草稿",
                        true,
                        None::<&str>,
                    )?,
                    &tauri::menu::MenuItem::with_id(
                        app,
                        "reset",
                        "恢复到屏幕顶部",
                        true,
                        None::<&str>,
                    )?,
                    &tauri::menu::MenuItem::with_id(
                        app,
                        "online",
                        "登录真实轻单",
                        true,
                        None::<&str>,
                    )?,
                    &tauri::menu::MenuItem::with_id(
                        app,
                        "preview",
                        "返回本地验证画布",
                        true,
                        None::<&str>,
                    )?,
                    &tauri::menu::MenuItem::with_id(
                        app,
                        "quit",
                        "保存并退出验证版",
                        true,
                        None::<&str>,
                    )?,
                ],
            )?;
            tauri::tray::TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("轻岛 · Tauri 验证版")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    let Some(w) = app.get_webview_window("main") else {
                        return;
                    };
                    match event.id.as_ref() {
                        "show" => show(&w),
                        "reset" => {
                            show(&w);
                            let _ = w.emit("reset-position", ());
                        }
                        "updates" => {
                            tauri::async_runtime::spawn(async move {
                                let result = updates::check(&w).await;
                                let message = match result {
                                    Ok(v) => {
                                        v["message"].as_str().unwrap_or("检查完成").to_string()
                                    }
                                    Err(e) => e,
                                };
                                w.dialog()
                                    .message(message)
                                    .title("轻岛验证版更新")
                                    .show(|_| {});
                            });
                        }
                        action @ ("export" | "import") => {
                            let action = action.to_string();
                            tauri::async_runtime::spawn(async move {
                                let result = migration::run(&w, &action).await;
                                let message = match result {
                                    Ok(()) => "操作已结束，原版数据保留。".to_string(),
                                    Err(e) => e,
                                };
                                w.dialog()
                                    .message(message)
                                    .title("轻岛数据迁移")
                                    .show(|_| {});
                            });
                        }
                        action => {
                            let action = action.to_string();
                            tauri::async_runtime::spawn(async move {
                                let state = w.state::<State>();
                                let _lock = state.action.lock().await;
                                if let Err(error) = safe_to_leave(&w).await {
                                    show(&w);
                                    w.dialog()
                                        .message(error)
                                        .title("已保留当前窗口")
                                        .show(|_| {});
                                    return;
                                }
                                match action.as_str() {
                                    "quit" => {
                                        state.shared.lock().unwrap().allow_exit = true;
                                        w.app_handle().exit(0);
                                    }
                                    "online" => {
                                        let _ = w.navigate(
                                            url::Url::parse("https://todo.zky.lol/app").unwrap(),
                                        );
                                        show(&w);
                                    }
                                    "reload" => {
                                        let _ = w.reload();
                                        show(&w);
                                    }
                                    "preview" => {
                                        let _ = w.navigate(local_url("tauri-preview.html"));
                                        show(&w);
                                    }
                                    _ => {}
                                }
                            });
                        }
                    }
                })
                .build(app)?;
            // Native hit testing is independent of DOM mouse events. Otherwise a
            // click-through window could never detect the pointer re-entering it.
            #[cfg(not(windows))]
            {
                let hit = _w.clone();
                let shared = app.state::<State>().shared.clone();
                std::thread::spawn(move || {
                    let mut ignored = false;
                    loop {
                        std::thread::sleep(Duration::from_millis(16));
                        if !hit.is_visible().unwrap_or(false) {
                            continue;
                        }
                        let (Ok(cursor), Ok(pos), Ok(scale)) = (
                            hit.cursor_position(),
                            hit.outer_position(),
                            hit.scale_factor(),
                        ) else {
                            continue;
                        };
                        let x = (cursor.x - pos.x as f64) / scale;
                        let y = (cursor.y - pos.y as f64) / scale;
                        let shared_state = shared.lock().unwrap();
                        let rects = &shared_state.rects;
                        let next = !shared_state.dragging
                            && !rects.is_empty()
                            && !rects.iter().any(|r| {
                                x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]
                            });
                        drop(shared_state);
                        if next != ignored {
                            if hit.set_ignore_cursor_events(next).is_ok() {
                                ignored = next;
                            }
                        }
                    }
                });
            }
            // Dedicated preview protocol/port never take ownership of Electron.
            online::start(app.handle().clone())?;
            // Monitor work-area changes do not always produce a DPI event
            // (for example unplugging an equally scaled external display).
            let display_window = _w.clone();
            std::thread::spawn(move || {
                let mut previous = String::new();
                loop {
                    std::thread::sleep(Duration::from_secs(2));
                    let Ok(monitors) = display_window.available_monitors() else {
                        continue;
                    };
                    let mut displays: Vec<_> = monitors
                        .iter()
                        .map(|m| {
                            format!(
                                "{:?}/{:?}/{:?}/{}",
                                m.position(),
                                m.size(),
                                m.work_area(),
                                m.scale_factor()
                            )
                        })
                        .collect();
                    displays.sort();
                    let current = displays.join(";");
                    if !previous.is_empty() && current != previous {
                        let _ = display_window.emit("display-changed", ());
                    }
                    previous = current;
                }
            });
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                if event.urls().iter().any(|u| {
                    u.as_str() == "qingdao-preview://open"
                        || u.as_str() == "qingdao-preview://open/"
                }) {
                    if let Some(w) = handle.get_webview_window("main") {
                        show(&w);
                    }
                }
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(60 * 60)).await;
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = updates::check(&w).await;
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|w, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = w.hide();
            }
            tauri::WindowEvent::ScaleFactorChanged { .. } => {
                let _ = w.emit("display-changed", ());
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("轻岛验证版启动失败")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !app.state::<State>().shared.lock().unwrap().allow_exit {
                    api.prevent_exit();
                    if let Some(w) = app.get_webview_window("main") {
                        show(&w);
                        w.dialog()
                            .message("请通过托盘的「保存并退出验证版」安全退出。")
                            .show(|_| {});
                    }
                }
            }
        });
}

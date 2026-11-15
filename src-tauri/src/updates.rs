use super::*;
use tauri_plugin_updater::{Update, UpdaterExt};

pub struct Updates {
    value: Mutex<Value>,
    ready: Mutex<Option<(Update, Arc<Vec<u8>>)>>,
    gate: tokio::sync::Mutex<()>,
}
impl Default for Updates {
    fn default() -> Self {
        Self {
            value: Mutex::new(json!({"status":"idle","currentVersion":env!("CARGO_PKG_VERSION")})),
            ready: Mutex::new(None),
            gate: tokio::sync::Mutex::new(()),
        }
    }
}
impl Updates {
    pub fn snapshot(&self) -> Value {
        self.value.lock().unwrap().clone()
    }
    fn publish(&self, w: &WebviewWindow, mut value: Value) -> Value {
        value["currentVersion"] = json!(env!("CARGO_PKG_VERSION"));
        *self.value.lock().unwrap() = value.clone();
        let _ = w.emit("update-state", &value);
        value
    }
}
fn channel() -> Result<Option<(url::Url, String)>> {
    let v: Value = serde_json::from_str(include_str!("../updater-channel.json")).map_err(err)?;
    let (Some(endpoint), Some(key)) = (v["endpoint"].as_str(), v["pubkey"].as_str()) else {
        return Ok(None);
    };
    let url = url::Url::parse(endpoint).map_err(err)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || key.is_empty()
    {
        return Err("更新配置无效，请联系维护者".into());
    }
    Ok(Some((url, key.to_string())))
}
pub async fn check(w: &WebviewWindow) -> Result<Value> {
    let updates = w.state::<Updates>();
    let _gate = updates.gate.lock().await;
    // A failed subsequent check must not discard an already verified package.
    if updates.ready.lock().unwrap().is_some() {
        return Ok(updates.snapshot());
    }
    let Some((endpoint, key)) = channel()? else {
        return Ok(updates.publish(w, json!({"status":"unsupported","message":"验证版更新流程已接入；发布者尚未配置签名更新源，请使用新版验证安装包。"})));
    };
    updates.publish(
        w,
        json!({"status":"checking","message":"正在检查验证版更新…"}),
    );
    let result = async {
        let updater = w.updater_builder().pubkey(key).endpoints(vec![endpoint]).map_err(err)?.timeout(Duration::from_secs(90)).build().map_err(err)?;
        let Some(update) = updater.check().await.map_err(err)? else {
            return Ok(updates.publish(w, json!({"status":"not-available","message":"当前已是最新验证版"})));
        };
        if update.download_url.scheme() != "https" { return Err("更新包必须通过 HTTPS 下载".into()); }
        updates.publish(w, json!({"status":"downloading","version":update.version,"message":"正在下载并验证更新签名…"}));
        let bytes = update.download(|_, _| {}, || {}).await.map_err(err)?;
        let version = update.version.clone();
        *updates.ready.lock().unwrap() = Some((update, Arc::new(bytes)));
        Ok(updates.publish(w, json!({"status":"downloaded","version":version,"message":"新版已通过签名验证，可在轻岛内保存并重启更新"})))
    }.await;
    if let Err(ref error) = result {
        updates.publish(
            w,
            json!({"status":"error","error":error,"message":"更新检查失败，当前版本可继续使用"}),
        );
    }
    result
}
pub async fn install(w: &WebviewWindow) -> Result<Value> {
    let updates = w.state::<Updates>();
    let _gate = updates.gate.lock().await;
    let state = w.state::<State>();
    let _action = state.action.lock().await;
    let (update, bytes) = updates
        .ready
        .lock()
        .unwrap()
        .clone()
        .ok_or("尚无通过签名验证的更新包")?;
    updates.publish(w, json!({"status":"installing","version":update.version}));
    let result = async {
        safe_to_leave(w).await?;
        // Dispose the renderer before installing so background sync cannot race
        // storage flushing or mutate unsaved content after the acknowledgement.
        let previous = w.url().map_err(err)?;
        dispose_page(w).await?;
        state.shared.lock().unwrap().allow_exit = true;
        if let Err(error) = update.install(bytes.as_slice()) {
            state.shared.lock().unwrap().allow_exit = false;
            let _ = w.navigate(previous);
            return Err(err(error));
        }
        // Windows installer exits/relaunches; macOS needs an explicit restart.
        #[cfg(not(windows))]
        w.app_handle().restart();
        Ok(json!(true))
    }
    .await;
    if let Err(ref error) = result {
        updates.publish(
            w,
            json!({"status":"downloaded","version":update.version,"error":error}),
        );
    }
    result
}

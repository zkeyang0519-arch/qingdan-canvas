use super::*;
pub async fn run(w: &WebviewWindow, action: &str) -> Result<()> {
    let state = w.state::<State>();
    let _lock = state.action.lock().await;
    let url = w.url().map_err(err)?;
    if url.path() != "/app" {
        return Err("请先登录真实账号，再迁移数据。".into());
    }
    if action == "import" && url.query_pairs().any(|(k, _)| k == "room") {
        return Err(
            "请先返回画布列表，再导入旧版草稿。若验证版已有不同草稿，导入会停止并保留双方数据。"
                .into(),
        );
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let chooser = w.dialog().file().add_filter("轻岛备份", &["json"]);
    if action == "export" {
        chooser
            .set_file_name("轻岛草稿备份.json")
            .save_file(move |p| {
                let _ = tx.send(p);
            });
    } else {
        chooser.pick_file(move |p| {
            let _ = tx.send(p);
        });
    }
    let Some(file) = rx.await.map_err(err)? else {
        return Ok(());
    };
    let path = file.into_path().map_err(err)?;
    let payload = if action == "import" {
        if std::fs::metadata(&path).map_err(err)?.len() > 64 * 1024 * 1024 {
            return Err("备份超过 64 MB".into());
        }
        let data: Value =
            serde_json::from_slice(&std::fs::read(&path).map_err(err)?).map_err(err)?;
        if data["origin"] != url.origin().ascii_serialization() {
            return Err("备份不属于当前网站，请登录原网站再导入。".into());
        }
        data
    } else {
        Value::Null
    };
    let _ = w.emit("transition-state", true);
    let result = async {
        safe_to_leave(w).await?;
        let token = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        state.shared.lock().unwrap().migration = Some((token.clone(), tx));
        let reply = async {
            w.emit(
                "migration-request",
                json!({"token":token,"action":action,"value":payload}),
            )
            .map_err(err)?;
            tokio::time::timeout(Duration::from_secs(60), rx)
                .await
                .map_err(err)?
                .map_err(err)
        }
        .await;
        state.shared.lock().unwrap().migration.take();
        let reply = reply?;
        if reply["ok"] != true {
            return Err(reply["error"]
                .as_str()
                .unwrap_or("迁移失败，原数据已保留。")
                .to_string());
        }
        if action == "export" {
            let mut data = reply["value"].clone();
            if let Ok(bytes) = std::fs::read(profile(w)?.join("position.json")) {
                data["position"] = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            }
            // Explicitly selected destination may already exist: refuse an
            // overwrite so another user's backup can never be lost.
            use std::io::Write;
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(err)?;
            output
                .write_all(&serde_json::to_vec(&data).map_err(err)?)
                .map_err(err)?;
            output.sync_all().map_err(err)?;
        } else {
            if payload["position"].is_object()
                && ["x", "y", "width", "height"]
                    .iter()
                    .all(|k| finite(&payload["position"], k, -100000., 100000.).is_ok())
            {
                std::fs::write(
                    profile(w)?.join("position.json"),
                    serde_json::to_vec(&payload["position"]).map_err(err)?,
                )
                .map_err(err)?;
            }
            w.reload().map_err(err)?;
        }
        Ok(())
    }
    .await;
    let _ = w.emit("transition-state", false);
    result
}

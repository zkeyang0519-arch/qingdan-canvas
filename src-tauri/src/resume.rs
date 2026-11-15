use super::*;
use std::path::Path;

pub fn canonical(url: &url::Url, room: Option<&str>) -> Result<url::Url> {
    if !approved(url) || url.path() != "/app" {
        return Err("Invalid resume URL".into());
    }
    let mut clean = url.clone();
    clean.set_query(None);
    clean.set_fragment(None);
    if let Some(room) = room {
        if !online::id(&json!(room)) {
            return Err("Invalid room".into());
        }
        clean.query_pairs_mut().append_pair("room", room);
    }
    Ok(clean)
}
pub fn read(dir: &Path) -> Option<url::Url> {
    let value: Value =
        serde_json::from_slice(&std::fs::read(dir.join("resume.json")).ok()?).ok()?;
    let url = url::Url::parse(value["url"].as_str()?).ok()?;
    let room = url
        .query_pairs()
        .find(|(k, _)| k == "room")
        .map(|(_, v)| v.into_owned());
    canonical(&url, room.as_deref()).ok()
}
pub fn save(dir: &Path, url: &url::Url, room: Option<&str>) -> Result<()> {
    let url = canonical(url, room)?;
    std::fs::create_dir_all(dir).map_err(err)?;
    let temp = dir.join("resume.json.tmp");
    std::fs::write(&temp, json!({"url":url.as_str()}).to_string()).map_err(err)?;
    std::fs::rename(temp, dir.join("resume.json")).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persisted_url_never_contains_credentials_or_unrelated_queries() {
        let u = url::Url::parse("https://todo.zky.lol/app?ticket=secret&room=old").unwrap();
        assert_eq!(
            canonical(&u, Some("new-room")).unwrap().as_str(),
            "https://todo.zky.lol/app?room=new-room"
        );
        assert!(canonical(&url::Url::parse("https://evil.example/app").unwrap(), None).is_err());
        assert!(canonical(&u, Some("bad/room")).is_err());
    }
}

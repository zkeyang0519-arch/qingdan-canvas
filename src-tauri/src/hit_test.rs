// Windows owns the successful HRGN. Keep clipping and native hit testing in
// one region, as Electron setShape does, with no polling delay at pane gaps.
#[cfg(windows)]
pub async fn apply(
    w: &tauri::WebviewWindow,
    rects: Vec<[f64; 4]>,
    scale: f64,
) -> super::Result<()> {
    use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_OR,
    };
    let handle = w.hwnd().map_err(super::err)?.0 as usize;
    let (tx, rx) = tokio::sync::oneshot::channel();
    w.run_on_main_thread(move || {
        let result = unsafe {
            if rects.is_empty() {
                if SetWindowRgn(handle as _, std::ptr::null_mut(), 1) == 0 {
                    Err("无法恢复窗口区域".into())
                } else {
                    Ok(())
                }
            } else {
                let region = CreateRectRgn(0, 0, 0, 0);
                if region.is_null() {
                    Err("无法创建窗口区域".into())
                } else {
                    let mut ok = true;
                    for r in rects {
                        let part = CreateRectRgn(
                            (r[0] * scale).floor() as i32,
                            (r[1] * scale).floor() as i32,
                            ((r[0] + r[2]) * scale).ceil() as i32,
                            ((r[1] + r[3]) * scale).ceil() as i32,
                        );
                        if part.is_null() {
                            ok = false;
                            break;
                        }
                        if CombineRgn(region, region, part, RGN_OR) == 0 {
                            ok = false;
                        }
                        DeleteObject(part as _);
                        if !ok {
                            break;
                        }
                    }
                    if ok && SetWindowRgn(handle as _, region, 1) != 0 {
                        Ok(())
                    } else {
                        DeleteObject(region as _);
                        Err("无法应用窗口区域".into())
                    }
                }
            }
        };
        let _ = tx.send(result);
    })
    .map_err(super::err)?;
    rx.await.map_err(super::err)?
}
#[cfg(not(windows))]
pub async fn apply(_: &tauri::WebviewWindow, _: Vec<[f64; 4]>, _: f64) -> super::Result<()> {
    Ok(())
}

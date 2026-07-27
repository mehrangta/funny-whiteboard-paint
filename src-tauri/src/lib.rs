mod project;

use base64::{engine::general_purpose, Engine as _};
use project::{load_png, load_project, save_png, save_project};
use std::fs;
use std::path::Path;
use tauri::Manager;

const MASCOT_FILE_NAMES: [&str; 2] = ["held-whiteboard.png", "held-whiteboar.png"];

#[tauri::command]
fn load_mascot_image() -> Result<Option<String>, String> {
    let exe_path =
        std::env::current_exe().map_err(|error| format!("Failed to resolve executable path: {error}"))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "Failed to resolve executable directory".to_string())?;

    for file_name in MASCOT_FILE_NAMES {
        let path = exe_dir.join(file_name);
        if path.is_file() {
            return file_to_data_url(&path).map(Some);
        }
    }

    Ok(None)
}

fn file_to_data_url(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("File read failed: {error}"))?;
    let encoded = general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:image/png;base64,{encoded}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_decorations(false)?;
                window.set_resizable(true)?;
                window.set_shadow(false)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_project,
            load_project,
            save_png,
            load_png,
            load_mascot_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

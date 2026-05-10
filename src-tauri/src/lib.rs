use tauri::Manager;
use std::fs;
use std::path::PathBuf;
use base64::{engine::general_purpose, Engine as _};
use std::sync::Mutex;
use once_cell::sync::Lazy;

//use image::{RgbaImage, Rgba, ExtendedColorType}; 
//use image::codecs::png::PngEncoder; 
//use image::ImageEncoder; 

//use imageproc::drawing::{draw_line_segment_mut, draw_hollow_rect_mut}; 
//use imageproc::rect::Rect; 



static UNDO_STACK: Lazy<Mutex<Vec<String>>> = Lazy::new(|| Mutex::new(Vec::new()));
static REDO_STACK: Lazy<Mutex<Vec<String>>> = Lazy::new(|| Mutex::new(Vec::new()));

const STACK_LIMIT: usize = 50; 

#[tauri::command]
fn push_state(snapshot: String) {
    match UNDO_STACK.lock() {
        Ok(mut undo) => {
            undo.push(snapshot);
            if undo.len() > STACK_LIMIT {
                undo.remove(0); //maybe dont use a vec for this as this is expensive
            }
        }
        Err(poisoned) => {
            // if the mutex was posioned jsut throw away all redos,maybe notify user
            let mut undo = poisoned.into_inner();
            undo.clear();
            undo.push(snapshot); 
        }
    }
}

#[tauri::command]
fn undo() -> Option<String> {
    let mut undo = UNDO_STACK.lock().unwrap();
    let mut redo = REDO_STACK.lock().unwrap();

    if undo.len() > 1 {
        let last = undo.pop().unwrap();
        redo.push(last);

        if redo.len() > STACK_LIMIT {
            redo.remove(0);
        }
        return undo.last().cloned();
    }
    None //maybe notify user
}

#[tauri::command]
fn redo() -> Option<String> {
    let mut undo = UNDO_STACK.lock().unwrap();
    let mut redo = REDO_STACK.lock().unwrap();

    if let Some(state) = redo.pop() {
        undo.push(state.clone());
        return Some(state);
    }
    None
}

#[tauri::command]
fn save_image(app: tauri::AppHandle, path: String, data: String) -> Result<String, String> {
    let path_buf = saved_image_path(&app, &path)?;

    if let Some(parent) = path_buf.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
    }

    let b64 = data.split_once(',').map(|(_, b)| b).unwrap_or(&data);
    let bytes = general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("Base64 decode failed: {e}"))?;

    fs::write(&path_buf, bytes).map_err(|e| format!("File write failed: {e}"))?;
    Ok(path_buf.display().to_string())
}

#[tauri::command]
fn load_image(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let path_buf = saved_image_path(&app, &path)?;
    let bytes = fs::read(&path_buf).map_err(|e| format!("File read failed: {e}"))?;

    let mime = match path_buf
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "image/png",
    };

    let b64 = general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

fn saved_image_path(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
    let file_name = app
        .path()
        .file_name(path)
        .ok_or_else(|| "Invalid file name".to_string())?;

    if file_name.trim().is_empty() {
        return Err("Invalid file name".to_string());
    }

    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

    Ok(base.join("saved_images").join(file_name))
}

#[tauri::command]
fn draw_shape(
    shape: &str,
    start_x: u32,
    start_y: u32,
    end_x: u32,
    end_y: u32,
    color: &str,
    _line_width: u32,
    current_png: Option<String>
) -> String {
    use image::{RgbaImage, Rgba, ExtendedColorType};
    use imageproc::drawing::{draw_line_segment_mut, draw_hollow_rect_mut};
    use imageproc::rect::Rect;
    use image::codecs::png::PngEncoder;
    use image::ImageEncoder;
    use base64::{engine::general_purpose, Engine as _};

    let mut img = if let Some(data_url) = current_png {
        let b64 = data_url.split_once(',').unwrap().1;
        let bytes = general_purpose::STANDARD.decode(b64).unwrap();
        image::load_from_memory(&bytes).unwrap().to_rgba8()
    } else {
        RgbaImage::new(800, 600)
    };

    let r = u8::from_str_radix(&color[1..3], 16).unwrap();
    let g = u8::from_str_radix(&color[3..5], 16).unwrap();
    let b = u8::from_str_radix(&color[5..7], 16).unwrap();
    let a = 255;
    let rgba = Rgba([r, g, b, a]);

    match shape {
        "line" => draw_line_segment_mut(
            &mut img,
            (start_x as f32, start_y as f32),
            (end_x as f32, end_y as f32),
            rgba,
        ),
        "rect" => {
            let rect = Rect::at(start_x as i32, start_y as i32)
                .of_size(end_x - start_x, end_y - start_y);
            draw_hollow_rect_mut(&mut img, rect, rgba);
        },
        _ => {}
    }

    let mut buf = Vec::new();
    let encoder = PngEncoder::new(&mut buf);
    encoder
        .write_image(&img, img.width(), img.height(), ExtendedColorType::Rgba8)
        .unwrap();

    let b64 = general_purpose::STANDARD.encode(&buf);
    format!("data:image/png;base64,{}", b64)
}



#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_decorations(false)?;
                window.set_resizable(true)?;
                window.set_shadow(false)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![save_image, load_image, push_state, undo, redo, draw_shape])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

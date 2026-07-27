use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

const MAX_PROJECT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_BACKGROUND_BYTES: usize = 32 * 1024 * 1024;
const MAX_BOARD_DIMENSION: u32 = 8192;
const MAX_BOARD_PIXELS: u64 = 33_554_432;
const MAX_OBJECTS: usize = 10_000;
const MAX_TOTAL_POINTS: usize = 1_000_000;
const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MIN_STROKE_WIDTH: f64 = 1.0;
const MAX_STROKE_WIDTH: f64 = 30.0;
const MIN_TEXT_SIZE: f64 = 8.0;
const MAX_TEXT_SIZE: f64 = 96.0;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FwbDocumentV1 {
    pub format: String,
    pub version: u32,
    pub board: BoardDimensions,
    pub background: Option<ProjectBackground>,
    pub objects: Vec<BoardObject>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardDimensions {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectBackground {
    pub mime_type: String,
    pub data_base64: String,
    pub intrinsic_width: u32,
    pub intrinsic_height: u32,
    pub placement: Rect,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum BoardObject {
    #[serde(rename = "path")]
    Path {
        id: String,
        points: Vec<Point>,
        stroke: StrokeStyle,
    },
    #[serde(rename = "line")]
    Line {
        id: String,
        start: Point,
        end: Point,
        stroke: StrokeStyle,
    },
    #[serde(rename = "rect")]
    Rect {
        id: String,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        stroke: StrokeStyle,
    },
    #[serde(rename = "text")]
    Text {
        id: String,
        x: f64,
        y: f64,
        value: String,
        style: TextStyle,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StrokeStyle {
    pub color: String,
    pub width: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextStyle {
    pub color: String,
    pub font: String,
    pub font_size: f64,
    pub bold: bool,
    pub italic: bool,
    pub line_height: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPng {
    pub data_base64: String,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub fn load_project(path: String) -> Result<FwbDocumentV1, String> {
    let path = checked_path(&path, "fwb", true)?;
    let bytes = read_limited(&path, MAX_PROJECT_BYTES)?;
    let document: FwbDocumentV1 =
        serde_json::from_slice(&bytes).map_err(|error| format!("Invalid .fwb JSON: {error}"))?;
    validate_document(&document)?;
    Ok(document)
}

#[tauri::command]
pub fn save_project(path: String, document: FwbDocumentV1) -> Result<String, String> {
    let path = checked_path(&path, "fwb", false)?;
    validate_document(&document)?;
    let bytes = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("Project serialization failed: {error}"))?;
    if bytes.len() as u64 > MAX_PROJECT_BYTES {
        return Err("Project exceeds the 64 MiB file limit".to_string());
    }
    atomic_write(&path, &bytes)?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub fn load_png(path: String) -> Result<ImportedPng, String> {
    let path = checked_path(&path, "png", true)?;
    let bytes = read_limited(&path, MAX_BACKGROUND_BYTES as u64)?;
    let image = decode_png(&bytes)?;
    Ok(ImportedPng {
        data_base64: general_purpose::STANDARD.encode(bytes),
        width: image.width(),
        height: image.height(),
    })
}

#[tauri::command]
pub fn save_png(path: String, data: String) -> Result<String, String> {
    let path = checked_path(&path, "png", false)?;
    let encoded = data.split_once(',').map(|(_, value)| value).unwrap_or(&data);
    let bytes = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("PNG base64 decode failed: {error}"))?;
    if bytes.len() > MAX_BACKGROUND_BYTES {
        return Err("PNG exceeds the 32 MiB file limit".to_string());
    }
    decode_png(&bytes)?;
    atomic_write(&path, &bytes)?;
    Ok(path.display().to_string())
}

fn validate_document(document: &FwbDocumentV1) -> Result<(), String> {
    if document.format != "funny-whiteboard" {
        return Err("Unsupported project format marker".to_string());
    }
    if document.version != 1 {
        return Err(format!(
            "Unsupported .fwb version {}; this app supports version 1",
            document.version
        ));
    }
    validate_board(&document.board)?;
    if document.objects.len() > MAX_OBJECTS {
        return Err(format!("Project exceeds the {MAX_OBJECTS} object limit"));
    }
    if let Some(background) = &document.background {
        validate_background(background)?;
    }

    let mut ids = HashSet::with_capacity(document.objects.len());
    let mut total_points = 0usize;
    let mut total_text_bytes = 0usize;
    for object in &document.objects {
        let id = match object {
            BoardObject::Path { id, points, stroke } => {
                if points.is_empty() {
                    return Err("Brush paths must contain at least one point".to_string());
                }
                total_points = total_points
                    .checked_add(points.len())
                    .ok_or_else(|| "Project point count overflowed".to_string())?;
                if total_points > MAX_TOTAL_POINTS {
                    return Err(format!("Project exceeds the {MAX_TOTAL_POINTS} point limit"));
                }
                for point in points {
                    validate_point(point)?;
                }
                validate_stroke(stroke)?;
                id
            }
            BoardObject::Line {
                id,
                start,
                end,
                stroke,
            } => {
                validate_point(start)?;
                validate_point(end)?;
                validate_stroke(stroke)?;
                id
            }
            BoardObject::Rect {
                id,
                x,
                y,
                width,
                height,
                stroke,
            } => {
                validate_finite(*x, "rectangle x")?;
                validate_finite(*y, "rectangle y")?;
                validate_positive(*width, "rectangle width")?;
                validate_positive(*height, "rectangle height")?;
                validate_stroke(stroke)?;
                id
            }
            BoardObject::Text {
                id,
                x,
                y,
                value,
                style,
            } => {
                validate_finite(*x, "text x")?;
                validate_finite(*y, "text y")?;
                if value.trim().is_empty() {
                    return Err("Text objects cannot be empty".to_string());
                }
                total_text_bytes = total_text_bytes
                    .checked_add(value.len())
                    .ok_or_else(|| "Project text size overflowed".to_string())?;
                if total_text_bytes > MAX_TEXT_BYTES {
                    return Err("Project exceeds the 1 MiB text limit".to_string());
                }
                validate_text_style(style)?;
                id
            }
        };
        if id.trim().is_empty() {
            return Err("Object IDs cannot be empty".to_string());
        }
        if !ids.insert(id) {
            return Err(format!("Duplicate object ID: {id}"));
        }
    }
    Ok(())
}

fn validate_board(board: &BoardDimensions) -> Result<(), String> {
    if board.width == 0 || board.height == 0 {
        return Err("Board dimensions must be positive".to_string());
    }
    if board.width > MAX_BOARD_DIMENSION || board.height > MAX_BOARD_DIMENSION {
        return Err(format!(
            "Board dimensions cannot exceed {MAX_BOARD_DIMENSION} pixels"
        ));
    }
    if u64::from(board.width) * u64::from(board.height) > MAX_BOARD_PIXELS {
        return Err("Board pixel area exceeds the export safety limit".to_string());
    }
    Ok(())
}

fn validate_background(background: &ProjectBackground) -> Result<(), String> {
    if background.mime_type != "image/png" {
        return Err("Project backgrounds must use image/png".to_string());
    }
    if background.intrinsic_width == 0 || background.intrinsic_height == 0 {
        return Err("Background dimensions must be positive".to_string());
    }
    validate_rect(&background.placement, "background placement")?;
    let bytes = general_purpose::STANDARD
        .decode(&background.data_base64)
        .map_err(|error| format!("Background base64 decode failed: {error}"))?;
    if bytes.len() > MAX_BACKGROUND_BYTES {
        return Err("Embedded background exceeds the 32 MiB limit".to_string());
    }
    let image = decode_png(&bytes)?;
    if image.width() != background.intrinsic_width || image.height() != background.intrinsic_height {
        return Err("Embedded background dimensions do not match its PNG data".to_string());
    }
    Ok(())
}

fn validate_stroke(stroke: &StrokeStyle) -> Result<(), String> {
    validate_color(&stroke.color)?;
    validate_range(
        stroke.width,
        MIN_STROKE_WIDTH,
        MAX_STROKE_WIDTH,
        "stroke width",
    )
}

fn validate_text_style(style: &TextStyle) -> Result<(), String> {
    validate_color(&style.color)?;
    if style.font != "system-sans" {
        return Err("Unsupported text font token".to_string());
    }
    validate_range(style.font_size, MIN_TEXT_SIZE, MAX_TEXT_SIZE, "text size")?;
    if (style.line_height - 1.2).abs() > f64::EPSILON {
        return Err("Unsupported text line height".to_string());
    }
    Ok(())
}

fn validate_color(color: &str) -> Result<(), String> {
    let valid = color.len() == 7
        && color.starts_with('#')
        && color[1..].bytes().all(|value| value.is_ascii_hexdigit());
    if valid {
        Ok(())
    } else {
        Err(format!("Invalid color value: {color}"))
    }
}

fn validate_point(point: &Point) -> Result<(), String> {
    validate_finite(point.x, "point x")?;
    validate_finite(point.y, "point y")
}

fn validate_rect(rect: &Rect, label: &str) -> Result<(), String> {
    validate_finite(rect.x, &format!("{label} x"))?;
    validate_finite(rect.y, &format!("{label} y"))?;
    validate_positive(rect.width, &format!("{label} width"))?;
    validate_positive(rect.height, &format!("{label} height"))
}

fn validate_positive(value: f64, label: &str) -> Result<(), String> {
    validate_finite(value, label)?;
    if value > 0.0 {
        Ok(())
    } else {
        Err(format!("{label} must be positive"))
    }
}

fn validate_range(value: f64, min: f64, max: f64, label: &str) -> Result<(), String> {
    validate_finite(value, label)?;
    if (min..=max).contains(&value) {
        Ok(())
    } else {
        Err(format!("{label} must be between {min} and {max}"))
    }
}

fn validate_finite(value: f64, label: &str) -> Result<(), String> {
    if value.is_finite() {
        Ok(())
    } else {
        Err(format!("{label} must be finite"))
    }
}

fn checked_path(path: &str, extension: &str, must_exist: bool) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("File path must be absolute".to_string());
    }
    let actual_extension = path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("File must use the .{extension} extension"))?;
    if !actual_extension.eq_ignore_ascii_case(extension) {
        return Err(format!("File must use the .{extension} extension"));
    }
    if must_exist && !path.is_file() {
        return Err("Selected file does not exist or is not a regular file".to_string());
    }
    if !must_exist {
        let parent = path
            .parent()
            .ok_or_else(|| "Destination has no parent directory".to_string())?;
        if !parent.is_dir() {
            return Err("Destination directory does not exist".to_string());
        }
        if path.exists() && !path.is_file() {
            return Err("Destination is not a regular file".to_string());
        }
    }
    Ok(path)
}

fn read_limited(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("File metadata failed: {error}"))?;
    if metadata.len() > max_bytes {
        return Err(format!("File exceeds the {} MiB limit", max_bytes / 1024 / 1024));
    }
    fs::read(path).map_err(|error| format!("File read failed: {error}"))
}

fn decode_png(bytes: &[u8]) -> Result<image::DynamicImage, String> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Selected data is not a PNG file".to_string());
    }
    image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|error| format!("PNG decode failed: {error}"))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Destination has no parent directory".to_string())?;
    let mut temp = NamedTempFile::new_in(parent)
        .map_err(|error| format!("Temporary file creation failed: {error}"))?;
    temp.write_all(bytes)
        .map_err(|error| format!("Temporary file write failed: {error}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|error| format!("Temporary file sync failed: {error}"))?;
    temp.persist(path)
        .map_err(|error| format!("File replacement failed: {}", error.error))?;
    Ok(())
}


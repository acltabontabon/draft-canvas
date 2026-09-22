// Release builds on Windows would otherwise open a console window behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    draft_canvas_lib::run();
}

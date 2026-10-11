//! Wire declarations are checked on every Rust test run; regeneration is explicit.
use ts_rs::TS;

#[test]
fn desktop_wire_types_match_rust() {
    let config = ts_rs::Config::default();
    let declarations = [
        crate::commands::documents::OpenedDoc::decl(&config),
        crate::commands::documents::SavedAs::decl(&config),
        crate::commands::documents::SaveResult::decl(&config),
        crate::commands::projects::ProjectInfo::decl(&config),
        crate::project::ProjectFile::decl(&config),
        crate::project::Scan::decl(&config),
        crate::updater::UpdateInfo::decl(&config),
        crate::updater::Phase::decl(&config),
        crate::updater::Stage::decl(&config),
        crate::updater::Failure::decl(&config),
        crate::updater::Snapshot::decl(&config),
        crate::state::MenuCommand::decl(&config),
        crate::state::HostEvent::decl(&config),
    ];
    let generated = format!(
        "// Generated from Rust by npm run desktop:bindings. Do not edit.\n{}\n",
        declarations
            .iter()
            .map(|s| format!("export {s}")
                .lines()
                .map(str::trim_end)
                .collect::<Vec<_>>()
                .join("\n"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/desktop/wire.ts");
    if std::env::var_os("DRAFT_CANVAS_WRITE_BINDINGS").is_some() {
        std::fs::write(&path, &generated).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        generated,
        "Run npm run desktop:bindings and commit the generated declarations"
    );
}

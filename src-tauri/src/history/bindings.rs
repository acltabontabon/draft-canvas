//! Which history records each working copy (ADR-2): `bindings.json` beside the repositories, a map
//! from copy id to `Binding`, replaced whole and atomically under a lock.

use super::store::History;
use super::{is_oid, is_safe_id, limits, Code, HistoryError, Result};
use crate::docio::write_private;
use crate::errors::Subject;
use crate::util::{lock, now_ms};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::PathBuf;

const FILE: &str = "bindings.json";

/// `Binding` in `contracts.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub copy_id: String,
    pub repo_id: String,
    pub alt_id: Option<String>,
    pub document_id: String,
    pub last_seen: Option<String>,
    pub at: i64,
    /// Recording is paused for this copy: kept per copy, since two copies may continue one history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
}

impl Binding {
    fn check(&self) -> Result<()> {
        check_copy_id(&self.copy_id)?;
        if !is_safe_id(&self.repo_id) {
            return Err(HistoryError::invalid("Not a history id."));
        }
        if self.alt_id.as_deref().is_some_and(|id| !is_safe_id(id)) {
            return Err(HistoryError::invalid("Not an alternative id."));
        }
        if self.last_seen.as_deref().is_some_and(|oid| !is_oid(oid)) {
            return Err(HistoryError::invalid("Not an object id."));
        }
        if self.document_id.len() > 1024 {
            return Err(HistoryError::invalid("Not a document id."));
        }
        Ok(())
    }
}

fn check_copy_id(copy_id: &str) -> Result<()> {
    if copy_id.is_empty() || copy_id.len() > limits::MAX_COPY_ID_BYTES {
        return Err(HistoryError::invalid("Not a working copy id."));
    }
    Ok(())
}

type Registry = BTreeMap<String, Binding>;

impl History {
    fn bindings_path(&self) -> PathBuf {
        self.root().join(FILE)
    }

    /// The registry as stored. A file that can't be read is moved aside (never silently replaced,
    /// so a person can still recover it) and the registry starts empty.
    fn load_bindings(&self) -> Result<Registry> {
        let path = self.bindings_path();
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Registry::new()),
            Err(e) => return Err(HistoryError::io(&e, crate::errors::Verb::Open)),
        };
        let mut bytes = Vec::new();
        file.take(limits::MAX_BINDINGS_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| HistoryError::io(&e, crate::errors::Verb::Open))?;
        let parsed = (bytes.len() <= limits::MAX_BINDINGS_BYTES)
            .then(|| serde_json::from_slice::<Registry>(&bytes).ok())
            .flatten();
        match parsed {
            Some(registry) => Ok(registry),
            None => {
                let aside = self
                    .root()
                    .join(format!("bindings.unreadable-{}.json", now_ms()));
                let _ = fs::rename(&path, aside);
                Ok(Registry::new())
            }
        }
    }

    fn store_bindings(&self, registry: &Registry) -> Result<()> {
        let bytes = serde_json::to_vec(registry).map_err(|_| HistoryError::invalid("Not JSON."))?;
        if bytes.len() > limits::MAX_BINDINGS_BYTES {
            return Err(HistoryError::too_large(
                "There are more bindings than history keeps.",
            ));
        }
        fs::create_dir_all(self.root())
            .map_err(|e| HistoryError::io(&e, crate::errors::Verb::Save))?;
        write_private(&self.bindings_path(), &bytes, Subject::History).map_err(|e| {
            HistoryError::new(
                match e.kind {
                    crate::errors::ErrorKind::DiskFull => Code::Quota,
                    _ => Code::Unavailable,
                },
                e.message,
            )
        })
    }

    pub fn binding_get(&self, copy_id: &str) -> Result<Option<Binding>> {
        check_copy_id(copy_id)?;
        let _guard = lock(&self.bindings_guard);
        Ok(self.load_bindings()?.remove(copy_id))
    }

    pub fn binding_put(&self, binding: &Binding) -> Result<()> {
        binding.check()?;
        let _guard = lock(&self.bindings_guard);
        let mut registry = self.load_bindings()?;
        registry.insert(binding.copy_id.clone(), binding.clone());
        self.store_bindings(&registry)
    }

    pub fn binding_delete(&self, copy_id: &str) -> Result<()> {
        check_copy_id(copy_id)?;
        let _guard = lock(&self.bindings_guard);
        let mut registry = self.load_bindings()?;
        if registry.remove(copy_id).is_some() {
            self.store_bindings(&registry)?;
        }
        Ok(())
    }

    /// Every binding, by copy id.
    pub fn binding_list(&self) -> Result<Vec<Binding>> {
        let _guard = lock(&self.bindings_guard);
        Ok(self.load_bindings()?.into_values().collect())
    }
}

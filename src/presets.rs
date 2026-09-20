use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use anyhow::{Context, bail};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::fs;

use crate::config::{DisplayConfig, MapCenter, MapStyle, TerminatorMode, TimezoneStyle, WsprMode};

const PRESET_SCHEMA_VERSION: u32 = 1;
const MAX_PRESET_NAME_LENGTH: usize = 80;
static NEXT_PRESET_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PresentationConfig {
    pub station_name_visible: bool,
    pub maidenhead_visible: bool,
    pub map_style: MapStyle,
    pub map_center: MapCenter,
    pub stretch_backgrounds: bool,
    pub terminator_mode: TerminatorMode,
    pub night_intensity: f32,
    pub timezone_visible: bool,
    pub timezone_style: TimezoneStyle,
    pub wspr_visible: bool,
    pub wspr_band: String,
    pub wspr_persistence_minutes: u16,
    pub wspr_mode: WsprMode,
    pub history_hours: u8,
    pub playback_duration_seconds: u16,
    pub playback_loop: bool,
}

impl PresentationConfig {
    pub fn from_display(config: &DisplayConfig) -> Self {
        Self {
            station_name_visible: config.station_name_visible,
            maidenhead_visible: config.maidenhead_visible,
            map_style: config.map_style,
            map_center: config.map_center,
            stretch_backgrounds: config.stretch_backgrounds,
            terminator_mode: config.terminator_mode,
            night_intensity: config.night_intensity,
            timezone_visible: config.timezone_visible,
            timezone_style: config.timezone_style,
            wspr_visible: config.wspr_visible,
            wspr_band: config.wspr_band.clone(),
            wspr_persistence_minutes: config.wspr_persistence_minutes,
            wspr_mode: config.wspr_mode,
            history_hours: config.history_hours,
            playback_duration_seconds: config.playback_duration_seconds,
            playback_loop: config.playback_loop,
        }
    }

    pub fn apply_to(&self, config: &mut DisplayConfig) {
        config.station_name_visible = self.station_name_visible;
        config.maidenhead_visible = self.maidenhead_visible;
        config.map_style = self.map_style;
        config.map_center = self.map_center;
        config.stretch_backgrounds = self.stretch_backgrounds;
        config.terminator_mode = self.terminator_mode;
        config.night_intensity = self.night_intensity;
        config.timezone_visible = self.timezone_visible;
        config.timezone_style = self.timezone_style;
        config.wspr_visible = self.wspr_visible;
        config.wspr_band = self.wspr_band.clone();
        config.wspr_persistence_minutes = self.wspr_persistence_minutes;
        config.wspr_mode = self.wspr_mode;
        config.history_hours = self.history_hours;
        config.playback_duration_seconds = self.playback_duration_seconds;
        config.playback_loop = self.playback_loop;
    }
}

pub fn apply_preset_to_display(
    config: &mut DisplayConfig,
    settings: &PresentationConfig,
    playback_started_at: String,
) {
    settings.apply_to(config);
    config.playback_position = 0.0;
    if matches!(config.wspr_mode, WsprMode::Historical) {
        config.playback_running = true;
        config.playback_started_at = Some(playback_started_at);
    } else {
        config.playback_running = false;
        config.playback_started_at = None;
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub settings: PresentationConfig,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PresetFile {
    schema_version: u32,
    presets: Vec<Preset>,
}

pub struct PresetStore {
    path: PathBuf,
    presets: Vec<Preset>,
}

impl PresetStore {
    pub async fn load(path: PathBuf) -> anyhow::Result<Self> {
        let presets = match fs::read(&path).await {
            Ok(bytes) => parse_preset_file(&bytes).context("parse presets")?,
            Err(error) if error.kind() == ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error).context("read presets"),
        };
        Ok(Self { path, presets })
    }

    pub fn list(&self) -> Vec<Preset> {
        self.presets.clone()
    }

    pub fn get(&self, id: &str) -> anyhow::Result<Preset> {
        self.presets
            .iter()
            .find(|preset| preset.id == id)
            .cloned()
            .context("preset not found")
    }

    pub async fn create(
        &mut self,
        name: String,
        settings: PresentationConfig,
    ) -> anyhow::Result<Preset> {
        let preset = Preset {
            id: new_preset_id(),
            name: normalize_name(&name)?,
            settings,
        };
        self.ensure_unique_name(&preset.name, None)?;
        let mut next = self.presets.clone();
        next.push(preset.clone());
        self.persist(&next).await?;
        self.presets = next;
        Ok(preset)
    }

    pub async fn update(
        &mut self,
        id: &str,
        name: Option<String>,
        settings: Option<PresentationConfig>,
    ) -> anyhow::Result<Preset> {
        let index = self
            .presets
            .iter()
            .position(|preset| preset.id == id)
            .context("preset not found")?;
        let mut next = self.presets.clone();
        if let Some(name) = name {
            let name = normalize_name(&name)?;
            self.ensure_unique_name(&name, Some(id))?;
            next[index].name = name;
        }
        if let Some(settings) = settings {
            next[index].settings = settings;
        }
        self.persist(&next).await?;
        self.presets = next;
        Ok(self.presets[index].clone())
    }

    pub async fn delete(&mut self, id: &str) -> anyhow::Result<()> {
        if !self.presets.iter().any(|preset| preset.id == id) {
            bail!("preset not found")
        }
        let next: Vec<Preset> = self
            .presets
            .iter()
            .filter(|preset| preset.id != id)
            .cloned()
            .collect();
        self.persist(&next).await?;
        self.presets = next;
        Ok(())
    }

    fn ensure_unique_name(&self, name: &str, except_id: Option<&str>) -> anyhow::Result<()> {
        if self.presets.iter().any(|preset| {
            Some(preset.id.as_str()) != except_id && preset.name.eq_ignore_ascii_case(name)
        }) {
            bail!("a preset named \"{name}\" already exists")
        }
        Ok(())
    }

    async fn persist(&self, presets: &[Preset]) -> anyhow::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let bytes = serde_json::to_vec_pretty(&PresetFile {
            schema_version: PRESET_SCHEMA_VERSION,
            presets: presets.to_vec(),
        })?;
        let temporary = temporary_path(&self.path);
        fs::write(&temporary, bytes)
            .await
            .context("write temporary presets")?;
        fs::rename(&temporary, &self.path)
            .await
            .context("replace presets")?;
        Ok(())
    }
}

fn normalize_name(name: &str) -> anyhow::Result<String> {
    let name = name.trim();
    if name.is_empty() {
        bail!("preset name cannot be empty")
    }
    if name.chars().count() > MAX_PRESET_NAME_LENGTH {
        bail!("preset name must be at most {MAX_PRESET_NAME_LENGTH} characters")
    }
    Ok(name.to_owned())
}

fn parse_preset_file(bytes: &[u8]) -> anyhow::Result<Vec<Preset>> {
    let file: PresetFile = serde_json::from_slice(bytes)?;
    if file.schema_version != PRESET_SCHEMA_VERSION {
        bail!("unsupported preset schema version")
    }
    let mut names = Vec::new();
    for preset in &file.presets {
        if preset.id.trim().is_empty() {
            bail!("preset ID cannot be empty")
        }
        let name = normalize_name(&preset.name)?;
        if names
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(&name))
        {
            bail!("preset names must be unique")
        }
        let mut config = DisplayConfig::default();
        preset.settings.apply_to(&mut config);
        config.validate().context("invalid preset settings")?;
        names.push(name);
    }
    Ok(file.presets)
}

fn new_preset_id() -> String {
    let sequence = NEXT_PRESET_ID.fetch_add(1, Ordering::Relaxed);
    format!("preset-{}-{sequence}", Utc::now().timestamp_millis())
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".tmp");
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn presentation_extraction_and_application_exclude_installation_and_runtime_state() {
        let mut source = DisplayConfig::default();
        source.receiver_callsign = "N0CALL".into();
        source.shack_locator = "FN31PR".into();
        source.map_style = MapStyle::BlueMarbleLights;
        source.wspr_band = "20m".into();
        source.playback_running = true;
        source.playback_started_at = Some("2026-01-01T00:00:00Z".into());
        source.playback_position = 0.7;
        let settings = PresentationConfig::from_display(&source);
        let mut target = DisplayConfig::default();
        target.receiver_callsign = "K3LR".into();
        target.shack_locator = "EN91SE".into();
        target.playback_running = false;
        target.playback_started_at = None;
        target.playback_position = 0.2;
        settings.apply_to(&mut target);
        assert_eq!(target.receiver_callsign, "K3LR");
        assert_eq!(target.shack_locator, "EN91SE");
        assert!(!target.playback_running);
        assert_eq!(target.playback_position, 0.2);
        assert_eq!(target.map_style, MapStyle::BlueMarbleLights);
        assert_eq!(target.wspr_band, "20m");
    }

    #[test]
    fn applying_a_preset_preserves_installation_and_restarts_historical_playback() {
        let mut saved = DisplayConfig::default();
        saved.wspr_mode = WsprMode::Historical;
        saved.wspr_band = "20m".into();
        saved.playback_running = false;
        saved.playback_started_at = Some("stale".into());
        saved.playback_position = 0.75;
        let settings = PresentationConfig::from_display(&saved);
        let mut target = DisplayConfig::default();
        target.receiver_callsign = "N0CALL".into();
        target.shack_locator = "FN31PR".into();
        target.playback_position = 0.4;
        apply_preset_to_display(&mut target, &settings, "2026-09-20T12:00:00Z".into());
        assert_eq!(target.receiver_callsign, "N0CALL");
        assert_eq!(target.shack_locator, "FN31PR");
        assert_eq!(target.wspr_band, "20m");
        assert!(target.playback_running);
        assert_eq!(
            target.playback_started_at.as_deref(),
            Some("2026-09-20T12:00:00Z")
        );
        assert_eq!(target.playback_position, 0.0);
    }

    #[tokio::test]
    async fn preset_lifecycle_persists_and_preserves_identity() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("presets.json");
        let mut store = PresetStore::load(path.clone()).await.unwrap();
        let mut settings = PresentationConfig::from_display(&DisplayConfig::default());
        settings.wspr_band = "20m".into();
        let created = store
            .create("  20m WSPR  ".into(), settings.clone())
            .await
            .unwrap();
        let renamed = store
            .update(&created.id, Some("Twenty meters".into()), None)
            .await
            .unwrap();
        assert_eq!(renamed.id, created.id);
        assert_eq!(renamed.settings, settings);
        let mut updated_settings = settings.clone();
        updated_settings.wspr_band = "40m".into();
        let updated = store
            .update(&created.id, None, Some(updated_settings.clone()))
            .await
            .unwrap();
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.name, "Twenty meters");
        assert_eq!(updated.settings, updated_settings);
        let reloaded = PresetStore::load(path.clone()).await.unwrap();
        assert_eq!(reloaded.list(), vec![updated]);
        store.delete(&created.id).await.unwrap();
        assert!(PresetStore::load(path).await.unwrap().list().is_empty());
    }

    #[tokio::test]
    async fn validation_rejects_invalid_and_duplicate_names() {
        let directory = tempdir().unwrap();
        let mut store = PresetStore::load(directory.path().join("presets.json"))
            .await
            .unwrap();
        let settings = PresentationConfig::from_display(&DisplayConfig::default());
        assert!(store.create(" ".into(), settings.clone()).await.is_err());
        assert!(
            store
                .create("x".repeat(MAX_PRESET_NAME_LENGTH + 1), settings.clone())
                .await
                .is_err()
        );
        store
            .create("20m WSPR".into(), settings.clone())
            .await
            .unwrap();
        assert!(store.create("20M wspr".into(), settings).await.is_err());
    }

    #[tokio::test]
    async fn persistence_failure_does_not_change_in_memory_presets() {
        let directory = tempdir().unwrap();
        let blocked_parent = directory.path().join("not-a-directory");
        fs::write(&blocked_parent, b"blocked").await.unwrap();
        let mut store = PresetStore {
            path: blocked_parent.join("presets.json"),
            presets: Vec::new(),
        };
        let settings = PresentationConfig::from_display(&DisplayConfig::default());
        assert!(
            store
                .create("Cannot persist".into(), settings)
                .await
                .is_err()
        );
        assert!(store.list().is_empty());
    }
}

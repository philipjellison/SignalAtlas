use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
};

use anyhow::{Context, bail};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use tokio::fs;

pub const CONFIG_SCHEMA_VERSION: u32 = 7;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct DisplayConfig {
    pub schema_version: u32,
    pub receiver_callsign: String,
    pub shack_locator: String,
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
    pub wspr_scope: WsprScope,
    pub wspr_band: String,
    pub wspr_persistence_minutes: u16,
    pub wspr_mode: WsprMode,
    pub history_hours: u8,
    pub playback_duration_seconds: u16,
    pub playback_loop: bool,
    pub playback_running: bool,
    pub playback_started_at: Option<String>,
    pub playback_position: f64,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MapStyle {
    #[default]
    PoliticalRelief,
    NaturalEarth,
    BlueMarble,
    BlueMarbleLights,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MapCenter {
    #[default]
    Greenwich,
    Shack,
    Terminator,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminatorMode {
    Hard,
    #[default]
    CivilTwilight,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TimezoneStyle {
    #[default]
    Idealized,
    Political,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WsprMode {
    #[default]
    Live,
    Historical,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WsprScope {
    #[default]
    Callsign,
    Global,
}

impl Default for DisplayConfig {
    fn default() -> Self {
        Self {
            schema_version: CONFIG_SCHEMA_VERSION,
            receiver_callsign: String::new(),
            shack_locator: String::new(),
            station_name_visible: true,
            maidenhead_visible: true,
            map_style: MapStyle::PoliticalRelief,
            map_center: MapCenter::Greenwich,
            stretch_backgrounds: false,
            terminator_mode: TerminatorMode::CivilTwilight,
            night_intensity: 0.72,
            timezone_visible: true,
            timezone_style: TimezoneStyle::Idealized,
            wspr_visible: false,
            wspr_scope: WsprScope::Callsign,
            wspr_band: "all".into(),
            wspr_persistence_minutes: 60,
            wspr_mode: WsprMode::Live,
            history_hours: 24,
            playback_duration_seconds: 240,
            playback_loop: true,
            playback_running: false,
            playback_started_at: None,
            playback_position: 0.0,
        }
    }
}

impl DisplayConfig {
    pub fn validate(&mut self) -> anyhow::Result<()> {
        self.receiver_callsign = self.receiver_callsign.trim().to_uppercase();
        self.shack_locator = self.shack_locator.trim().to_uppercase();
        self.wspr_band = self.wspr_band.trim().to_lowercase();
        if self.schema_version != CONFIG_SCHEMA_VERSION {
            bail!("unsupported configuration schema version")
        }
        if self.wspr_visible
            && self.wspr_scope == WsprScope::Callsign
            && self.receiver_callsign.is_empty()
        {
            bail!("receiver callsign is required for My Station WSPR")
        }
        if !self.shack_locator.is_empty() && !is_six_character_locator(&self.shack_locator) {
            bail!("shack locator must be a six-character Maidenhead locator")
        }
        if !(0.0..=1.0).contains(&self.night_intensity) {
            bail!("night intensity must be between 0 and 1")
        }
        const BANDS: &[&str] = &["all", "160m", "80m", "40m", "20m", "15m", "10m"];
        if !BANDS.contains(&self.wspr_band.as_str()) {
            bail!("unsupported WSPR band")
        }
        if self.wspr_scope == WsprScope::Global && self.wspr_mode == WsprMode::Historical {
            bail!("global WSPR supports live display only")
        }
        if !(5..=180).contains(&self.wspr_persistence_minutes) {
            bail!("WSPR persistence must be between 5 and 180 minutes")
        }
        if ![6, 12, 24, 48].contains(&self.history_hours) {
            bail!("history window must be 6, 12, 24, or 48 hours")
        }
        if !(30..=3600).contains(&self.playback_duration_seconds) {
            bail!("playback duration must be between 30 and 3600 seconds")
        }
        if !(0.0..=1.0).contains(&self.playback_position) {
            bail!("playback position must be between 0 and 1")
        }
        if let Some(timestamp) = &self.playback_started_at {
            DateTime::parse_from_rfc3339(timestamp).context("invalid playback start timestamp")?;
        }
        Ok(())
    }
}

fn is_six_character_locator(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 6
        && b[0].is_ascii_uppercase()
        && (b[0] <= b'R')
        && b[1].is_ascii_uppercase()
        && (b[1] <= b'R')
        && b[2].is_ascii_digit()
        && b[3].is_ascii_digit()
        && b[4].is_ascii_uppercase()
        && (b[4] <= b'X')
        && b[5].is_ascii_uppercase()
        && (b[5] <= b'X')
}

#[derive(Debug)]
pub struct ConfigStore {
    path: PathBuf,
    config: DisplayConfig,
}

impl ConfigStore {
    pub async fn load(path: PathBuf) -> anyhow::Result<Self> {
        let mut config = match fs::read(&path).await {
            Ok(bytes) => parse_and_migrate(&bytes).context("parse configuration")?,
            Err(error) if error.kind() == ErrorKind::NotFound => DisplayConfig::default(),
            Err(error) => return Err(error).context("read configuration"),
        };
        config.validate()?;
        let store = Self { path, config };
        store.persist_config(&store.config).await?;
        Ok(store)
    }

    pub fn get(&self) -> DisplayConfig {
        self.config.clone()
    }

    pub async fn replace(&mut self, mut config: DisplayConfig) -> anyhow::Result<DisplayConfig> {
        config.validate()?;
        self.persist_config(&config).await?;
        self.config = config;
        Ok(self.config.clone())
    }

    async fn persist_config(&self, config: &DisplayConfig) -> anyhow::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let temporary = temporary_path(&self.path);
        let bytes = serde_json::to_vec_pretty(config)?;
        fs::write(&temporary, bytes)
            .await
            .context("write temporary configuration")?;
        fs::rename(&temporary, &self.path)
            .await
            .context("replace configuration")?;
        Ok(())
    }
}

fn parse_and_migrate(bytes: &[u8]) -> anyhow::Result<DisplayConfig> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes)?;
    if value
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        == Some(1)
    {
        let object = value
            .as_object_mut()
            .context("configuration must be a JSON object")?;
        object.insert("schema_version".into(), 2.into());
        object.insert("timezone_style".into(), "idealized".into());
    }
    if value
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        == Some(2)
    {
        let object = value
            .as_object_mut()
            .context("configuration must be a JSON object")?;
        object.insert("schema_version".into(), 3.into());
        object.insert("wspr_persistence_minutes".into(), 60.into());
    }
    if value
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        == Some(3)
    {
        let object = value
            .as_object_mut()
            .context("configuration must be a JSON object")?;
        object.insert("schema_version".into(), 4.into());
        object.insert("wspr_mode".into(), "live".into());
        object.insert("history_hours".into(), 24.into());
        object.insert("playback_duration_seconds".into(), 240.into());
        object.insert("playback_loop".into(), true.into());
        object.insert("playback_running".into(), false.into());
        object.insert("playback_started_at".into(), serde_json::Value::Null);
        object.insert("playback_position".into(), 0.0.into());
    }
    if value
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        == Some(4)
    {
        let object = value
            .as_object_mut()
            .context("configuration must be a JSON object")?;
        object.insert("schema_version".into(), 5.into());
        object.insert("stretch_backgrounds".into(), false.into());
    }
    if value
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        == Some(5)
    {
        let object = value
            .as_object_mut()
            .context("configuration must be a JSON object")?;
        object.insert("schema_version".into(), CONFIG_SCHEMA_VERSION.into());
        object.insert("station_name_visible".into(), true.into());
        object.insert("maidenhead_visible".into(), true.into());
    }
    if value
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        == Some(6)
    {
        let object = value
            .as_object_mut()
            .context("configuration must be a JSON object")?;
        object.insert("schema_version".into(), CONFIG_SCHEMA_VERSION.into());
        object.insert("wspr_scope".into(), "callsign".into());
    }
    Ok(serde_json::from_value(value)?)
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".tmp");
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid_with_no_station_identity() {
        let mut config = DisplayConfig::default();
        config.validate().unwrap();
        assert!(config.receiver_callsign.is_empty());
        assert!(config.shack_locator.is_empty());
        assert_eq!(config.wspr_scope, WsprScope::Callsign);
    }

    #[test]
    fn validation_normalizes_user_input() {
        let mut config = DisplayConfig {
            receiver_callsign: " k3lr ".into(),
            shack_locator: " en91se ".into(),
            ..Default::default()
        };
        config.validate().unwrap();
        assert_eq!(config.receiver_callsign, "K3LR");
        assert_eq!(config.shack_locator, "EN91SE");
    }

    #[test]
    fn validation_rejects_invalid_locator_and_intensity() {
        let mut config = DisplayConfig {
            shack_locator: "NOTHERE".into(),
            ..Default::default()
        };
        assert!(config.validate().is_err());
        let mut config = DisplayConfig {
            wspr_visible: true,
            ..Default::default()
        };
        assert!(config.validate().is_err());
        let mut config = DisplayConfig {
            night_intensity: 1.1,
            ..Default::default()
        };
        assert!(config.validate().is_err());
    }

    #[tokio::test]
    async fn store_persists_replaced_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let mut store = ConfigStore::load(path.clone()).await.unwrap();
        let mut config = store.get();
        config.map_style = MapStyle::BlueMarbleLights;
        store.replace(config).await.unwrap();
        let reloaded = ConfigStore::load(path).await.unwrap();
        assert_eq!(reloaded.get().map_style, MapStyle::BlueMarbleLights);
    }

    #[tokio::test]
    async fn replace_persistence_failure_keeps_in_memory_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let blocked_parent = directory.path().join("not-a-directory");
        fs::write(&blocked_parent, b"blocked").await.unwrap();
        let original = DisplayConfig::default();
        let mut store = ConfigStore {
            path: blocked_parent.join("config.json"),
            config: original.clone(),
        };
        let mut candidate = original.clone();
        candidate.map_style = MapStyle::BlueMarbleLights;
        assert!(store.replace(candidate).await.is_err());
        assert_eq!(store.get(), original);
    }

    #[test]
    fn migrates_stage_zero_configuration() {
        let old = br#"{
            "schema_version": 1,
            "receiver_callsign": "K3LR",
            "shack_locator": "EN91SE",
            "map_style": "political_relief",
            "map_center": "greenwich",
            "terminator_mode": "civil_twilight",
            "night_intensity": 0.72,
            "timezone_visible": true,
            "wspr_visible": false,
            "wspr_band": "all"
        }"#;
        let migrated = parse_and_migrate(old).unwrap();
        assert_eq!(migrated.schema_version, CONFIG_SCHEMA_VERSION);
        assert_eq!(migrated.timezone_style, TimezoneStyle::Idealized);
        assert_eq!(migrated.wspr_persistence_minutes, 60);
        assert!(!migrated.stretch_backgrounds);
    }

    #[test]
    fn migrates_previous_layout_configuration() {
        let mut previous = serde_json::to_value(DisplayConfig::default()).unwrap();
        let object = previous.as_object_mut().unwrap();
        object.insert("schema_version".into(), 4.into());
        object.remove("stretch_backgrounds");
        let migrated = parse_and_migrate(&serde_json::to_vec(&previous).unwrap()).unwrap();
        assert_eq!(migrated.schema_version, CONFIG_SCHEMA_VERSION);
        assert!(!migrated.stretch_backgrounds);
        assert!(migrated.station_name_visible);
        assert!(migrated.maidenhead_visible);
    }

    #[test]
    fn migrates_previous_station_label_configuration() {
        let mut previous = serde_json::to_value(DisplayConfig::default()).unwrap();
        let object = previous.as_object_mut().unwrap();
        object.insert("schema_version".into(), 5.into());
        object.remove("station_name_visible");
        object.remove("maidenhead_visible");
        let migrated = parse_and_migrate(&serde_json::to_vec(&previous).unwrap()).unwrap();
        assert_eq!(migrated.schema_version, CONFIG_SCHEMA_VERSION);
        assert!(migrated.station_name_visible);
        assert!(migrated.maidenhead_visible);
        assert_eq!(migrated.wspr_scope, WsprScope::Callsign);
    }

    #[test]
    fn migrates_configuration_without_wspr_scope() {
        let mut previous = serde_json::to_value(DisplayConfig::default()).unwrap();
        let object = previous.as_object_mut().unwrap();
        object.insert("schema_version".into(), 6.into());
        object.remove("wspr_scope");
        let migrated = parse_and_migrate(&serde_json::to_vec(&previous).unwrap()).unwrap();
        assert_eq!(migrated.schema_version, CONFIG_SCHEMA_VERSION);
        assert_eq!(migrated.wspr_scope, WsprScope::Callsign);
    }

    #[test]
    fn rejects_global_historical_playback() {
        let mut config = DisplayConfig {
            wspr_scope: WsprScope::Global,
            wspr_mode: WsprMode::Historical,
            ..Default::default()
        };
        assert!(config.validate().is_err());
    }
}

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::bail;
use async_trait::async_trait;
use chrono::{NaiveDateTime, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::{
    fs,
    sync::{Notify, RwLock},
    time::MissedTickBehavior,
};

use crate::config::ConfigStore;
use crate::config::DisplayConfig;
use crate::config::{WsprMode, WsprScope};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WsprSpot {
    pub latest_time: String,
    pub band: i16,
    pub transmitter: String,
    pub locator: String,
    pub latitude: f32,
    pub longitude: f32,
    pub snr: i8,
    pub receptions: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct WsprSnapshot {
    pub receiver: String,
    pub scope: WsprScope,
    pub fetched_at: Option<String>,
    pub stale: bool,
    pub error: Option<String>,
    pub window_minutes: u16,
    pub spots: Vec<WsprSpot>,
}

impl WsprSnapshot {
    pub async fn load(path: &Path) -> Self {
        match fs::read(path).await {
            Ok(bytes) => {
                let mut snapshot: Self = serde_json::from_slice(&bytes).unwrap_or_default();
                snapshot.stale = true;
                snapshot
            }
            Err(_) => Self::default(),
        }
    }

    async fn persist(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let mut temporary = path.as_os_str().to_owned();
        temporary.push(".tmp");
        fs::write(&temporary, serde_json::to_vec(self)?).await?;
        fs::rename(PathBuf::from(temporary), path).await?;
        Ok(())
    }

    pub fn pending(receiver: String, scope: WsprScope) -> Self {
        Self {
            receiver,
            scope,
            stale: true,
            ..Self::default()
        }
    }
}

#[async_trait]
pub trait WsprSource: Send + Sync {
    async fn fetch(
        &self,
        scope: WsprScope,
        receiver: &str,
        minutes: u16,
    ) -> anyhow::Result<Vec<WsprSpot>>;
}

pub struct WsprLiveSource {
    client: Client,
    endpoint: String,
}

impl WsprLiveSource {
    pub fn new(endpoint: String) -> anyhow::Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("signalatlas/0.1")
            .build()?;
        Ok(Self { client, endpoint })
    }
}

#[derive(Deserialize)]
struct ClickHouseResponse {
    data: Vec<WsprSpot>,
}

#[async_trait]
impl WsprSource for WsprLiveSource {
    async fn fetch(
        &self,
        scope: WsprScope,
        receiver: &str,
        minutes: u16,
    ) -> anyhow::Result<Vec<WsprSpot>> {
        let query = query_for(scope, receiver, minutes)?;
        let response = self
            .client
            .get(&self.endpoint)
            .query(&[("query", query)])
            .send()
            .await?
            .error_for_status()?
            .json::<ClickHouseResponse>()
            .await?;
        let mut spots = response.data;
        spots.retain(valid_spot);
        Ok(spots)
    }
}

fn query_for(scope: WsprScope, receiver: &str, minutes: u16) -> anyhow::Result<String> {
    let receiver_filter = match scope {
        WsprScope::Callsign => {
            if receiver.is_empty()
                || receiver.len() > 16
                || !receiver
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '/')
            {
                bail!("invalid receiver callsign")
            }
            format!("rx_sign = '{receiver}' AND ")
        }
        WsprScope::Global => String::new(),
    };
    Ok(format!(
        "SELECT toStartOfInterval(time, INTERVAL 2 MINUTE) AS latest_time, band, argMax(tx_sign, time) AS transmitter, \
         tx_loc AS locator, argMax(tx_lat, time) AS latitude, argMax(tx_lon, time) AS longitude, \
         argMax(snr, time) AS snr, count() AS receptions FROM wspr.rx \
         WHERE {receiver_filter}time > subtractMinutes(now(), {minutes}) \
         AND tx_loc != '' AND tx_lat BETWEEN -90 AND 90 AND tx_lon BETWEEN -180 AND 180 \
         GROUP BY latest_time, band, tx_loc ORDER BY latest_time DESC LIMIT 100000 FORMAT JSON"
    ))
}

fn valid_spot(spot: &WsprSpot) -> bool {
    !spot.locator.is_empty()
        && spot.latitude.is_finite()
        && (-90.0..=90.0).contains(&spot.latitude)
        && spot.longitude.is_finite()
        && (-180.0..=180.0).contains(&spot.longitude)
        && NaiveDateTime::parse_from_str(&spot.latest_time, "%Y-%m-%d %H:%M:%S").is_ok()
}

pub async fn run_poller(
    source: Arc<dyn WsprSource>,
    snapshot: Arc<RwLock<WsprSnapshot>>,
    config: Arc<tokio::sync::Mutex<ConfigStore>>,
    cache_path: PathBuf,
    notify: Arc<Notify>,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(120));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = interval.tick() => {}
            _ = notify.notified() => {}
        }
        let current_config = config.lock().await.get();
        if !current_config.wspr_visible {
            continue;
        }
        let receiver = current_config.receiver_callsign.clone();
        let scope = current_config.wspr_scope;
        let minutes = requested_window(&current_config);
        {
            let current_snapshot = snapshot.read().await;
            if !should_refresh(&current_config, &current_snapshot) {
                continue;
            }
        }
        match source.fetch(scope, &receiver, minutes).await {
            Ok(spots) => {
                let latest_config = config.lock().await.get();
                if !request_matches_config(scope, &receiver, minutes, &latest_config) {
                    continue;
                }
                let next = WsprSnapshot {
                    receiver,
                    scope,
                    fetched_at: Some(Utc::now().to_rfc3339()),
                    stale: false,
                    error: None,
                    window_minutes: minutes,
                    spots,
                };
                if let Err(error) = next.persist(&cache_path).await {
                    tracing::warn!(%error, "unable to persist WSPR cache");
                }
                *snapshot.write().await = next;
            }
            Err(error) => {
                tracing::warn!(%error, "WSPR refresh failed; retaining last good data");
                let mut current = snapshot.write().await;
                current.stale = true;
                current.error = Some(error.to_string());
            }
        }
    }
}

fn requested_window(config: &DisplayConfig) -> u16 {
    match config.wspr_mode {
        WsprMode::Live => 180,
        WsprMode::Historical => u16::from(config.history_hours) * 60,
    }
}

fn should_refresh(config: &DisplayConfig, snapshot: &WsprSnapshot) -> bool {
    config.wspr_mode == WsprMode::Live
        || snapshot.stale
        || snapshot.scope != config.wspr_scope
        || (config.wspr_scope == WsprScope::Callsign
            && snapshot.receiver != config.receiver_callsign)
        || snapshot.window_minutes != requested_window(config)
        || snapshot.spots.is_empty()
}

fn request_matches_config(
    scope: WsprScope,
    receiver: &str,
    minutes: u16,
    config: &DisplayConfig,
) -> bool {
    scope == config.wspr_scope
        && minutes == requested_window(config)
        && (scope == WsprScope::Global || receiver == config.receiver_callsign)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_spot_coordinates_and_timestamp() {
        let spot = WsprSpot {
            latest_time: "2026-08-24 19:34:00".into(),
            band: 14,
            transmitter: "W1AW".into(),
            locator: "FN31".into(),
            latitude: 41.5,
            longitude: -72.7,
            snr: -12,
            receptions: 3,
        };
        assert!(valid_spot(&spot));
        assert!(!valid_spot(&WsprSpot {
            latitude: 100.0,
            ..spot
        }));
    }

    #[test]
    fn historical_cache_is_reused_but_live_data_refreshes() {
        let config = DisplayConfig {
            wspr_mode: WsprMode::Historical,
            history_hours: 24,
            ..Default::default()
        };
        let snapshot = WsprSnapshot {
            receiver: config.receiver_callsign.clone(),
            scope: WsprScope::Callsign,
            window_minutes: 1440,
            spots: vec![WsprSpot {
                latest_time: "2026-08-24 19:34:00".into(),
                band: 14,
                transmitter: "W1AW".into(),
                locator: "FN31".into(),
                latitude: 41.5,
                longitude: -72.7,
                snr: -12,
                receptions: 3,
            }],
            ..Default::default()
        };
        assert!(!should_refresh(&config, &snapshot));
        assert!(should_refresh(
            &DisplayConfig {
                wspr_mode: WsprMode::Live,
                ..config
            },
            &snapshot
        ));
    }

    #[test]
    fn scope_changes_invalidate_cached_results() {
        let config = DisplayConfig::default();
        let snapshot = WsprSnapshot {
            receiver: config.receiver_callsign.clone(),
            scope: WsprScope::Global,
            window_minutes: requested_window(&config),
            spots: vec![WsprSpot {
                latest_time: "2026-08-24 19:34:00".into(),
                band: 14,
                transmitter: "W1AW".into(),
                locator: "FN31".into(),
                latitude: 41.5,
                longitude: -72.7,
                snr: -12,
                receptions: 3,
            }],
            ..Default::default()
        };
        assert!(should_refresh(&config, &snapshot));
    }

    #[test]
    fn query_scope_controls_receiver_filter() {
        let station = query_for(WsprScope::Callsign, "K3LR", 180).unwrap();
        assert!(station.contains("rx_sign = 'K3LR'"));
        let global = query_for(WsprScope::Global, "K3LR", 180).unwrap();
        assert!(!global.contains("rx_sign"));
        assert!(global.contains("time > subtractMinutes(now(), 180)"));
    }

    #[test]
    fn pending_snapshot_has_no_spots_from_the_previous_scope() {
        let snapshot = WsprSnapshot::pending("K3LR".into(), WsprScope::Global);
        assert_eq!(snapshot.scope, WsprScope::Global);
        assert!(snapshot.stale);
        assert!(snapshot.spots.is_empty());
    }

    #[test]
    fn changed_scope_discards_an_in_flight_request() {
        let config = DisplayConfig {
            wspr_scope: WsprScope::Global,
            ..Default::default()
        };
        assert!(!request_matches_config(
            WsprScope::Callsign,
            "K3LR",
            180,
            &config
        ));
    }

    #[test]
    fn snapshot_keeps_the_frontend_spot_shape() {
        let snapshot = WsprSnapshot {
            spots: vec![WsprSpot {
                latest_time: "2026-08-24 19:34:00".into(),
                band: 14,
                transmitter: "W1AW".into(),
                locator: "FN31".into(),
                latitude: 41.5,
                longitude: -72.7,
                snr: -12,
                receptions: 3,
            }],
            ..Default::default()
        };
        let value = serde_json::to_value(snapshot).unwrap();
        let spot = &value["spots"][0];
        for field in [
            "latest_time",
            "band",
            "transmitter",
            "locator",
            "latitude",
            "longitude",
            "snr",
            "receptions",
        ] {
            assert!(spot.get(field).is_some(), "missing {field}");
        }
    }
}

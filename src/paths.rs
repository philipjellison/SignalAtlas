//! Resolution of the web asset directory and the writable data files.
//!
//! Read-only resources (the `web` directory) and writable state (configuration,
//! presets, WSPR cache) are resolved independently, and neither depends on the
//! process working directory unless that is the only remaining option.

use std::{
    env,
    path::{Path, PathBuf},
};

use anyhow::bail;

/// File whose presence identifies a usable web asset directory.
const WEB_MARKER: &str = "display.html";

/// Everything path resolution reads from its surroundings, so it can be tested.
#[derive(Debug, Default, Clone)]
pub struct Inputs {
    pub web: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
    pub config: Option<PathBuf>,
    pub presets: Option<PathBuf>,
    pub wspr_cache: Option<PathBuf>,
    pub exe: Option<PathBuf>,
    pub cwd: PathBuf,
    pub xdg_data_home: Option<PathBuf>,
    pub home: Option<PathBuf>,
}

impl Inputs {
    pub fn from_environment() -> Self {
        let var = |name: &str| {
            env::var_os(name)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };
        Self {
            web: var("SIGNALATLAS_WEB"),
            data_dir: var("SIGNALATLAS_DATA_DIR"),
            config: var("SIGNALATLAS_CONFIG"),
            presets: var("SIGNALATLAS_PRESETS"),
            wspr_cache: var("SIGNALATLAS_WSPR_CACHE"),
            exe: env::current_exe()
                .ok()
                .map(|p| std::fs::canonicalize(&p).unwrap_or(p)),
            cwd: env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            xdg_data_home: var("XDG_DATA_HOME"),
            home: var("HOME"),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Resolved {
    pub web_root: PathBuf,
    pub config: PathBuf,
    pub presets: PathBuf,
    pub wspr_cache: PathBuf,
    /// Human-readable note about how the data location was chosen.
    pub data_source: &'static str,
}

pub fn resolve(inputs: &Inputs) -> anyhow::Result<Resolved> {
    let web_root = resolve_web(inputs)?;
    let (base, data_source) = resolve_base(inputs)?;
    let config = inputs
        .config
        .clone()
        .unwrap_or_else(|| base.join("config.json"));
    let presets = inputs
        .presets
        .clone()
        .unwrap_or_else(|| parent_of(&config).join("presets.json"));
    let wspr_cache = inputs
        .wspr_cache
        .clone()
        .unwrap_or_else(|| base.join("wspr-cache.json"));
    Ok(Resolved {
        web_root,
        config,
        presets,
        wspr_cache,
        data_source,
    })
}

fn parent_of(path: &Path) -> PathBuf {
    match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    }
}

fn is_web_root(path: &Path) -> bool {
    path.join(WEB_MARKER).is_file()
}

/// Directory above the build output (`target/<profile>/signalatlas`) when the
/// executable is running from a source checkout.
fn source_tree(inputs: &Inputs) -> Option<PathBuf> {
    let root = inputs.exe.as_deref()?.parent()?.parent()?.parent()?;
    (root.join("Cargo.toml").is_file() && is_web_root(&root.join("web")))
        .then(|| root.to_path_buf())
}

fn resolve_web(inputs: &Inputs) -> anyhow::Result<PathBuf> {
    if let Some(explicit) = &inputs.web {
        if is_web_root(explicit) {
            return Ok(explicit.clone());
        }
        bail!(
            "SIGNALATLAS_WEB={} does not contain {WEB_MARKER}",
            explicit.display()
        );
    }
    let mut candidates = Vec::new();
    if let Some(exe_dir) = inputs.exe.as_deref().and_then(Path::parent) {
        // Installed layout: <prefix>/bin/signalatlas with <prefix>/web.
        candidates.push(exe_dir.join("..").join("web"));
        // Source checkout: <repo>/target/<profile>/signalatlas with <repo>/web.
        candidates.push(exe_dir.join("../../web"));
    }
    // Legacy behaviour: a `web` directory in the working directory.
    candidates.push(inputs.cwd.join("web"));
    for candidate in &candidates {
        if is_web_root(candidate) {
            return Ok(std::fs::canonicalize(candidate).unwrap_or_else(|_| candidate.clone()));
        }
    }
    let tried: Vec<String> = candidates.iter().map(|c| c.display().to_string()).collect();
    bail!(
        "could not find the web assets (a directory containing {WEB_MARKER}); tried: {}. \
         Set SIGNALATLAS_WEB to the web directory.",
        tried.join(", ")
    )
}

fn resolve_base(inputs: &Inputs) -> anyhow::Result<(PathBuf, &'static str)> {
    if let Some(dir) = &inputs.data_dir {
        return Ok((dir.clone(), "SIGNALATLAS_DATA_DIR"));
    }
    if let Some(config) = &inputs.config {
        return Ok((parent_of(config), "directory of SIGNALATLAS_CONFIG"));
    }
    if let Some(root) = source_tree(inputs) {
        return Ok((root.join("data"), "source checkout data directory"));
    }
    // Existing data left in a ./data directory by earlier versions keeps being used.
    let legacy = inputs.cwd.join("data");
    if ["config.json", "presets.json", "wspr-cache.json"]
        .iter()
        .any(|name| legacy.join(name).is_file())
    {
        return Ok((legacy, "existing ./data directory in the working directory"));
    }
    if let Some(xdg) = &inputs.xdg_data_home {
        return Ok((xdg.join("signalatlas"), "XDG_DATA_HOME"));
    }
    if let Some(home) = &inputs.home {
        return Ok((
            home.join(".local/share/signalatlas"),
            "~/.local/share/signalatlas",
        ));
    }
    bail!("cannot choose a data directory: set SIGNALATLAS_DATA_DIR or SIGNALATLAS_CONFIG")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make_web(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(WEB_MARKER), "x").unwrap();
    }

    fn base_inputs(cwd: &Path) -> Inputs {
        Inputs {
            cwd: cwd.to_path_buf(),
            home: Some(cwd.join("home")),
            ..Inputs::default()
        }
    }

    #[test]
    fn installed_layout_finds_web_next_to_bin_and_uses_home_data() {
        let t = tempfile::tempdir().unwrap();
        let prefix = t.path().join("opt/signalatlas");
        make_web(&prefix.join("web"));
        fs::create_dir_all(prefix.join("bin")).unwrap();
        let other = t.path().join("elsewhere");
        fs::create_dir_all(&other).unwrap();
        let mut i = base_inputs(&other);
        i.exe = Some(prefix.join("bin/signalatlas"));
        let r = resolve(&i).unwrap();
        assert!(r.web_root.ends_with("web") && r.web_root.join(WEB_MARKER).is_file());
        assert_eq!(
            r.config,
            other.join("home/.local/share/signalatlas/config.json")
        );
        assert_eq!(
            r.presets,
            other.join("home/.local/share/signalatlas/presets.json")
        );
        assert_eq!(
            r.wspr_cache,
            other.join("home/.local/share/signalatlas/wspr-cache.json")
        );
    }

    #[test]
    fn source_checkout_uses_repo_web_and_data_from_any_cwd() {
        let t = tempfile::tempdir().unwrap();
        let repo = t.path().join("repo");
        make_web(&repo.join("web"));
        fs::write(repo.join("Cargo.toml"), "").unwrap();
        fs::create_dir_all(repo.join("target/release")).unwrap();
        let other = t.path().join("elsewhere");
        fs::create_dir_all(&other).unwrap();
        let mut i = base_inputs(&other);
        i.exe = Some(repo.join("target/release/signalatlas"));
        let r = resolve(&i).unwrap();
        assert!(r.web_root.join(WEB_MARKER).is_file());
        assert_eq!(r.config, repo.join("data/config.json"));
    }

    #[test]
    fn xdg_data_home_is_preferred_over_home() {
        let t = tempfile::tempdir().unwrap();
        let mut i = base_inputs(t.path());
        i.xdg_data_home = Some(t.path().join("xdg"));
        let (base, _) = resolve_base(&i).unwrap();
        assert_eq!(base, t.path().join("xdg/signalatlas"));
    }

    #[test]
    fn legacy_cwd_data_is_kept_when_present() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir_all(t.path().join("data")).unwrap();
        fs::write(t.path().join("data/config.json"), "{}").unwrap();
        let (base, _) = resolve_base(&base_inputs(t.path())).unwrap();
        assert_eq!(base, t.path().join("data"));
    }

    #[test]
    fn legacy_cwd_web_still_works() {
        let t = tempfile::tempdir().unwrap();
        make_web(&t.path().join("web"));
        assert!(resolve_web(&base_inputs(t.path())).is_ok());
    }

    #[test]
    fn explicit_overrides_win_and_presets_follow_config() {
        let t = tempfile::tempdir().unwrap();
        make_web(&t.path().join("w"));
        let mut i = base_inputs(t.path());
        i.web = Some(t.path().join("w"));
        i.config = Some(PathBuf::from("/srv/sa/config.json"));
        let r = resolve(&i).unwrap();
        assert_eq!(r.web_root, t.path().join("w"));
        assert_eq!(r.config, PathBuf::from("/srv/sa/config.json"));
        assert_eq!(r.presets, PathBuf::from("/srv/sa/presets.json"));
        assert_eq!(r.wspr_cache, PathBuf::from("/srv/sa/wspr-cache.json"));
        i.presets = Some("/p/x.json".into());
        i.wspr_cache = Some("/c/y.json".into());
        i.data_dir = Some("/data".into());
        let r = resolve(&i).unwrap();
        assert_eq!(r.presets, PathBuf::from("/p/x.json"));
        assert_eq!(r.wspr_cache, PathBuf::from("/c/y.json"));
    }

    #[test]
    fn data_dir_sets_all_defaults() {
        let t = tempfile::tempdir().unwrap();
        make_web(&t.path().join("web"));
        let mut i = base_inputs(t.path());
        i.data_dir = Some("/var/lib/signalatlas".into());
        let r = resolve(&i).unwrap();
        assert_eq!(r.config, PathBuf::from("/var/lib/signalatlas/config.json"));
        assert_eq!(
            r.presets,
            PathBuf::from("/var/lib/signalatlas/presets.json")
        );
        assert_eq!(
            r.wspr_cache,
            PathBuf::from("/var/lib/signalatlas/wspr-cache.json")
        );
    }

    #[test]
    fn missing_or_invalid_web_is_reported() {
        let t = tempfile::tempdir().unwrap();
        let e = resolve_web(&base_inputs(t.path())).unwrap_err().to_string();
        assert!(e.contains("SIGNALATLAS_WEB"));
        let mut i = base_inputs(t.path());
        i.web = Some(t.path().join("nope"));
        assert!(resolve_web(&i).is_err());
    }

    #[test]
    fn no_home_and_no_hints_is_an_error() {
        let t = tempfile::tempdir().unwrap();
        let i = Inputs {
            cwd: t.path().to_path_buf(),
            ..Inputs::default()
        };
        assert!(resolve_base(&i).is_err());
    }
}

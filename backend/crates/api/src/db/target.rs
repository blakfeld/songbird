//! Parsing is separate from connecting so every URL rule is testable without a server.

use std::path::PathBuf;

use secrecy::{ExposeSecret, SecretString};

use super::DbError;

pub const DEFAULT_URL: &str = "sqlite://data/songbird.db?mode=rwc";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Sqlite,
    Postgres,
}

#[derive(Debug)]
pub struct Target {
    pub backend: Backend,
    pub url: SecretString,
    /// Held so the connect step can create the directory before SQLite opens the file.
    pub sqlite_path: Option<PathBuf>,
    /// Safe to log: no credentials and no query parameters.
    pub redacted: String,
}

impl Target {
    pub fn parse(url: Option<&SecretString>) -> Result<Self, DbError> {
        let raw = url.map_or("", |u| u.expose_secret().trim());
        let raw = if raw.is_empty() { DEFAULT_URL } else { raw };
        let scheme = raw
            .split_once(':')
            .map(|(scheme, _)| scheme.to_ascii_lowercase())
            .unwrap_or_default();

        match scheme.as_str() {
            "sqlite" => Self::parse_sqlite(raw),
            "postgres" | "postgresql" => Self::parse_postgres(raw),
            _ => Err(DbError::UnsupportedScheme {
                // Only the scheme is echoed because the rest of the URL may hold a password.
                scheme: if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric()) {
                    "(none)".into()
                } else {
                    scheme
                },
            }),
        }
    }

    fn parse_sqlite(raw: &str) -> Result<Self, DbError> {
        let rest = raw["sqlite:".len()..].trim_start_matches("//");
        let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
        let in_memory = path.is_empty()
            || path.contains(":memory:")
            || query
                .split('&')
                .any(|p| p.eq_ignore_ascii_case("mode=memory"));
        if in_memory {
            return Err(DbError::InMemorySqlite);
        }
        // sqlx-sqlite decodes the path, so the directory must be created from the decoded one.
        let decoded = percent_encoding::percent_decode_str(path).decode_utf8_lossy();
        Ok(Self {
            backend: Backend::Sqlite,
            url: SecretString::from(raw.to_string()),
            sqlite_path: Some(PathBuf::from(decoded.as_ref())),
            redacted: format!("sqlite:{path}"),
        })
    }

    fn parse_postgres(raw: &str) -> Result<Self, DbError> {
        let parsed = url::Url::parse(raw).map_err(|_| DbError::InvalidUrl)?;
        let host = parsed.host_str().unwrap_or("localhost");
        let port = parsed.port().map(|p| format!(":{p}")).unwrap_or_default();
        Ok(Self {
            backend: Backend::Postgres,
            url: SecretString::from(raw.to_string()),
            sqlite_path: None,
            redacted: format!(
                "{}://{host}{port}/{}",
                parsed.scheme(),
                parsed.path().trim_start_matches('/')
            ),
        })
    }

    /// Driver errors can quote the connection URL or its password, and these
    /// messages end up in logs.
    pub fn scrub(&self, message: &str) -> String {
        let mut out = message.replace(self.url.expose_secret(), &self.redacted);
        if let Some(password) = self.password() {
            out = out.replace(&password, "***");
        }
        out
    }

    fn password(&self) -> Option<String> {
        let parsed = url::Url::parse(self.url.expose_secret()).ok()?;
        let encoded = parsed.password().filter(|p| !p.is_empty())?;
        let decoded = percent_encoding::percent_decode_str(encoded)
            .decode_utf8_lossy()
            .into_owned();
        Some(decoded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(url: &str) -> Result<Target, DbError> {
        Target::parse(Some(&SecretString::from(url.to_string())))
    }

    #[test]
    fn unset_and_blank_use_the_default_sqlite_file() {
        for url in [None, Some(SecretString::from("  ".to_string()))] {
            let t = Target::parse(url.as_ref()).unwrap();
            assert_eq!(t.backend, Backend::Sqlite);
            assert_eq!(t.sqlite_path, Some(PathBuf::from("data/songbird.db")));
            assert_eq!(t.url.expose_secret(), DEFAULT_URL);
        }
    }

    #[test]
    fn sqlite_forms_resolve_their_path() {
        for (url, path) in [
            ("sqlite://data/a.db?mode=rwc", "data/a.db"),
            ("sqlite:a.db", "a.db"),
            ("sqlite:///var/lib/a.db", "/var/lib/a.db"),
            ("SQLITE://a.db", "a.db"),
            ("sqlite:///srv/my%20app/x.db?mode=rwc", "/srv/my app/x.db"),
        ] {
            let t = parse(url).unwrap();
            assert_eq!(t.backend, Backend::Sqlite, "{url}");
            assert_eq!(t.sqlite_path, Some(PathBuf::from(path)), "{url}");
        }
    }

    #[test]
    fn in_memory_sqlite_is_rejected() {
        for url in [
            "sqlite::memory:",
            "sqlite://:memory:",
            "sqlite://x.db?mode=memory",
            "sqlite:",
        ] {
            assert!(matches!(parse(url), Err(DbError::InMemorySqlite)), "{url}");
        }
    }

    #[test]
    fn postgres_schemes_are_accepted_and_redacted() {
        for url in [
            "postgres://songbird:s3cret@db:5432/songbird",
            "postgresql://songbird:s3cret@db:5432/songbird",
        ] {
            let t = parse(url).unwrap();
            assert_eq!(t.backend, Backend::Postgres);
            assert!(
                t.redacted.ends_with("://db:5432/songbird"),
                "{}",
                t.redacted
            );
            assert!(!t.redacted.contains("s3cret"));
            assert!(!t.redacted.contains("songbird:"));
        }
    }

    #[test]
    fn postgres_tls_options_are_kept_for_the_driver() {
        let t = parse("postgres://u:p@db/songbird?sslmode=verify-full&sslrootcert=/etc/ca.pem")
            .unwrap();
        assert!(t.url.expose_secret().contains("sslmode=verify-full"));
        assert!(t.url.expose_secret().contains("sslrootcert=/etc/ca.pem"));
        assert!(!t.redacted.contains("ssl"));
    }

    #[test]
    fn unknown_schemes_name_the_variable_and_the_supported_ones() {
        for url in ["mysql://localhost/songbird", "localhost", "http://x"] {
            let err = parse(url).unwrap_err().to_string();
            assert!(err.contains("SONGBIRD_DATABASE_URL"), "{err}");
            assert!(err.contains("sqlite") && err.contains("postgres"), "{err}");
        }
    }

    #[test]
    fn scrub_removes_the_password_and_full_url() {
        let t = parse("postgres://songbird:s%33cret@db/songbird").unwrap();
        let out = t.scrub("failed for postgres://songbird:s%33cret@db/songbird: bad s3cret");
        assert!(
            !out.contains("s3cret") && !out.contains("s%33cret"),
            "{out}"
        );
    }
}

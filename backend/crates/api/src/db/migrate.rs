use sqlx::migrate::Migrator;

use super::Backend;

/// Two directories because DDL differs per backend; a test keeps their versions in step.
pub static SQLITE: Migrator = sqlx::migrate!("migrations/sqlite");
pub static POSTGRES: Migrator = sqlx::migrate!("migrations/postgres");

pub fn migrator(backend: Backend) -> &'static Migrator {
    match backend {
        Backend::Sqlite => &SQLITE,
        Backend::Postgres => &POSTGRES,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn versions(m: &Migrator) -> Vec<(i64, String)> {
        m.iter()
            .map(|m| (m.version, m.description.to_string()))
            .collect()
    }

    #[test]
    fn both_backends_have_the_same_versions_and_descriptions() {
        assert!(!SQLITE.migrations.is_empty());
        assert_eq!(versions(&SQLITE), versions(&POSTGRES));
    }
}

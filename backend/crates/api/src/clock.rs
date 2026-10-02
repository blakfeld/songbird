use std::time::{SystemTime, UNIX_EPOCH};

/// Times are stored as Unix milliseconds from Rust, never from SQL, so both
/// backends see identical values.
pub fn now_ms() -> i64 {
    let since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is after the Unix epoch");
    i64::try_from(since_epoch.as_millis()).expect("millisecond timestamp fits in i64")
}

/// Operators read this in `user list`; a fixed UTC format avoids pulling in a
/// date crate for one column.
pub fn format_utc(unix_ms: i64) -> String {
    let secs = unix_ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let time_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        time_of_day / 3600,
        time_of_day % 3600 / 60,
        time_of_day % 60
    )
}

/// Howard Hinnant's days-to-civil algorithm, valid for the whole proleptic Gregorian calendar.
fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_instants() {
        assert_eq!(format_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_utc(1_709_164_799_000), "2024-02-28T23:59:59Z");
        assert_eq!(format_utc(1_709_164_800_000), "2024-02-29T00:00:00Z");
        assert_eq!(format_utc(-1000), "1969-12-31T23:59:59Z");
    }
}

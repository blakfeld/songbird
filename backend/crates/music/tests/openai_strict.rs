//! OpenAI rejects a non-compliant schema at request time, which would surface as every
//! generation failing for users on that provider; this makes a new instrument fail CI instead.

use music::ai::plan::{plan_schema, PLAN_TOOL_NAME};
use music::ai::prompt::{draft_schema, TOOL_NAME};
use music::InstrumentRegistry;
use serde_json::Value;

const FORBIDDEN_KEYWORDS: [&str; 8] = [
    "default", "oneOf", "allOf", "not", "if", "then", "else", "format",
];
const MAX_NESTING: usize = 10;
const MAX_PROPERTIES: usize = 5000;
const MAX_ENUM_VALUES: usize = 1000;

#[derive(Default)]
struct Totals {
    properties: usize,
    enum_values: usize,
}

fn is_object_schema(map: &serde_json::Map<String, Value>) -> bool {
    map.get("type").is_some_and(|t| t == "object") || map.contains_key("properties")
}

/// Property and definition names are user data, not keywords, so only their values are walked
/// as schemas.
fn walk(node: &Value, root: &Value, depth: usize, totals: &mut Totals, label: &str) {
    let Value::Object(map) = node else { return };
    for keyword in FORBIDDEN_KEYWORDS {
        assert!(
            !map.contains_key(keyword),
            "{label}: `{keyword}` is not allowed"
        );
    }
    let depth = if is_object_schema(map) {
        assert!(
            depth < MAX_NESTING,
            "{label}: nested deeper than {MAX_NESTING} levels"
        );
        assert_eq!(
            map.get("additionalProperties"),
            Some(&Value::Bool(false)),
            "{label}: object without additionalProperties:false"
        );
        let properties = map.get("properties").and_then(Value::as_object);
        let mut names: Vec<&str> = properties
            .map(|p| p.keys().map(String::as_str).collect())
            .unwrap_or_default();
        let mut required: Vec<&str> = map
            .get("required")
            .and_then(Value::as_array)
            .map(|r| r.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        names.sort_unstable();
        required.sort_unstable();
        assert_eq!(names, required, "{label}: every property must be required");
        totals.properties += names.len();
        depth + 1
    } else {
        depth
    };
    if let Some(values) = map.get("enum").and_then(Value::as_array) {
        totals.enum_values += values.len();
    }
    // Following refs counts the referenced object toward nesting, as OpenAI does.
    if let Some(target) = map
        .get("$ref")
        .and_then(Value::as_str)
        .and_then(|r| r.strip_prefix("#/$defs/"))
    {
        walk(&root["$defs"][target], root, depth, totals, label);
    }
    for (key, child) in map {
        match key.as_str() {
            "$defs" | "$ref" => {}
            "properties" => {
                for property in child.as_object().into_iter().flat_map(|p| p.values()) {
                    walk(property, root, depth, totals, label);
                }
            }
            _ => match child {
                Value::Object(_) => walk(child, root, depth, totals, label),
                Value::Array(items) => items
                    .iter()
                    .for_each(|item| walk(item, root, depth, totals, label)),
                _ => {}
            },
        }
    }
}

fn assert_strict_compliant(schema: &Value, label: &str) {
    assert_eq!(schema["type"], "object", "{label}: root must be an object");
    let mut totals = Totals::default();
    walk(schema, schema, 0, &mut totals, label);
    for (name, definition) in schema["$defs"].as_object().into_iter().flatten() {
        walk(
            definition,
            schema,
            0,
            &mut Totals::default(),
            &format!("{label} {name}"),
        );
    }
    assert!(
        totals.properties <= MAX_PROPERTIES,
        "{label}: too many properties"
    );
    assert!(
        totals.enum_values <= MAX_ENUM_VALUES,
        "{label}: too many enum values"
    );
}

#[test]
fn every_instrument_draft_schema_is_strict_compliant() {
    for instrument in InstrumentRegistry::builtin().all() {
        assert_strict_compliant(&draft_schema(instrument), instrument.id);
    }
}

#[test]
fn the_plan_schema_is_strict_compliant() {
    let registry = InstrumentRegistry::builtin();
    assert_strict_compliant(&plan_schema(registry.all()), "plan");
}

#[test]
fn tool_names_are_valid_json_schema_names() {
    for name in [TOOL_NAME, PLAN_TOOL_NAME] {
        assert!((1..=64).contains(&name.len()), "{name}");
        assert!(
            name.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'),
            "{name}"
        );
    }
}

/// Without these the compliance checker could be vacuous and still pass every real schema.
mod checker_catches_violations {
    use super::*;
    use serde_json::json;

    fn compliant() -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["a"],
            "properties": {"a": {"type": "string"}}
        })
    }

    #[test]
    fn the_baseline_schema_passes() {
        assert_strict_compliant(&compliant(), "baseline");
    }

    #[test]
    #[should_panic(expected = "additionalProperties")]
    fn an_open_object_fails() {
        let mut schema = compliant();
        schema["additionalProperties"] = json!(true);
        assert_strict_compliant(&schema, "open");
    }

    #[test]
    #[should_panic(expected = "every property must be required")]
    fn an_optional_property_fails() {
        let mut schema = compliant();
        schema["properties"]["b"] = json!({"type": "string"});
        assert_strict_compliant(&schema, "optional");
    }

    #[test]
    #[should_panic(expected = "`oneOf` is not allowed")]
    fn a_forbidden_keyword_fails() {
        let mut schema = compliant();
        schema["properties"]["a"] = json!({"oneOf": [{"type": "string"}]});
        assert_strict_compliant(&schema, "keyword");
    }

    #[test]
    #[should_panic(expected = "`default` is not allowed")]
    fn a_default_in_a_definition_fails() {
        let mut schema = compliant();
        schema["$defs"] = json!({"d": {"type": "string", "default": "x"}});
        assert_strict_compliant(&schema, "default");
    }

    #[test]
    #[should_panic(expected = "root must be an object")]
    fn a_non_object_root_fails() {
        assert_strict_compliant(&json!({"type": "array"}), "root");
    }

    #[test]
    #[should_panic(expected = "nested deeper")]
    fn excessive_nesting_fails() {
        let mut schema = json!({"type": "string"});
        for _ in 0..=MAX_NESTING {
            schema = json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["n"],
                "properties": {"n": schema}
            });
        }
        assert_strict_compliant(&schema, "deep");
    }

    #[test]
    #[should_panic(expected = "too many enum values")]
    fn too_many_enum_values_fails() {
        let mut schema = compliant();
        let values: Vec<usize> = (0..=MAX_ENUM_VALUES).collect();
        schema["properties"]["a"] = json!({"enum": values});
        assert_strict_compliant(&schema, "enum");
    }
}

#[test]
fn the_lyrics_schema_is_strict_compliant() {
    let ids = ["verse-1".to_string(), "chorus-1".to_string()];
    assert_strict_compliant(&music::ai::lyrics::lyrics_schema(&ids), "lyrics");
}

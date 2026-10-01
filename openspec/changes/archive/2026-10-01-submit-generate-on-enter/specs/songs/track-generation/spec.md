## ADDED Requirements

### Requirement: Keyboard submission of the generate form
In the Studio's generate form, pressing Enter in the prompt field SHALL submit the form, exactly as activating the Generate button does. Enter SHALL do nothing when the Generate button is disabled, for example when the prompt is empty or over the token limit, the generation limits haven't loaded, or the custom range is invalid. Pressing Shift+Enter SHALL insert a line break. Enter that confirms an input-method composition SHALL NOT submit. Pressing Enter in the measure fields SHALL also submit the form. The prompt field SHALL show a hint that Enter generates and Shift+Enter adds a new line, and the hint SHALL be associated with the field for assistive technology.

#### Scenario: Enter generates
- **WHEN** the user opens Generate on the Bass track, types "walking bass", and presses Enter
- **THEN** the dialog closes and generation starts for the Bass track with the prompt "walking bass"

#### Scenario: Shift+Enter adds a line
- **WHEN** the user types "walking bass", presses Shift+Enter, and types "with fills"
- **THEN** the prompt contains both lines and nothing has been generated

#### Scenario: Enter on an empty prompt
- **WHEN** the prompt is empty and the user presses Enter
- **THEN** the dialog stays open and nothing is generated

#### Scenario: Enter with an invalid range
- **WHEN** a custom range from measure 5 to measure 2 is entered and the user presses Enter in the prompt
- **THEN** the dialog stays open, the range error is shown, and nothing is generated

#### Scenario: IME composition
- **WHEN** the user presses Enter to confirm a Japanese input composition in the prompt
- **THEN** the composed text is inserted and the form is not submitted

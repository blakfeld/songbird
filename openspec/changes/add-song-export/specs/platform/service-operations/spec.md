# Spec Delta

## MODIFIED Requirements

### Requirement: Request size limit
The service SHALL reject request bodies larger than 64 KiB with status `413`, except for routes under `/api/v1/songs/` and `/api/v1/lyrics/`, which SHALL accept bodies up to 1 MiB and reject larger bodies with status `413`. Every `413` response SHALL use the standard error shape with error code `payload_too_large`.

#### Scenario: Oversized body
- **WHEN** a client posts a 1 MiB body to `/api/v1/patterns/generate`
- **THEN** the response is `413`

#### Scenario: Large song accepted
- **WHEN** a client posts a 600 KiB valid song to `/api/v1/songs/export/midi`
- **THEN** the request is not rejected for size

#### Scenario: Oversized song rejected
- **WHEN** a client posts a 2 MiB body to `/api/v1/songs/export/midi`
- **THEN** the response is `413` with error code `payload_too_large`

# Spec Delta

## MODIFIED Requirements

### Requirement: Login throttling
Login attempts SHALL be limited over a sliding 15-minute window:
- **Per email and address:** after 5 failed logins for the same email from the same client address, further attempts for that email from that address SHALL be refused with `429` and code `too_many_requests`, even when the password is correct.
- **Per address:** after 20 failed logins from the same client address, for any emails, further attempts from that address SHALL be refused the same way.
- **Per email, from all addresses:** after 50 failed logins for the same email, further attempts for that email SHALL be answered only after a delay that grows with each further failure, up to 30 seconds, and SHALL NOT be refused for this reason, so that guessing from many addresses is slowed without locking the real user out.

Every `429` response SHALL include a `Retry-After` header. An attempt SHALL count toward these limits from the moment it starts, so that parallel attempts cannot all pass before any has failed. A successful login SHALL clear the failure count for its email and address. Throttling SHALL apply the same way whether or not the email has an account.

The client address SHALL be taken from the source chosen by `SONGBIRD_TRUST_PROXY` (see `platform/service-operations`): the connection's peer address by default, the first address in `X-Forwarded-For`, or the `Fly-Client-IP` header. The `X-Forwarded-For` source SHALL only be enabled when the outermost proxy replaces any client-supplied `X-Forwarded-For`, and the `Fly-Client-IP` source SHALL only be enabled when the service is reachable solely through Fly.io's proxy. The operator documentation SHALL state both conditions. When the chosen header is missing or does not hold a valid IP address, the connection's peer address SHALL be used instead. IPv6 addresses SHALL be grouped by their /64 prefix.

#### Scenario: Too many failures
- **WHEN** a client fails to log in 5 times for `ana@example.com` from one address within 15 minutes and then posts the correct password from that address
- **THEN** the response is `429` with code `too_many_requests` and a `Retry-After` header

#### Scenario: Another address is not blocked
- **WHEN** 5 logins for `ana@example.com` have failed from address X within 15 minutes, fewer than 50 have failed for that email in total, and Ana posts the correct password from address Y
- **THEN** the response is `200` and Ana is signed in

#### Scenario: Many addresses are slowed, not refused
- **WHEN** 60 logins for `ana@example.com` have failed from 60 different addresses within 15 minutes, and Ana posts the correct password from a new address
- **THEN** the response is delayed, and is then `200` rather than `429`

#### Scenario: Parallel attempts are counted
- **WHEN** a client sends 10 logins for `ana@example.com` with wrong passwords at the same moment from one address
- **THEN** at most 5 of them are checked against the password, and each of the rest gets `429` or `503`

#### Scenario: IPv6 neighbours share a limit
- **WHEN** 20 logins fail from addresses spread across one IPv6 /64, and another login arrives from a different address in that /64
- **THEN** the response is `429` with code `too_many_requests`

#### Scenario: Spoofed forwarding header ignored
- **WHEN** the service does not trust its proxy, and a client that has failed 20 times sends a login with `X-Forwarded-For: 203.0.113.9`
- **THEN** the response is `429`, because the client is still identified by its connection address

#### Scenario: Fly client address used
- **WHEN** the service trusts `fly-client-ip`, and a client that has failed 20 times from `198.51.100.7` sends a login with `Fly-Client-IP: 198.51.100.7` and `X-Forwarded-For: 203.0.113.9`
- **THEN** the response is `429`, because the client is identified by `Fly-Client-IP`

#### Scenario: Missing Fly header falls back to the peer
- **WHEN** the service trusts `fly-client-ip` and a login arrives with no `Fly-Client-IP` header
- **THEN** the attempt is counted against the connection's peer address

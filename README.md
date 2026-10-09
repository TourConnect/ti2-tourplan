# Ti2's tourplan plugin

## Getting Started

### Requirements

Live integration tests use `ti2_tourplan_endpoint`, `ti2_tourplan_username`,
and `ti2_tourplan_password`; the test suite supplies fixture defaults when
they are absent. Plugin credentials use the `endpoint`, `username`, and
`password` token fields. The optional `DTD_DAYS` plugin setting controls how
many days DTD version detection results are cached per endpoint (default: 7).

## Itinerary product catalog fields

Product search passes Ti2's itinerary product type definitions and query to
`translateTPOption`. The query now returns the existing `city`, `country`, and
`currency` values alongside these HostConnect fields:

| Ti2 field | HostConnect source |
| --- | --- |
| `city` | Enriched destination, then `OptGeneral.LocalityDescription` or `Address3` |
| `country` | Enriched destination country |
| `currency` | Agent currency, then `OptRates.Currency` |
| `description` | SupplierInfo notes or description, excluding the supplier name |
| `optionClass` | `OptGeneral.ClassDescription`, then `OptGeneral.Class` |
| `chargeUnit` | `OptGeneral.SCU`, lowercased |
| Room `maxPaxWithInfants` | `OptGeneral.<room>_Max_With_Infants` |
| `Other` room restriction | `OptGeneral.Other_*` fields, when present |

For accommodation and package options, an `Other` unit is included only when
the source has an `Other_*` value. If those fields are absent, the `Other`
restriction is omitted. Optional source values omitted by the plugin appear as
`null` in Ti2's shared query. Adult, Child, and Infant restrictions still
select only `allowed`, `minAge`, and `maxAge`.

## Contributing

Contributions are welcome and ecouraged.

If you have a suggestion that would make this better, please fork the repo and create a pull request. You can also simply open an issue with the tag "enhancement". Don't forget to give the project a star! Thanks again!

- Fork the Project
- Create your Feature Branch (git checkout -b feature/AmazingFeature)
- Commit your Changes (git commit -m 'Add some AmazingFeature')
- Push to the Branch (git push origin feature/AmazingFeature)
- Open a Pull Request

Feel free to check the [Issues Page](https://github.com/TourConnect/ti2-tourplan/issues).

## License

Distributed under the GPL-3 License. See LICENSE.txt for more information.

TL;DR Here's what the license entails:

1. Anyone can copy, modify and distribute this software.
2. You have to include the license and copyright notice with each and every distribution.
3. You can use this software privately.
4. You can use this software for commercial purposes.
5. If you dare build your business solely from this code, you risk open-sourcing the whole code base.
6. If you modify it, you have to indicate changes made to the code.
7. Any modifications of this code base MUST be distributed with the same license, GPLv3.
8. This software is provided without warranty.
9. The software author or license can not be held liable for any damages inflicted by the software.

## Cancel Booking (HostConnect)

This plugin cancels bookings using `CancelServicesRequest` (not `CancelBookingRequest`).

### HostConnect XML Request

```xml
<Request>
  <CancelServicesRequest>
    <AgentID>YOUR_AGENT_ID</AgentID>
    <Password>YOUR_AGENT_PASSWORD</Password>
    <BookingId>14226</BookingId>
    <ReturnBooking>Y</ReturnBooking>
  </CancelServicesRequest>
</Request>
```

Equivalent curl:

```bash
curl --location 'https://<HOSTCONNECT_ENDPOINT>/api/hostConnectApi' \
--header 'Content-Type: application/xml; charset=utf-8' \
--header 'requestId: <uuid>' \
--header 'Accept: application/xml' \
--data '<Request>
  <CancelServicesRequest>
    <AgentID>YOUR_AGENT_ID</AgentID>
    <Password>YOUR_AGENT_PASSWORD</Password>
    <BookingId>14226</BookingId>
    <ReturnBooking>Y</ReturnBooking>
  </CancelServicesRequest>
</Request>'
```

### HostConnect XML Response (example)

```xml
<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE Reply SYSTEM "hostConnect_5_05_010.dtd">
<Reply>
  <CancelServicesReply>
    <BookingId>14226</BookingId>
    <Ref>A2IN111975</Ref>
    <ServiceStatuses>
      <ServiceStatus>
        <ServiceLineId>61738</ServiceLineId>
        <Date>2026-07-03</Date>
        <SequenceNumber>10</SequenceNumber>
        <Status>XX</Status>
      </ServiceStatus>
    </ServiceStatuses>
  </CancelServicesReply>
</Reply>
```

### Plugin Return Shape

The plugin returns both:

- `cancelServicesReply`: raw parsed `CancelServicesReply` object
- `cancellation`: normalized object
  - `id`: from `BookingId`
  - `status`: aggregate over all `ServiceStatus.Status` values:
    - same status on all lines => that status (e.g. `XX`)
    - mixed line statuses => `MIXED`

## Confirm Booking (HostConnect)

This plugin converts a quote to a confirmed booking using HostConnect `QuoteToBookRequest`. Inventory is allocated for each service line when the quote is confirmed; the returned `ServiceStatus` values indicate whether allocation succeeded per line.

### HostConnect XML Request

```xml
<Request>
  <QuoteToBookRequest>
    <AgentID>YOUR_AGENT_ID</AgentID>
    <Password>YOUR_AGENT_PASSWORD</Password>
    <BookingId>14226</BookingId>
  </QuoteToBookRequest>
</Request>
```

Equivalent curl:

```bash
curl --location 'https://<HOSTCONNECT_ENDPOINT>/api/hostConnectApi' \
--header 'Content-Type: application/xml; charset=utf-8' \
--header 'requestId: <uuid>' \
--header 'Accept: application/xml' \
--data '<Request>
  <QuoteToBookRequest>
    <AgentID>YOUR_AGENT_ID</AgentID>
    <Password>YOUR_AGENT_PASSWORD</Password>
    <BookingId>14226</BookingId>
  </QuoteToBookRequest>
</Request>'
```

### HostConnect XML Response (example)

```xml
<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE Reply SYSTEM "hostConnect_5_05_010.dtd">
<Reply>
  <QuoteToBookReply>
    <BookingId>14226</BookingId>
    <Ref>A2IN111975</Ref>
    <ServiceStatuses>
      <ServiceStatus>
        <Ref>A2IN111975</Ref>
        <ServiceLineId>61738</ServiceLineId>
        <Date>2026-07-03</Date>
        <SequenceNumber>10</SequenceNumber>
        <Status>OK</Status>
      </ServiceStatus>
    </ServiceStatuses>
  </QuoteToBookReply>
</Reply>
```

### Plugin Return Shape

The plugin returns both:

- `confirmBookingReply`: raw parsed HostConnect `QuoteToBookReply` object
- `booking`: normalized object
  - `ref`: from `Ref`
  - `id`: from `BookingId` (or the identifier sent in the request)
  - `status`: aggregate over all `ServiceStatus.Status` values (same rules as cancel), with fallbacks to `BookingStatus`, `Status`, `payload.status`, then `'Confirmed'`
  - `serviceLines`: array of `{ ref, serviceLineId, date, sequenceNumber, status }`
